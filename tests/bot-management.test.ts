import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { BotStore, chiefBot, parseBot } from '../src/main/bots/store';
import { botDraftSchema, botPatchSchema } from '../src/shared/bots';
import { assertCeiling, allowClaudeTool, normalizeServer } from '../src/main/engines/scopes';
import { instructions } from '../src/main/engines/common';
import { chiefAvatar } from '../src/shared/avatars';
import { removeTemporary, temporaryDirectory, testBot } from './helpers';

let dir: string;
let store: BotStore;
let knowledgeDir: string | undefined;
beforeEach(async () => {
  dir = await temporaryDirectory();
  knowledgeDir = undefined;
  store = new BotStore(join(dir, 'bots'), chiefBot(dir, 'en'), () => knowledgeDir);
  await store.init();
});
afterEach(async () => {
  await store.close();
  await removeTemporary(dir);
});
const draft = { name: 'İçerik Botu', engine: 'claude' as const, instructions: 'Write.' };
it('keeps draft/patch fields absent so defaults cannot erase settings or prevent inheritance', () => {
  expect(botDraftSchema.parse(draft)).toEqual(draft);
  expect(botPatchSchema.parse({ name: 'Atlas' })).toEqual({ name: 'Atlas' });
});
it('migrates all legacy avatar IDs without changing metadata', () => {
  for (const shape of ['circle', 'square', 'hexagon'])
    for (const eyes of ['dots', 'lines', 'none']) {
      const { instructions, ...metadata } = testBot(dir);
      const legacy = { ...metadata, avatar: { shape, eyes, color: '#123456' } } as Record<
        string,
        unknown
      >;
      for (const field of ['role', 'persona', 'connections', 'parent']) delete legacy[field];
      const bot = parseBot(matter.stringify(instructions, legacy));
      expect(bot).toMatchObject({
        role: '',
        connections: [],
        parent: null,
        avatar: { shape, eyes, detail: 'none' },
      });
    }
});
it('uses the chief seed once and preserves an existing name/avatar/connections across languages', async () => {
  expect(store.get('chief')).toMatchObject({ avatar: chiefAvatar, connections: ['*'] });
  await store.update('chief', { name: 'Atlas', connections: ['mail'] });
  await store.close();
  store = new BotStore(join(dir, 'bots'), chiefBot(dir, 'tr'));
  await store.init();
  expect(store.get('chief')).toMatchObject({ name: 'Atlas', connections: ['mail'] });
});
it('generates collision-safe slugs, assigns distinct avatars and inherits parent permissions', async () => {
  const first = await store.create(draft);
  const second = await store.create(draft);
  expect([first.id, second.id]).toEqual(['icerik-botu', 'icerik-botu-2']);
  expect(first.avatar).not.toEqual(second.avatar);
  await store.update(first.id, { sandbox: 'read-only', connections: ['claude.ai Gmail'] });
  const child = await store.create({ ...draft, name: 'Child' }, first.id);
  expect(child).toMatchObject({
    parent: first.id,
    workdir: dir,
    readScope: [dir],
    writeScope: [dir],
    sandbox: 'read-only',
    connections: [],
  });
  await store.update(child.id, { name: 'Changed' }, child.id);
  expect(store.get(child.id)).toMatchObject({
    parent: first.id,
    sandbox: 'read-only',
    writeScope: [dir],
  });
});
it('rejects path/sandbox/connection escalation, traversal, wrong parents and cycles', async () => {
  const parent = await store.create({ ...draft, connections: ['claude.ai Gmail'] });
  for (const patch of [
    { workdir: join(dir, '..', 'outside') },
    { readScope: [join(dir, '..', 'outside')] },
    { writeScope: [join(dir, '..', 'outside')] },
    { sandbox: 'danger-full-access' as const },
    { connections: ['*'] },
    { connections: ['drive'] },
    { parent: 'chief' },
  ])
    await expect(store.create({ ...draft, ...patch }, parent.id)).rejects.toThrow();
  const child = await store.create({ ...draft, connections: ['claude_ai_Gmail'] }, parent.id);
  await expect(store.update(parent.id, { parent: child.id })).rejects.toThrow();
  await expect(store.update(parent.id, { connections: [] })).rejects.toThrow();
  await expect(store.update('chief', { name: 'Hijacked' }, child.id)).rejects.toThrow();
  await expect(store.update(child.id, { connections: ['*'] }, child.id)).rejects.toThrow();
});
it('compares canonical paths case-insensitively on Windows', async () => {
  const bot = testBot(dir);
  await expect(
    assertCeiling(
      {
        ...bot,
        workdir: process.platform === 'win32' ? dir.toUpperCase() : dir,
        readScope: [join(dir, 'nested', '..')],
        writeScope: [],
      },
      bot,
    ),
  ).resolves.toBeUndefined();
});
it('enforces sandbox ordering including read-only and full-access parents', async () => {
  const bot = testBot(dir);
  await expect(
    assertCeiling({ ...bot, sandbox: 'workspace-write' }, { ...bot, sandbox: 'read-only' }),
  ).rejects.toThrow('errors.sandboxCeiling');
  await expect(
    assertCeiling(
      { ...bot, sandbox: 'danger-full-access' },
      { ...bot, sandbox: 'danger-full-access' },
    ),
  ).resolves.toBeUndefined();
});
it('filters MCP tools by normalized server names with exact boundaries', async () => {
  const bot = testBot(dir, { connections: ['claude.ai Gmail'] });
  expect(normalizeServer('claude.ai Gmail')).toBe('claude_ai_Gmail');
  for (const name of ['mcp__claude_ai_Gmail__read', 'mcp__team__create_bot'])
    expect(await allowClaudeTool(bot, name, {})).toBe(true);
  for (const name of ['mcp__claude_ai_Gmail_extra__read', 'mcp__drive__read', 'mcp__unknown'])
    expect(await allowClaudeTool(bot, name, {})).toBe(false);
  expect(await allowClaudeTool({ ...bot, connections: [] }, 'mcp__claude_ai_Gmail__read', {})).toBe(
    false,
  );
  expect(await allowClaudeTool({ ...bot, connections: ['*'] }, 'mcp__drive__write', {})).toBe(true);
});
it('grants knowledge read/write only to Chief, including searches and full-access shells', async () => {
  const vault = join(dir, 'vault');
  const bot = testBot(dir, { readScope: [dir, vault], writeScope: [dir, vault] });
  const chief = { ...bot, id: 'chief', system: true };
  for (const name of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) {
    expect(await allowClaudeTool(bot, name, { path: vault }, vault)).toBe(false);
    expect(await allowClaudeTool(chief, name, { path: vault }, vault)).toBe(true);
  }
  expect(await allowClaudeTool(bot, 'Grep', { path: dir }, vault)).toBe(false);
  expect(await allowClaudeTool({ ...bot, sandbox: 'danger-full-access' }, 'Bash', {}, vault)).toBe(
    false,
  );
});
it('writes/reads literal memory, truncates prompt memory and ignores memory as bots', async () => {
  await store.setMemory('chief', 'User prefers tea.');
  expect(await readFile(join(store.dir, 'memory/chief.md'), 'utf8')).toBe('User prefers tea.');
  await writeFile(join(store.dir, 'memory/other.md'), 'Not a bot');
  await mkdir(join(store.dir, 'nested.md'));
  const invalid: unknown[] = [];
  store.on('invalid', (message) => invalid.push(message));
  await store.close();
  store = new BotStore(store.dir, chiefBot(dir, 'en'));
  await store.init();
  expect(store.list().map((bot) => bot.id)).toEqual(['chief']);
  expect(await store.getMemory('chief')).toBe('User prefers tea.');
  await expect(store.getMemory('../escape')).rejects.toThrow();
  expect(instructions(store.get('chief'), undefined, 'x'.repeat(8000) + 'TRUNCATED')).not.toContain(
    'TRUNCATED',
  );
});
it('protects Chief and deletes every descendant', async () => {
  const parent = await store.create(draft);
  const child = await store.create({ ...draft, name: 'Child' }, parent.id);
  await store.create({ ...draft, name: 'Grandchild' }, child.id);
  await expect(store.delete('chief')).rejects.toThrow('errors.chiefProtected');
  await expect(store.update('chief', { parent: parent.id })).rejects.toThrow();
  await expect(store.update('chief', { temporary: true })).rejects.toThrow();
  await expect(store.update('chief', { system: false } as never)).rejects.toThrow();
  await store.delete(parent.id);
  expect(store.list().map((bot) => bot.id)).toEqual(['chief']);
  await store.close();
  expect(store.list().map((bot) => bot.id)).toEqual(['chief']);
});
it('builds identity, persona, profile, memory, scopes, chief knowledge/team and Codex availability in order', () => {
  const vault = join(dir, 'vault');
  const bot = testBot(dir, {
    role: 'Research',
    persona: {
      tone: 'Calm',
      address: 'Captain',
      emoji: 'some',
      length: 'long',
      notes: 'Be precise',
    },
  });
  const profile = { name: 'Alex', address: 'Alex' };
  const text = instructions(bot, vault, 'REMEMBER_THIS', profile, [
    { name: 'Worker', role: 'Builder' },
  ]);
  expect(text).not.toContain(vault);
  expect(instructions({ ...bot, readScope: [vault], writeScope: [vault] }, vault)).not.toContain(
    vault,
  );
  expect(text).not.toContain('Worker');
  const positions = [
    'Help with the task.',
    'Kimliğin: Helper',
    'Ton: Calm',
    'Kullanıcının adı: Alex',
    'Hafızan:',
    'Working directory:',
  ].map((part) => text.indexOf(part));
  expect(
    positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])),
  ).toBe(true);
  expect(
    instructions({ ...bot, id: 'chief', system: true }, vault, '', profile, [
      { name: 'Worker', role: 'Builder' },
    ]),
  ).toContain(vault);
  const codex = instructions({ ...bot, engine: 'codex' }, vault, 'MEMORY');
  expect(codex).not.toContain('bu motorda kullanılamaz');
  for (const tool of [
    'remember',
    'report_to_chief',
    'spawn_temp_bot',
    'delegate_to_bot',
    'list_routines',
    'create_routine',
    'post_to_room',
  ])
    expect(codex).toContain(tool);
});

