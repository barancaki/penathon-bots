import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore } from '../src/main/projects';
import { SettingsStore, type SecretStorage } from '../src/main/settings';
import { BotStore, chiefBot, parseBot } from '../src/main/bots/store';
import { botDraftSchema, botPatchSchema } from '../src/shared/bots';
import { settingsPatchSchema } from '../src/shared/settings';
import {
  effectiveAccess,
  allowClaudeTool,
  assertCeiling,
  withoutKnowledge,
} from '../src/main/engines/scopes';
import { instructions, projectInstructions } from '../src/main/engines/common';
import { removeTemporary, temporaryDirectory, testBot } from './helpers';

let dir: string;
let work: string;
let settings: SettingsStore;
let bots: BotStore;
let projects: ProjectStore;
const storage: SecretStorage = {
  isAsyncEncryptionAvailable: async () => false,
  encryptStringAsync: async () => {
    throw new Error('unused');
  },
  decryptStringAsync: async () => {
    throw new Error('unused');
  },
};
beforeEach(async () => {
  dir = await temporaryDirectory();
  work = join(dir, 'work');
  await mkdir(work);
  settings = new SettingsStore(join(dir, 'settings'), storage);
  await settings.init();
  bots = new BotStore(
    join(dir, 'bots'),
    chiefBot(work, 'en'),
    () => settings.get().knowledgeDir,
    () => [],
    () => settings.get().projects,
  );
  await bots.init();
  projects = new ProjectStore(settings, () => bots);
});
afterEach(async () => {
  await bots.close();
  await removeTemporary(dir);
});
const draft = { name: 'Worker', engine: 'claude' as const, instructions: 'Help' };
it('saves canonical unique folders with collision-safe Turkish slugs, replaces by id and reloads settings', async () => {
  const alias = join(dir, 'alias');
  await symlink(work, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const changed = vi.fn();
  projects.on('changed', changed);
  const [first, second] = await Promise.all([
    projects.save({ name: 'İçerik İşleri', folders: [work, alias, join(work, '..', 'work')] }),
    projects.save({ name: 'İçerik İşleri', folders: [work] }),
  ]);
  expect([first.id, second.id]).toEqual(['icerik-isleri', 'icerik-isleri-2']);
  expect(first.folders).toEqual([await realpath(work)]);
  const updated = await projects.save({ ...first, name: 'Renamed', description: 'A group' });
  expect(updated.id).toBe(first.id);
  expect(projects.list()).toHaveLength(2);
  expect(changed).toHaveBeenCalledTimes(3);
  const reloaded = new SettingsStore(join(dir, 'settings'), storage);
  await reloaded.init();
  expect(reloaded.get().projects).toEqual(projects.list());
  const copy = projects.list();
  copy[0].folders.push('unexpected');
  expect(projects.list()[0].folders).not.toContain('unexpected');
});
it('rejects non-directories, relative/missing folders, unknown ids and generic settings mutations', async () => {
  const file = join(work, 'file');
  await writeFile(file, 'text');
  for (const folder of [file, 'relative', join(work, 'missing')])
    await expect(projects.save({ name: 'Invalid', folders: [folder] })).rejects.toThrow();
  await expect(projects.save({ id: 'missing', name: 'Invalid', folders: [work] })).rejects.toThrow(
    'errors.projectMissing',
  );
  expect(settingsPatchSchema.safeParse({ projects: [] }).success).toBe(false);
  expect(botDraftSchema.parse(draft)).not.toHaveProperty('projects');
  expect(botPatchSchema.parse({ projects: [] })).toEqual({ projects: [] });
});
it('rejects equal, ancestor, descendant and symlink vault overlap on project save and knowledge changes', async () => {
  const vault = join(dir, 'vault');
  const nested = join(vault, 'nested');
  const alias = join(dir, 'vault-alias');
  await mkdir(nested, { recursive: true });
  await symlink(vault, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await settings.set({ knowledgeDir: vault });
  for (const folder of [dir, vault, nested, alias])
    await expect(projects.save({ name: 'Unsafe', folders: [folder] })).rejects.toThrow(
      'errors.projectKnowledge',
    );
  const project = await projects.save({ name: 'Safe', folders: [work] });
  for (const knowledgeDir of [work, join(work, 'nested'), dir])
    await expect(settings.set({ knowledgeDir })).rejects.toThrow('errors.projectKnowledge');
  expect(settings.get().knowledgeDir).toBe(vault);
  expect(projects.list()).toEqual([project]);
});
it('removes every grant from disk, including hierarchy grants and Chief exceptions, before deleting a project', async () => {
  const project = await projects.save({ name: 'Acme', folders: [work] });
  await bots.update('chief', { projects: [{ project: project.id, level: 'full' }] });
  const parent = await bots.create({
    ...draft,
    projects: [{ project: project.id, level: 'write' }],
  });
  const child = await bots.create(
    { ...draft, name: 'Child', projects: [{ project: project.id, level: 'read' }] },
    parent.id,
  );
  const changed = vi.fn();
  projects.on('changed', changed);
  await projects.delete(project.id);
  expect(projects.list()).toEqual([]);
  for (const id of ['chief', parent.id, child.id]) {
    expect(bots.get(id).projects).toEqual([]);
    expect(parseBot(await readFile(join(bots.dir, id + '.md'), 'utf8')).projects).toEqual([]);
  }
  expect(changed).toHaveBeenCalledOnce();
  await expect(projects.delete(project.id)).rejects.toThrow('errors.projectMissing');
});
it('combines legacy and project permissions without promoting Full grants to an unrestricted sandbox', async () => {
  const reader = await projects.save({ name: 'Reader', folders: [join(dir, 'settings')] });
  const writer = await projects.save({ name: 'Writer', folders: [work] });
  const full = await projects.save({ name: 'Full', folders: [bots.dir] });
  const bot = testBot(work, {
    sandbox: 'read-only',
    projects: [
      { project: reader.id, level: 'read' },
      { project: writer.id, level: 'write' },
    ],
  });
  expect(effectiveAccess(bot, projects.list())).toMatchObject({
    sandbox: 'workspace-write',
    writeRoots: [await realpath(work)],
    fullRoots: [],
    deleteApprovalRoots: [await realpath(work)],
  });
  expect(
    effectiveAccess({ ...bot, projects: [{ project: reader.id, level: 'read' }] }, projects.list())
      .sandbox,
  ).toBe('read-only');
  const access = effectiveAccess(
    { ...bot, projects: [...bot.projects, { project: full.id, level: 'full' }] },
    projects.list(),
  );
  expect(access.sandbox).toBe('workspace-write');
  expect(access.fullRoots).toEqual([await realpath(bots.dir)]);
  expect(access.readRoots).toContain(await realpath(join(dir, 'settings')));
  expect(effectiveAccess({ ...bot, sandbox: 'danger-full-access', projects: [] }).sandbox).toBe(
    'danger-full-access',
  );
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(
      effectiveAccess(
        { ...bot, projects: [{ project: 'unknown', level: 'full' }] },
        projects.list(),
      ).sandbox,
    ).toBe('read-only');
    expect(warning).toHaveBeenCalledWith('Unknown project grant:', 'unknown');
  } finally {
    warning.mockRestore();
  }
});
it('enforces project paths for native tools and MCP including symlinks and rejects vault grants at run time', async () => {
  const other = join(dir, 'other');
  const vault = join(dir, 'vault');
  await mkdir(other);
  await mkdir(vault);
  const project = await projects.save({ name: 'Read', folders: [other] });
  const bot = testBot(work, {
    connections: ['filesystem'],
    projects: [{ project: project.id, level: 'read' }],
  });
  const access = effectiveAccess(bot, projects.list());
  expect(
    await allowClaudeTool(
      bot,
      'Read',
      { file_path: join(other, 'x') },
      undefined,
      undefined,
      access,
    ),
  ).toBe(true);
  for (const name of ['Write', 'Edit'])
    expect(
      await allowClaudeTool(
        bot,
        name,
        { file_path: join(other, 'x') },
        undefined,
        undefined,
        access,
      ),
    ).toBe(false);
  expect(
    await allowClaudeTool(
      bot,
      'Bash',
      { command: 'rm "' + join(other, 'x') + '"' },
      undefined,
      undefined,
      access,
    ),
  ).toBe(false);
  expect(
    await allowClaudeTool(
      bot,
      'mcp__filesystem__read_file',
      { path: join(other, 'x') },
      undefined,
      undefined,
      access,
    ),
  ).toBe(true);
  expect(
    await allowClaudeTool(
      bot,
      'mcp__filesystem__write_file',
      { path: join(other, 'x') },
      undefined,
      undefined,
      access,
    ),
  ).toBe(false);
  await expect(withoutKnowledge(bot, vault, [{ ...project, folders: [vault] }])).rejects.toThrow(
    'errors.knowledgeScope',
  );
});
it('enforces project grant ceilings even for Chief bot proposals and user updates reject unknown projects', async () => {
  const project = await projects.save({ name: 'Project', folders: [work] });
  const read = [{ project: project.id, level: 'read' as const }];
  await expect(bots.draft({ ...draft, projects: read })).rejects.toThrow('errors.projectCeiling');
  await bots.update('chief', { projects: [{ project: project.id, level: 'write' }] });
  const parent = await bots.create({ ...draft, projects: read });
  await expect(
    bots.create({ ...draft, projects: [{ project: project.id, level: 'write' }] }, parent.id),
  ).rejects.toThrow('errors.projectCeiling');
  const child = await bots.create({ ...draft, name: 'Child', projects: read }, parent.id);
  await expect(
    bots.update(child.id, { projects: [{ project: 'missing', level: 'read' }] }),
  ).rejects.toThrow();
  await expect(
    bots.previewUpdate(parent.id, { projects: [{ project: project.id, level: 'full' }] }, 'chief'),
  ).rejects.toThrow('errors.projectCeiling');
  await expect(
    assertCeiling({ ...child, projects: read }, { ...parent, projects: [] }, projects.list()),
  ).rejects.toThrow('errors.projectCeiling');
});
it('persists Chief grant exceptions across restart while ordinary bot changes still respect ceilings', async () => {
  const project = await projects.save({ name: 'Project', folders: [work] });
  const parent = await bots.create(draft);
  const child = await bots.create({ ...draft, name: 'Child' }, parent.id);
  await bots.grantProject('chief', child.id, project.id, 'full');
  await bots.update(child.id, { name: 'Renamed' });
  await bots.close();
  bots = new BotStore(
    bots.dir,
    chiefBot(work, 'en'),
    () => undefined,
    () => [],
    () => projects.list(),
  );
  await bots.init();
  await bots.update(child.id, { role: 'Builder' });
  expect(bots.get(child.id).projects).toEqual([{ project: project.id, level: 'full' }]);
  await bots.grantProject('chief', child.id, project.id, 'read');
  await expect(
    bots.update(child.id, { projects: [{ project: project.id, level: 'full' }] }),
  ).rejects.toThrow('errors.projectCeiling');
  await bots.grantProject('chief', child.id, project.id, null);
  expect(bots.get(child.id).projects).toEqual([]);
});
it('loads both project rule files, masks secrets before truncation and puts Chief vault rules first', async () => {
  const vault = join(dir, 'vault');
  await mkdir(vault);
  const project = await projects.save({ name: 'Project', folders: [work, join(dir, 'settings')] });
  const bot = testBot(work, { projects: [{ project: project.id, level: 'read' }] });
  await writeFile(
    join(work, 'AGENTS.md'),
    'PROJECT_RULE ' + 'A'.repeat(11980) + 'known-secret-value',
  );
  await writeFile(join(work, 'CLAUDE.md'), 'B'.repeat(15000));
  await writeFile(join(dir, 'settings', 'AGENTS.md'), 'C'.repeat(100));
  await writeFile(join(vault, 'AGENTS.md'), 'VAULT_FIRST');
  await writeFile(join(vault, 'CLAUDE.md'), 'VAULT_SECOND');
  const rules = await projectInstructions(bot, projects.list(), vault, ['known-secret-value']);
  expect(rules).toContain('AGENTS.md');
  expect(rules).toContain('CLAUDE.md');
  expect(rules).toContain('kırpıldı');
  expect(rules).not.toContain('known-secret');
  expect(rules).not.toContain('VAULT_FIRST');
  expect((rules.match(/A/g) ?? []).length).toBeLessThan(12010);
  expect(rules).toContain('B'.repeat(12000));
  expect(rules).not.toContain('B'.repeat(12001));
  expect(rules).not.toContain('C'.repeat(100));
  const chief = { ...bot, id: 'chief', system: true };
  const chiefRules = await projectInstructions(chief, projects.list(), vault);
  const text = instructions(chief, vault, '', undefined, [], projects.list(), chiefRules);
  expect(text.indexOf('VAULT_FIRST')).toBeLessThan(text.indexOf('VAULT_SECOND'));
  expect(text.indexOf('VAULT_SECOND')).toBeLessThan(text.indexOf('PROJECT_RULE'));
  expect(text.indexOf('VAULT_FIRST')).toBeLessThan(text.indexOf(chief.instructions));
});

it('does not let a manually removed Chief exception resurrect an old project grant', async () => {
  const project = await projects.save({ name: 'Project', folders: [work] });
  const parent = await bots.create(draft);
  const child = await bots.create({ ...draft, name: 'Child' }, parent.id);
  await bots.grantProject('chief', child.id, project.id, 'full');
  await bots.update(child.id, { projects: [] });
  await expect(
    bots.update(child.id, { projects: [{ project: project.id, level: 'full' }] }),
  ).rejects.toThrow('errors.projectCeiling');
});

it('does not activate a Chief exception when its persistent record cannot be written', async () => {
  const project = await projects.save({ name: 'Project', folders: [work] });
  const parent = await bots.create(draft);
  const child = await bots.create({ ...draft, name: 'Child' }, parent.id);
  await mkdir(join(bots.dir, 'project-grants.json'));
  await expect(bots.grantProject('chief', child.id, project.id, 'full')).rejects.toThrow();
  expect(bots.get(child.id).projects).toEqual([]);
  await expect(
    bots.previewUpdate(child.id, { projects: [{ project: project.id, level: 'full' }] }, child.id),
  ).rejects.toThrow('errors.projectCeiling');
});

it('keeps the bot sandbox ceiling independent of a parent Full project in another root', async () => {
  const full = await projects.save({ name: 'Full project', folders: [bots.dir] });
  const parent = testBot(work, { projects: [{ project: full.id, level: 'full' }] });
  const child = testBot(work, { sandbox: 'danger-full-access' });
  await expect(assertCeiling(child, parent, projects.list())).rejects.toThrow(
    'errors.sandboxCeiling',
  );
});
it('checks Full and Writer ceilings per root rather than borrowing another project level', async () => {
  const parent = testBot(work, { sandbox: 'danger-full-access', readScope: [work, bots.dir] });
  await expect(
    assertCeiling(
      testBot(bots.dir, {
        sandbox: 'danger-full-access',
        readScope: [bots.dir],
        writeScope: [bots.dir],
      }),
      parent,
    ),
  ).rejects.toThrow('errors.fullCeiling');
  await expect(
    assertCeiling(testBot(bots.dir, { readScope: [bots.dir], writeScope: [bots.dir] }), parent),
  ).rejects.toThrow('errors.writeCeiling');
  await expect(
    assertCeiling(
      testBot(bots.dir, { sandbox: 'read-only', readScope: [bots.dir], writeScope: [] }),
      parent,
    ),
  ).resolves.toBeUndefined();
  await expect(
    assertCeiling(testBot(dir, { sandbox: 'read-only', writeScope: [] }), parent),
  ).rejects.toThrow('errors.readCeiling');
});
it('does not apply a Chief project exception to legacy Full roots', async () => {
  const project = await projects.save({ name: 'Approved project', folders: [bots.dir] });
  const parent = testBot(work, { sandbox: 'danger-full-access' });
  const grant = { project: project.id, level: 'full' as const };
  const child = testBot(bots.dir, { sandbox: 'danger-full-access', projects: [grant] });
  await expect(assertCeiling(child, parent, projects.list(), [grant])).rejects.toThrow();
});
it.each(['delete', 'revoke'] as const)(
  'persistently trims descendant legacy scopes on project %s',
  async (operation) => {
    const projectFolder = join(dir, 'project');
    await mkdir(projectFolder);
    const project = await projects.save({ name: 'Project', folders: [projectFolder] });
    const parent = await bots.create(draft);
    await bots.grantProject('chief', parent.id, project.id, 'full');
    const child = await bots.create(
      {
        ...draft,
        name: 'Child',
        workdir: projectFolder,
        readScope: [projectFolder, work],
        writeScope: [projectFolder, work],
      },
      parent.id,
    );
    const grandchild = await bots.create({ ...draft, name: 'Grandchild' }, child.id);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      if (operation === 'delete') await projects.delete(project.id);
      else await bots.grantProject('chief', parent.id, project.id, null);
      expect(projects.list()).toHaveLength(operation === 'delete' ? 0 : 1);
      expect(bots.get(parent.id).projects).toEqual([]);
      for (const bot of [child, grandchild]) {
        const workspace = join(bots.dir, 'workspaces', bot.id);
        const saved = parseBot(await readFile(join(bots.dir, bot.id + '.md'), 'utf8'));
        expect(saved).toMatchObject({
          workdir: workspace,
          readScope: [work],
          writeScope: [work, workspace],
        });
        expect((await stat(workspace)).isDirectory()).toBe(true);
        expect(warning).toHaveBeenCalledWith('Trimmed bot scope after project removal:', bot.id);
        expect(await allowClaudeTool(saved, 'Read', { path: join(projectFolder, 'x') })).toBe(
          false,
        );
      }
      await bots.close();
      bots = new BotStore(
        bots.dir,
        chiefBot(work, 'en'),
        () => undefined,
        () => [],
        () => projects.list(),
      );
      await bots.init();
      await expect(bots.update(child.id, { role: 'Still checked' })).resolves.toMatchObject({
        role: 'Still checked',
      });
      const next = await bots.create({ ...draft, name: 'Next' }, child.id);
      expect(next.workdir).toBe(join(bots.dir, 'workspaces', child.id));
      expect(next.readScope).not.toContain(projectFolder);
      expect(next.writeScope).not.toContain(projectFolder);
    } finally {
      warning.mockRestore();
    }
  },
);