it('fills only missing Chief fields when loading an old file and preserves explicit connection restrictions', async () => {
  await store.close();
  const source =
    '---\nid: chief\nname: Atlas\nengine: claude\nsystem: true\nworkdir: ' +
    dir.replace(/\\/g, '/') +
    '\n---\nCustom notes';
  await writeFile(join(store.dir, 'chief.md'), source);
  store = new BotStore(store.dir, chiefBot(dir, 'tr'));
  await store.init();
  expect(store.get('chief')).toMatchObject({
    name: 'Atlas',
    connections: ['*'],
    avatar: chiefAvatar,
    instructions: 'Custom notes',
  });
  expect(parseBot(await readFile(join(store.dir, 'chief.md'), 'utf8'))).toMatchObject({
    name: 'Atlas',
    instructions: 'Custom notes',
    routines: [expect.objectContaining({ id: 'vault-update', system: true })],
  });
  await store.update('chief', { connections: [] });
  expect(store.get('chief').connections).toEqual([]);
});

it('allows self changes within the parent ceiling and clears memory before a deleted slug is reused', async () => {
  const parent = await store.create({ ...draft, connections: ['*'] });
  const child = await store.create({ ...draft, name: 'Child' }, parent.id);
  await store.update(child.id, { connections: ['gmail'] }, child.id);
  expect(store.get(child.id).connections).toEqual(['gmail']);
  await store.setMemory(child.id, 'Old private memory');
  await store.delete(child.id);
  const replacement = await store.create({ ...draft, name: 'Child' }, parent.id);
  expect(replacement.id).toBe(child.id);
  expect(await store.getMemory(replacement.id)).toBe('');
});

it('serializes simultaneous slug allocation and refuses creating under a parent deleted first', async () => {
  const bots = await Promise.all([store.create(draft), store.create(draft), store.create(draft)]);
  expect(bots.map((bot) => bot.id)).toEqual(['icerik-botu', 'icerik-botu-2', 'icerik-botu-3']);
  const deleting = store.delete(bots[0].id);
  const creating = store.create({ ...draft, parent: bots[0].id });
  await deleting;
  await expect(creating).rejects.toThrow('errors.botMissing');
});

it('uses SDK MCP provenance to avoid ambiguous underscore prefixes and untrusted app-server names', async () => {
  const bot = testBot(dir, { connections: ['mail'] });
  expect(await allowClaudeTool(bot, 'mcp__mail__blocked__read', {})).toBe(false);
  expect(
    await allowClaudeTool(bot, 'mcp__mail__blocked__read', {}, undefined, {
      name: 'mail__blocked',
      source: 'user',
    }),
  ).toBe(false);
  expect(
    await allowClaudeTool(bot, 'mcp__team__list_bots', {}, undefined, {
      name: 'team',
      source: 'user',
    }),
  ).toBe(false);
  const allowed = { ...bot, connections: ['claude.ai  Gmail'] };
  expect(
    await allowClaudeTool(allowed, 'mcp__claude_ai__Gmail__read', {}, undefined, {
      name: 'claude.ai  Gmail',
      source: 'claudeai',
    }),
  ).toBe(true);
});