it('trims Writer legacy roots and inherited grants to Reader on downgrade, including a legacy sandbox', async () => {
  const folder = join(dir, 'project');
  await mkdir(folder);
  const project = await projects.save({ name: 'Project', folders: [folder] });
  const parent = await bots.create({ ...draft, sandbox: 'read-only', writeScope: [] });
  await bots.grantProject('chief', parent.id, project.id, 'full');
  const child = await bots.create(
    {
      ...draft,
      name: 'Child',
      workdir: folder,
      readScope: [work, folder],
      writeScope: [folder],
      projects: [{ project: project.id, level: 'write' }],
    },
    parent.id,
  );
  // Simulate an old on-disk bot whose sandbox already exceeds its parent.
  await bots.close();
  const file = join(bots.dir, child.id + '.md');
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace('sandbox: read-only', 'sandbox: danger-full-access'),
  );
  bots = new BotStore(
    bots.dir,
    chiefBot(work, 'en'),
    () => undefined,
    () => [],
    () => projects.list(),
  );
  await bots.init();
  expect(bots.get(child.id).sandbox).toBe('danger-full-access');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await bots.grantProject('chief', parent.id, project.id, 'read');
    const saved = parseBot(await readFile(file, 'utf8'));
    expect(saved).toMatchObject({
      workdir: folder,
      sandbox: 'read-only',
      readScope: [work, folder],
      writeScope: [],
      projects: [{ project: project.id, level: 'read' }],
    });
    await expect(bots.update(child.id, { role: 'Checked' })).resolves.toMatchObject({
      role: 'Checked',
    });
    const next = await bots.create({ ...draft, name: 'Next' }, child.id);
    expect(next.writeScope).toEqual([]);
    await expect(
      bots.create(
        { ...draft, name: 'Escalation', sandbox: 'workspace-write', writeScope: [folder] },
        child.id,
      ),
    ).rejects.toThrow('errors.sandboxCeiling');
  } finally {
    warning.mockRestore();
  }
});