it.each(['claude', 'codex'] as const)(
  'validates knowledge overlap on bot creation, previews, updates and direct saves: %s',
  async (engine) => {
    knowledgeDir = join(dir, 'vault');
    const project = join(dir, 'project');
    const safe = {
      ...draft,
      engine,
      workdir: project,
      readScope: [project],
      writeScope: [project],
    };
    const bot = await store.create(safe);
    for (const patch of [
      { workdir: dir },
      { workdir: knowledgeDir },
      { workdir: join(knowledgeDir, 'child') },
      { readScope: [dir] },
      { readScope: [knowledgeDir] },
      { readScope: [join(knowledgeDir, 'child')] },
      { writeScope: [dir] },
      { writeScope: [knowledgeDir] },
      { writeScope: [join(knowledgeDir, 'child')] },
    ]) {
      await expect(store.draft({ ...safe, ...patch })).rejects.toThrow('errors.knowledgeScope');
      await expect(store.create({ ...safe, ...patch })).rejects.toThrow('errors.knowledgeScope');
      await expect(store.previewUpdate(bot.id, patch)).rejects.toThrow('errors.knowledgeScope');
      await expect(store.update(bot.id, patch)).rejects.toThrow('errors.knowledgeScope');
      await expect(store.save({ ...bot, ...patch })).rejects.toThrow('errors.knowledgeScope');
    }
    expect(store.get(bot.id)).toEqual(bot);
    expect(store.list()).toHaveLength(2);
    await expect(
      store.update('chief', { workdir: knowledgeDir, writeScope: [knowledgeDir] }),
    ).resolves.toMatchObject({ id: 'chief' });
  },
);

it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)(
  'defaults manual bot creation to workspace-write within a %s parent',
  async (sandbox) => {
    await store.update('chief', { sandbox });
    const bot = await store.create(draft);
    expect(bot.sandbox).toBe(sandbox === 'read-only' ? 'read-only' : 'workspace-write');
    if (sandbox === 'danger-full-access')
      expect((await store.create({ ...draft, sandbox })).sandbox).toBe('danger-full-access');
    else
      await expect(store.create({ ...draft, sandbox: 'danger-full-access' })).rejects.toThrow(
        'errors.sandboxCeiling',
      );
  },
);
it('defaults network off, migrates Chief on and preserves an explicit Chief opt-out', () => {
  expect(testBot(dir).network).toBe(false);
  expect(chiefBot(dir, 'en').network).toBe(true);
  const { network, instructions, ...metadata } = chiefBot(dir, 'en');
  expect(network).toBe(true);
  expect(parseBot(matter.stringify(instructions, metadata)).network).toBe(true);
  expect(parseBot(matter.stringify(instructions, { ...metadata, network: false })).network).toBe(
    false,
  );
});
it('enforces network ceilings on create/update, including Chief and parentless bots', async () => {
  const parent = await store.create(draft);
  const child = await store.create({ ...draft, parent: parent.id });
  await expect(store.create({ ...draft, network: true }, parent.id)).rejects.toThrow(
    'errors.networkCeiling',
  );
  await expect(store.update(child.id, { network: true })).rejects.toThrow('errors.networkCeiling');
  await store.update(parent.id, { network: true });
  await store.update(child.id, { network: true }, parent.id);
  await expect(store.update(parent.id, { network: false })).rejects.toThrow(
    'errors.networkCeiling',
  );
  await expect(store.update('chief', { network: false })).rejects.toThrow('errors.networkCeiling');
  await store.update(child.id, { network: false });
  await store.update(parent.id, { network: false });
  await store.update('chief', { network: false });
  await expect(store.create({ ...draft, network: true })).rejects.toThrow('errors.networkCeiling');
  await expect(store.update(parent.id, { network: true }, 'chief')).rejects.toThrow(
    'errors.networkCeiling',
  );
  await expect(assertCeiling(testBot(dir, { network: true }), store.get('chief'))).rejects.toThrow(
    'errors.networkCeiling',
  );
});

it('persists missing Chief network permission on load and keeps an explicit false on restart', async () => {
  await store.close();
  const file = join(dir, 'bots', 'chief.md');
  const source = await readFile(file, 'utf8');
  await writeFile(file, source.replace(/^network: true\r?\n/m, ''));
  store = new BotStore(join(dir, 'bots'), chiefBot(dir, 'en'));
  await store.init();
  expect(store.get('chief').network).toBe(true);
  expect(await readFile(file, 'utf8')).toContain('network: true');
  await store.update('chief', { network: false });
  await store.close();
  store = new BotStore(join(dir, 'bots'), chiefBot(dir, 'en'));
  await store.init();
  expect(store.get('chief').network).toBe(false);
});
