import matter from 'gray-matter';
import { translate } from '../src/shared/i18n';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { BotStore, chiefBot } from '../src/main/bots/store';
import { Repository } from '../src/main/db';
import { ChatService } from '../src/main/chat';
import type { EngineAdapter, RunInput } from '../src/main/engines/types';
import type { BotEvent, EventEnvelope } from '../src/shared/events';
import type { Project } from '../src/shared/projects';
import { removeTemporary, temporaryDirectory } from './helpers';

let dir: string;
let store: BotStore;
let db: Repository;
let chat: ChatService;
let events: EventEnvelope[];
let inputs: RunInput[];
let handler: (input: RunInput) => Promise<unknown>;
let results: unknown[];
let knowledgeDir: string | undefined;
let projects: Project[];
let secrets: string[];
const draft = { name: 'Writer', engine: 'claude' as const, instructions: 'Write things.' };
beforeEach(async () => {
  dir = await temporaryDirectory();
  knowledgeDir = undefined;
  projects = [];
  secrets = [];
  store = new BotStore(
    join(dir, 'bots'),
    chiefBot(dir, 'en'),
    () => knowledgeDir,
    () => secrets,
    () => projects,
  );
  await store.init();
  db = new Repository(join(dir, 'chat.sqlite'));
  events = [];
  inputs = [];
  results = [];
  handler = async () => 'Answer';
  const engine: EngineAdapter = {
    id: 'claude',
    cancel() {},
    models: async () => [],
    checkAuth: async () => ({ mode: 'local-cli', state: 'unverified', messageKey: '' }),
    async *run(input) {
      inputs.push(input);
      yield { type: 'status', status: 'thinking' };
      const result = await handler(input);
      results.push(result);
      yield { type: 'message.done', messageId: 'answer', text: String(result) };
      yield { type: 'run.done', durationMs: 1, cancelled: input.signal.aborted };
    },
  };
  chat = new ChatService(
    () => store,
    db,
    { claude: engine, codex: { ...engine, id: 'codex' } },
    () => secrets,
    (event) => events.push(event),
  );
});
afterEach(async () => {
  await chat.close();
  db.close();
  await store.close();
  await removeTemporary(dir);
});
const requests = () =>
  events.map((event) => event.event).filter((event) => event.type === 'approval.request');
async function request() {
  await expect.poll(() => requests().length).toBe(1);
  return requests()[0];
}
async function finished() {
  await expect.poll(() => chat.isBotActive('chief')).toBe(false);
}
const resolutions = () =>
  events.map((event) => event.event).filter((event) => event.type === 'approval.resolved');
const routineDraft = {
  name: 'Sabah mail özeti',
  schedule: { kind: 'daily' as const, time: '09:00' },
  prompt: 'Mailleri özetle.',
};
it.each([
  ['chief', null, false],
  ['chief', 'read', false],
  ['chief', 'write', true],
  ['chief', 'full', true],
  ['writer', 'write', false],
] as const)(
  'restricts project report marking for %s with %s access',
  async (callerId, level, allowed) => {
    const worker = await store.create(draft);
    projects = [{ id: 'notes', name: 'Notes', description: '', folders: [dir] }];
    if (level) {
      await store.grantProject('chief', 'chief', 'notes', level);
      if (callerId !== 'chief') await store.grantProject('chief', callerId, 'notes', level);
    }
    const report = db.addReport({
      botId: worker.id,
      conversationId: 'source',
      summary: 'Written note',
      decisions: [],
      files: [],
      open: [],
      source: 'bot',
    });
    const into = join(dir, 'note.md');
    await writeFile(into, report.summary);
    handler = async (input) => {
      const marking = input.callTool!('mark_reports_processed', { ids: [report.id], into });
      if (allowed) await marking;
      else
        await expect(marking).rejects.toThrow(
          'A writable knowledge or project notes folder is required.',
        );
      return 'checked';
    };
    await chat.send(callerId, 'Process report');
    await expect.poll(() => chat.isBotActive(callerId)).toBe(false);
    expect(results).toEqual(['checked']);
    expect(!!db.report(report.id).processedAt).toBe(allowed);
    if (allowed) expect(db.report(report.id).processedInto).toBe(into);
  },
);

it.each(['knowledge', 'write', 'full'] as const)(
  'resolves a relative report note in a separate %s root',
  async (destination) => {
    const workspace = join(dir, 'workspace');
    const notes = join(dir, 'notes');
    await mkdir(workspace);
    await mkdir(join(notes, 'daily'), { recursive: true });
    await store.update('chief', { workdir: workspace });
    if (destination === 'knowledge') knowledgeDir = notes;
    else {
      projects = [{ id: 'notes', name: 'Notes', description: '', folders: [notes] }];
      await store.grantProject('chief', 'chief', 'notes', destination);
    }
    const report = db.addReport({
      botId: 'writer',
      conversationId: 'source',
      summary: 'Written daily note',
      decisions: [],
      files: [],
      open: [],
      source: 'bot',
    });
    const into = join(notes, 'daily', 'today.md');
    await writeFile(into, report.summary);
    handler = (input) =>
      input.callTool!('mark_reports_processed', { ids: [report.id], into: 'daily/today.md' });
    await chat.send('chief', 'Process report');
    await finished();
    expect(db.report(report.id)).toMatchObject({
      processedAt: expect.any(String),
      processedInto: into,
    });
    expect(await readFile(into, 'utf8')).toBe(report.summary);
  },
);

it.each(['workdir', 'overlap', 'alias'] as const)(
  'resolves a single real report note with %s candidates',
  async (mode) => {
    const notes = join(dir, 'notes');
    await mkdir(join(notes, 'daily'), { recursive: true });
    knowledgeDir = notes;
    const into = join(notes, 'daily', 'today.md');
    await writeFile(into, 'Written note');
    if (mode === 'overlap') {
      await store.update('chief', { workdir: notes });
      projects = [{ id: 'notes', name: 'Notes', description: '', folders: [notes] }];
      await store.grantProject('chief', 'chief', 'notes', 'write');
    } else if (mode === 'alias') {
      const alias = join(dir, 'alias');
      await symlink(notes, alias, 'junction');
      projects = [{ id: 'notes', name: 'Notes', description: '', folders: [alias] }];
      await store.grantProject('chief', 'chief', 'notes', 'write');
    }
    await expect(
      store.validateReportDestination(
        mode === 'workdir' ? 'notes/daily/today.md' : 'daily/today.md',
      ),
    ).resolves.toBe(into);
  },
);

it.each(['knowledge-project', 'project-project', 'workdir-root'] as const)(
  'keeps an ambiguous %s report pending until an absolute note is supplied',
  async (mode) => {
    const notes = join(dir, 'notes');
    const other = mode === 'workdir-root' ? dir : join(dir, 'other');
    for (const root of [notes, other]) {
      await mkdir(join(root, 'daily'), { recursive: true });
      await writeFile(join(root, 'daily', 'today.md'), 'Written note');
    }
    if (mode === 'knowledge-project') knowledgeDir = notes;
    projects = [
      {
        id: 'notes',
        name: 'Notes',
        description: '',
        folders: mode === 'knowledge-project' ? [other] : [notes, other],
      },
    ];
    await store.grantProject('chief', 'chief', 'notes', 'write');
    const report = db.addReport({
      botId: 'writer',
      conversationId: 'source',
      summary: 'Written note',
      decisions: [],
      files: [],
      open: [],
      source: 'bot',
    });
    const into = join(notes, 'daily', 'today.md');
    handler = async (input) => {
      await expect(
        input.callTool!('mark_reports_processed', { ids: [report.id], into: 'daily/today.md' }),
      ).rejects.toThrow('absolute path');
      expect(db.report(report.id).processedAt).toBeUndefined();
      await input.callTool!('mark_reports_processed', { ids: [report.id], into });
      return 'resolved';
    };
    await chat.send('chief', 'Process report');
    await finished();
    expect(results).toEqual(['resolved']);
    expect(db.report(report.id).processedInto).toBe(into);
  },
);

it.each(
  (['outside', 'read', 'ungranted', 'missing', 'directory', 'revoked', 'escape'] as const).flatMap(
    (destination) =>
      (['absolute', 'root-relative', 'workdir-relative'] as const).map(
        (mode) => [destination, mode] as const,
      ),
  ),
)('keeps reports pending for a %s destination (%s)', async (destination, mode) => {
  const notes = join(dir, 'notes');
  const other = join(dir, 'other');
  await mkdir(notes);
  await mkdir(other);
  projects = [
    { id: 'notes', name: 'Notes', description: '', folders: [notes] },
    { id: 'other', name: 'Other', description: '', folders: [other] },
  ];
  await store.grantProject('chief', 'chief', 'notes', 'write');
  if (destination === 'read') await store.grantProject('chief', 'chief', 'other', 'read');
  let into = join(
    ['outside', 'read', 'ungranted'].includes(destination) ? other : notes,
    'note.md',
  );
  if (destination === 'directory') into = notes;
  else if (destination === 'escape') {
    await symlink(other, join(notes, 'link'), 'junction');
    into = join(notes, 'link', 'note.md');
    await writeFile(into, 'Existing note');
  } else if (destination !== 'missing') await writeFile(into, 'Existing note');
  if (mode !== 'absolute') into = relative(mode === 'root-relative' ? notes : dir, into) || '.';
  const report = db.addReport({
    botId: 'writer',
    conversationId: 'source',
    summary: 'Pending',
    decisions: [],
    files: [],
    open: [],
    source: 'bot',
  });
  handler = async (input) => {
    if (destination === 'revoked') await store.grantProject('chief', 'chief', 'notes', 'read');
    await expect(
      input.callTool!('mark_reports_processed', { ids: [report.id], into }),
    ).rejects.toThrow();
    return 'rejected';
  };
  await chat.send('chief', 'Process');
  await expect.poll(() => chat.isBotActive('chief')).toBe(false);
  expect(results).toEqual(['rejected']);
  expect(db.report(report.id).processedAt).toBeUndefined();
});

it.each(['approved', 'edited', 'rejected', 'expired'] as const)(
  'approves routine creation and reports only applied changes: %s',
  async (decision) => {
    const worker = await store.create(draft);
    handler = (input) => input.callTool!('create_routine', routineDraft);
    const run = await chat.send(worker.id, 'Create routine');
    const approval = await request();
    expect(approval).toMatchObject({
      kind: 'routine.create',
      data: { botId: worker.id, routine: { ...routineDraft, system: false } },
    });
    expect(store.get(worker.id).routines).toEqual([]);
    if (decision === 'expired') chat.cancel(run.conversationId);
    else
      await chat.approvals.respond(
        approval.approvalId,
        decision === 'rejected' ? 'rejected' : 'approved',
        decision === 'edited' ? { ...routineDraft, name: 'Akşam mail özeti' } : undefined,
      );
    await expect.poll(() => chat.isBotActive(worker.id)).toBe(false);
    const applied = decision === 'approved' || decision === 'edited';
    expect(store.get(worker.id).routines).toHaveLength(applied ? 1 : 0);
    expect(db.reports({ botId: worker.id })).toHaveLength(applied ? 1 : 0);
  },
);
it('limits routine tools to the caller subtree and rejects role names or invalid schedules before approval', async () => {
  const parent = await store.create(draft);
  const child = await store.create({ ...draft, name: 'Child' }, parent.id);
  const sibling = await store.create({ ...draft, name: 'Sibling' });
  await chat.routines.save(child.id, { ...routineDraft, enabled: true });
  handler = async (input) => {
    expect(await input.callTool!('list_routines', {})).toEqual([]);
    await expect(
      input.callTool!('create_routine', { ...routineDraft, botId: sibling.id }),
    ).rejects.toThrow();
    await expect(
      input.callTool!('create_routine', { ...routineDraft, name: parent.name }),
    ).rejects.toThrow('Name the routine after the work');
    await expect(
      input.callTool!('create_routine', { ...routineDraft, name: parent.name.toUpperCase() }),
    ).rejects.toThrow('Name the routine after the work');
    await expect(
      input.callTool!('create_routine', {
        ...routineDraft,
        schedule: { kind: 'interval', everyMinutes: 14 },
      }),
    ).rejects.toThrow();
    return input.callTool!('create_routine', { ...routineDraft, botId: child.id });
  };
  await chat.send(parent.id, 'Child routine');
  const approval = await request();
  expect(approval.data?.botId).toBe(child.id);
  await chat.approvals.respond(approval.approvalId, 'approved');
  await expect.poll(() => chat.isBotActive(parent.id)).toBe(false);
  expect(store.get(child.id).routines).toHaveLength(2);
});
it('updates only approved routine fields, preserves disabled state and rejects stale approvals', async () => {
  const state = await chat.routines.save('chief', { ...routineDraft, enabled: false });
  handler = (input) =>
    input.callTool!('update_routine', {
      routineId: state.routine.id,
      patch: { prompt: 'New prompt' },
    });
  await chat.send('chief', 'Update routine');
  let approval = await request();
  expect(approval).toMatchObject({
    kind: 'routine.update',
    data: { before: state.routine, routine: { enabled: false, prompt: 'New prompt' } },
  });
  await chat.approvals.respond(approval.approvalId, 'approved');
  await finished();
  expect(
    store.get('chief').routines.find((routine) => routine.id === state.routine.id),
  ).toMatchObject({ enabled: false, prompt: 'New prompt' });
  events = [];
  await chat.send('chief', 'Update again');
  approval = await request();
  await chat.routines.save('chief', {
    ...routineDraft,
    id: state.routine.id,
    enabled: false,
    prompt: 'User changed it',
  });
  await expect(chat.approvals.respond(approval.approvalId, 'approved')).rejects.toThrow(
    'errors.routineApprovalChanged',
  );
  await chat.approvals.respond(approval.approvalId, 'rejected');
  await finished();
});
it('restricts system routine updates, protects deletion and requires approval for ordinary deletion', async () => {
  const state = await chat.routines.save('chief', { ...routineDraft, enabled: true });
  handler = async (input) => {
    for (const patch of [{ name: 'Rename' }, { model: 'opus' }])
      await expect(
        input.callTool!('update_routine', { routineId: 'vault-update', patch }),
      ).rejects.toThrow('protected');
    await expect(input.callTool!('delete_routine', { routineId: 'vault-update' })).rejects.toThrow(
      'protected',
    );
    return input.callTool!('delete_routine', { routineId: state.routine.id });
  };
  await chat.send('chief', 'Delete routine');
  const approval = await request();
  expect(store.get('chief').routines).toHaveLength(2);
  await chat.approvals.respond(approval.approvalId, 'approved');
  await finished();
  expect(store.get('chief').routines.map((routine) => routine.id)).toEqual(['vault-update']);
});
it('runs descendant routines immediately without approval and Chief lists every routine', async () => {
  const worker = await store.create(draft);
  const state = await chat.routines.save(worker.id, { ...routineDraft, enabled: false });
  handler = async (input) => {
    if (input.bot.id !== 'chief') return 'Worker done';
    const list = (await input.callTool!('list_routines', {})) as { botId: string }[];
    expect(list.map((value) => value.botId).sort()).toEqual(['chief', worker.id].sort());
    return input.callTool!('run_routine_now', { routineId: state.routine.id });
  };
  await chat.send('chief', 'Run');
  await finished();
  await expect.poll(() => chat.isBotActive(worker.id)).toBe(false);
  expect(requests()).toEqual([]);
  expect(db.routineRuns(worker.id, state.routine.id)[0].status).toBe('done');
});
it('masks explicit reports and restricts report processing tools to Chief', async () => {
  const worker = await store.create(draft);
  secrets = ['secret-report-123456'];
  handler = async (input) => {
    await expect(input.callTool!('list_reports', {})).rejects.toThrow('Only Chief may do this.');
    await expect(
      input.callTool!('mark_reports_processed', { ids: ['x'], into: 'daily.md' }),
    ).rejects.toThrow();
    return input.callTool!('report_to_chief', {
      summary: 'Done ' + secrets[0],
      decisions: [secrets[0]],
      files: [secrets[0]],
      open: [secrets[0]],
    });
  };
  await chat.send(worker.id, 'Report');
  await expect.poll(() => chat.isBotActive(worker.id)).toBe(false);
  const report = db.reports()[0];
  expect(report).toMatchObject({
    source: 'bot',
    summary: 'Done [REDACTED]',
    decisions: ['[REDACTED]'],
    files: ['[REDACTED]'],
    open: ['[REDACTED]'],
  });
  expect(db.reports()).toHaveLength(1);
  knowledgeDir = join(dir, 'vault');
  await mkdir(knowledgeDir);
  const into = join(knowledgeDir, secrets[0] + '.md');
  await writeFile(join(knowledgeDir, '[REDACTED].md'), report.summary);
  handler = async (input) => {
    await expect(input.callTool!('report_to_chief', { summary: 'No' })).rejects.toThrow();
    expect(await input.callTool!('list_reports', { pending: true })).toMatchObject([
      { id: report.id },
    ]);
    return input.callTool!('mark_reports_processed', {
      ids: [report.id],
      into,
    });
  };
  await chat.send('chief', 'Process');
  await finished();
  expect(db.reports({ pending: true })).toEqual([]);
  expect(db.report(report.id).processedInto).toBe(join(knowledgeDir, '[REDACTED].md'));
});
it.each(['approved', 'edited', 'rejected', 'expired'] as const)(
  'waits without saving, then resolves bot creation: %s',
  async (decision) => {
    handler = (input) => input.callTool!('create_bot', { draft });
    const run = await chat.send('chief', 'Create');
    const approval = await request();
    expect(store.list()).toHaveLength(1);
    expect(approval).toMatchObject({
      kind: 'bot.create',
      data: { bot: { id: 'writer', parent: null } },
    });
    if (decision === 'expired') chat.cancel(run.conversationId);
    else
      await chat.approvals.respond(
        approval.approvalId,
        decision === 'rejected' ? 'rejected' : 'approved',
        decision === 'edited' ? { ...draft, name: 'Editor' } : undefined,
      );
    await finished();
    expect(resolutions()).toHaveLength(1);
    expect(resolutions()[0].decision).toBe(decision);
    expect(store.list()).toHaveLength(decision === 'approved' || decision === 'edited' ? 2 : 1);
    if (decision === 'edited') expect(store.get('editor').name).toBe('Editor');
    await expect(chat.approvals.respond(approval.approvalId, 'approved')).rejects.toThrow();
    expect(db.get(run.conversationId).events.map((event) => event.event)).toContainEqual(
      resolutions()[0],
    );
  },
);
it('rejects an edited escalation and keeps the approval pending for correction', async () => {
  handler = (input) => input.callTool!('create_bot', { draft });
  await chat.send('chief', 'Create');
  const approval = await request();
  await expect(
    chat.approvals.respond(approval.approvalId, 'approved', {
      ...draft,
      writeScope: [join(dir, '..', 'outside')],
    }),
  ).rejects.toThrow();
  expect(resolutions()).toEqual([]);
  expect(store.list()).toHaveLength(1);
  await chat.approvals.respond(approval.approvalId, 'approved', { ...draft, name: 'Safe' });
  await finished();
  expect(store.get('safe').writeScope).toEqual([dir]);
});
it('updates only after approval, previews only changed fields and preserves system/id', async () => {
  handler = (input) =>
    input.callTool!('update_bot', { id: 'chief', patch: { name: 'Atlas', model: 'default' } });
  await chat.send('chief', 'Rename');
  const approval = await request();
  expect(store.get('chief').name).toBe('Chief');
  expect(approval.data).toEqual({
    botId: 'chief',
    before: { name: 'Chief' },
    after: { name: 'Atlas' },
  });
  await chat.approvals.respond(approval.approvalId, 'approved', { name: 'Orion' });
  await finished();
  expect(store.get('chief')).toMatchObject({
    id: 'chief',
    name: 'Orion',
    system: true,
    writeScope: [dir],
    connections: ['*'],
  });
});
it('rejects invalid/unknown approvals and invalid tool inputs', async () => {
  await expect(chat.approvals.respond('missing', 'approved')).rejects.toThrow();
  handler = async (input) => {
    await expect(
      input.callTool!('update_bot', { id: 'chief', patch: { id: 'other' } }),
    ).rejects.toThrow();
    await expect(
      input.callTool!('create_bot', { draft: { ...draft, system: true } }),
    ).rejects.toThrow();
    return 'Safe';
  };
  await chat.send('chief', 'Invalid');
  await finished();
  expect(requests()).toEqual([]);
});
it('expires pending approvals before the terminal event even if a tool was not awaited', async () => {
  let pending!: Promise<unknown>;
  handler = async (input) => {
    pending = input.callTool!('create_bot', { draft });
    await expect.poll(() => requests().length).toBe(1);
    return 'Ending';
  };
  await chat.send('chief', 'End');
  await finished();
  await pending;
  const types = events.map((event) => event.event.type);
  expect(types.indexOf('approval.resolved')).toBeLessThan(types.indexOf('run.done'));
  expect(resolutions()[0].decision).toBe('expired');
  expect(store.list()).toHaveLength(1);
});
it('spawns without approval in a new conversation and returns the final child answer', async () => {
  handler = async (input) =>
    input.bot.id === 'chief'
      ? input.callTool!('spawn_temp_bot', { name: 'Research', task: 'Find evidence' })
      : 'Child result';
  const run = await chat.send('chief', 'Spawn');
  await finished();
  expect(requests()).toEqual([]);
  expect(store.get('research')).toMatchObject({ temporary: true, parent: 'chief', workdir: dir });
  expect(inputs).toHaveLength(2);
  expect(inputs[1].conversationId).not.toBe(run.conversationId);
  expect(db.get(run.conversationId).messages.at(-1)?.text).toBe('Child result');
  expect(
    events.filter((event) => event.conversationId === inputs[1].conversationId).length,
  ).toBeGreaterThan(0);
  expect(events.some(({ event }) => event.type === 'card' && event.kind === 'bot.spawned')).toBe(
    true,
  );
});
it('delegates to idle bots, returns results, reports busy/errors and forbids self-delegation', async () => {
  const child = await store.create(draft);
  handler = async (input) => {
    if (input.bot.id !== 'chief') return 'Delegated answer';
    await expect(input.callTool!('delegate_to_bot', { id: 'chief', task: 'Self' })).rejects.toThrow(
      'itself',
    );
    return input.callTool!('delegate_to_bot', { id: child.id, task: 'Work' });
  };
  await chat.send('chief', 'Delegate');
  await finished();
  expect(results.at(-1)).toBe('Delegated answer');
  expect(
    events.some(
      ({ event }) =>
        event.type === 'card' &&
        event.kind === 'bot.delegated' &&
        event.data.result === 'Delegated answer',
    ),
  ).toBe(true);
});
it('rejects busy delegate targets and emits an error card', async () => {
  const worker = await store.create(draft);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  handler = async (input) => {
    if (input.bot.id === worker.id) {
      await hold;
      return 'Worker done';
    }
    try {
      await expect(
        input.callTool!('delegate_to_bot', { id: worker.id, task: 'Overlap' }),
      ).rejects.toThrow('This bot already has an active run.');
      return 'Busy reported';
    } finally {
      release();
    }
  };
  await chat.send(worker.id, 'Hold');
  await chat.send('chief', 'Delegate');
  await finished();
  expect(
    events.some(
      ({ event }) =>
        event.type === 'card' &&
        event.kind === 'bot.delegated' &&
        event.data.error === 'This bot already has an active run.',
    ),
  ).toBe(true);
});
it('restricts non-chief visibility/delegation/updates to its own subtree', async () => {
  const parent = await store.create(draft);
  const child = await store.create({ ...draft, name: 'Child' }, parent.id);
  const sibling = await store.create({ ...draft, name: 'Sibling' });
  handler = async (input) => {
    if (input.bot.id === child.id) return 'Child';
    const visible = (await input.callTool!('list_bots', {})) as { id: string; memory?: string }[];
    expect(visible.map((bot) => bot.id).sort()).toEqual([child.id, parent.id].sort());
    expect(visible.every((bot) => bot.memory === undefined)).toBe(true);
    await expect(
      input.callTool!('delegate_to_bot', { id: sibling.id, task: 'Denied' }),
    ).rejects.toThrow();
    await expect(
      input.callTool!('update_bot', { id: sibling.id, patch: { name: 'Denied' } }),
    ).rejects.toThrow();
    return input.callTool!('delegate_to_bot', { id: child.id, task: 'Allowed' });
  };
  await chat.send(parent.id, 'Subtree');
  await expect.poll(() => chat.isBotActive(parent.id)).toBe(false);
  expect(results.at(-1)).toBe('Child');
});
it('bounds nested spawning at three edges and five spawns per root execution', async () => {
  handler = async (input) => {
    if (inputs.length === 4) {
      await expect(
        input.callTool!('spawn_temp_bot', { name: 'Too deep', task: 'No' }),
      ).rejects.toThrow('cannot exceed 3');
      return 'Depth limited';
    }
    return input.callTool!('spawn_temp_bot', { name: 'Level', task: 'Go' });
  };
  await chat.send('chief', 'Depth');
  await finished();
  expect(inputs).toHaveLength(4);
  handler = async (input) => {
    if (input.bot.id !== 'chief') return 'Done';
    for (let n = 0; n < 5; n++)
      await input.callTool!('spawn_temp_bot', { name: 'Batch', task: 'Go' });
    await expect(input.callTool!('spawn_temp_bot', { name: 'Sixth', task: 'No' })).rejects.toThrow(
      'At most 5',
    );
    return 'Bounded';
  };
  await chat.send('chief', 'Count');
  await finished();
  expect(store.list().some((bot) => bot.name === 'Sixth')).toBe(false);
});
it('counts tool-started routine runs toward the same three-edge depth limit', async () => {
  const chain = [store.get('chief')];
  const routineIds = new Map<string, string>();
  for (let n = 1; n <= 4; n++) {
    const bot = await store.create({ ...draft, name: 'Routine level ' + n }, chain.at(-1)!.id);
    chain.push(bot);
    routineIds.set(
      bot.id,
      (await chat.routines.save(bot.id, { ...routineDraft, enabled: false })).routine.id,
    );
  }
  handler = async (input) => {
    const index = chain.findIndex((bot) => bot.id === input.bot.id);
    const next = chain[index + 1];
    const args = { botId: next.id, routineId: routineIds.get(next.id)! };
    if (index === 3) {
      await expect(input.callTool!('run_routine_now', args)).rejects.toThrow('cannot exceed 3');
      return 'Depth limited';
    }
    return input.callTool!('run_routine_now', args);
  };
  await chat.send('chief', 'Nested routines');
  await finished();
  expect(inputs.map((input) => input.bot.id)).toEqual(chain.slice(0, 4).map((bot) => bot.id));
  for (const bot of chain.slice(1, 4))
    expect(db.routineRuns(bot.id, routineIds.get(bot.id)!)[0].status).toBe('done');
  expect(db.routineRuns(chain[4].id, routineIds.get(chain[4].id)!)).toEqual([]);
});
it('shares the root spawn budget with tool-started routines', async () => {
  const worker = await store.create({ ...draft, name: 'Routine worker' });
  const state = await chat.routines.save(worker.id, { ...routineDraft, enabled: false });
  handler = async (input) => {
    if (input.bot.id === 'chief') {
      for (let n = 0; n < 5; n++)
        await input.callTool!('spawn_temp_bot', { name: 'Budgeted child', task: 'Go' });
      return input.callTool!('run_routine_now', { botId: worker.id, routineId: state.routine.id });
    }
    if (input.bot.id === worker.id)
      await expect(
        input.callTool!('spawn_temp_bot', { name: 'Sixth routine child', task: 'No' }),
      ).rejects.toThrow('At most 5');
    return 'Budget preserved';
  };
  await chat.send('chief', 'Shared budget');
  await finished();
  expect(store.list().some((bot) => bot.name === 'Sixth routine child')).toBe(false);
  expect(db.routineRuns(worker.id, state.routine.id)[0].status).toBe('done');
  expect(inputs).toHaveLength(7);
});
it('cancels a tool-started routine when its parent is cancelled', async () => {
  const worker = await store.create(draft);
  const state = await chat.routines.save(worker.id, { ...routineDraft, enabled: false });
  handler = (input) =>
    input.bot.id === 'chief'
      ? input.callTool!('run_routine_now', { botId: worker.id, routineId: state.routine.id })
      : new Promise((resolve) => {
          if (input.signal.aborted) resolve('Cancelled');
          else input.signal.addEventListener('abort', () => resolve('Cancelled'), { once: true });
        });
  const parent = await chat.send('chief', 'Run and wait');
  await expect.poll(() => inputs.length).toBe(2);
  expect(chat.isBotActive('chief')).toBe(true);
  chat.cancel(parent.conversationId);
  await expect.poll(() => chat.isBotActive(worker.id) || chat.isBotActive('chief')).toBe(false);
  expect(inputs[1].signal.aborted).toBe(true);
  expect(db.routineRuns(worker.id, state.routine.id)[0].status).toBe('cancelled');
});
it('persists memory, provides chief previews, scopes history and injects saved memory on the next run', async () => {
  const worker = await store.create(draft);
  const old = db.start(worker, 'PRIVATE_WORKER_HISTORY');
  db.append(old.runId, { type: 'run.done', durationMs: 1 });
  handler = async (input) => {
    await Promise.all([
      input.callTool!('remember', { text: 'First preference' }),
      input.callTool!('remember', { text: 'Tea is good' }),
    ]);
    await input.callTool!('forget', { match: 'FIRST' });
    const list = (await input.callTool!('list_bots', {})) as { id: string; memory: string }[];
    expect(list.find((bot) => bot.id === 'chief')?.memory).toContain('Tea is good');
    const hits = (await input.callTool!('search_history', {
      query: 'PRIVATE_WORKER_HISTORY',
    })) as unknown[];
    expect(hits).toHaveLength(1);
    return 'Saved';
  };
  await chat.send('chief', 'Memory');
  await finished();
  expect(await store.getMemory('chief')).toBe('Tea is good\n');
  handler = async (input) => {
    if (input.bot.id === 'chief') expect(input.memory).toBe('Tea is good\n');
    else expect(await input.callTool!('search_history', { query: 'Memory' })).toEqual([]);
    return 'Checked';
  };
  await chat.send('chief', 'Again');
  await finished();
  await chat.send(worker.id, 'Own history');
  await expect.poll(() => chat.isBotActive(worker.id)).toBe(false);
});
it('recovers unresolved approvals on reopening, once, including finished historical runs', () => {
  const run = db.start(store.get('chief'), 'Interrupted');
  const approval: BotEvent = {
    type: 'approval.request',
    approvalId: 'orphan',
    title: 'Create',
    details: '',
  };
  db.append(run.runId, approval);
  db.close();
  db = new Repository(join(dir, 'chat.sqlite'));
  expect(db.get(run.conversationId).events.at(-1)?.event).toEqual({
    type: 'approval.resolved',
    approvalId: 'orphan',
    decision: 'expired',
  });
  const count = db.get(run.conversationId).events.length;
  db.close();
  db = new Repository(join(dir, 'chat.sqlite'));
  expect(db.get(run.conversationId).events).toHaveLength(count);
});

it('rejects vault-overlapping create/update/spawn tool proposals without approvals or saved bots', async () => {
  knowledgeDir = join(dir, 'vault');
  const project = join(dir, 'project');
  const worker = await store.create({
    ...draft,
    workdir: project,
    readScope: [project],
    writeScope: [project],
  });
  handler = async (input) => {
    await expect(input.callTool!('create_bot', { draft })).rejects.toThrow(
      translate('en', 'errors.knowledgeScope'),
    );
    await expect(
      input.callTool!('update_bot', { id: worker.id, patch: { writeScope: [dir] } }),
    ).rejects.toThrow(translate('en', 'errors.knowledgeScope'));
    await expect(
      input.callTool!('spawn_temp_bot', { name: 'Unsafe child', task: 'Work' }),
    ).rejects.toThrow(translate('en', 'errors.knowledgeScope'));
    return 'Rejected unsafe roots';
  };
  await chat.send('chief', 'Unsafe proposals');
  await finished();
  expect(requests()).toEqual([]);
  expect(store.list()).toHaveLength(2);
  expect(store.get(worker.id).writeScope).toEqual([project]);
});
it('revalidates edited approvals against the current knowledge directory before saving', async () => {
  const project = join(dir, 'project');
  const safe = { ...draft, workdir: project, readScope: [project], writeScope: [project] };
  handler = (input) => input.callTool!('create_bot', { draft: safe });
  await chat.send('chief', 'Create');
  const approval = await request();
  knowledgeDir = join(dir, 'vault');
  await expect(
    chat.approvals.respond(approval.approvalId, 'approved', { ...safe, workdir: dir }),
  ).rejects.toThrow('errors.knowledgeScope');
  expect(resolutions()).toEqual([]);
  expect(store.list()).toHaveLength(1);
  await chat.approvals.respond(approval.approvalId, 'approved');
  await finished();
  expect(store.get('writer').workdir).toBe(project);
});

it('masks known secrets in remembered notes, manual memory edits, previews and future prompts', async () => {
  const secret = 'test-memory-key-123456';
  secrets = [secret];
  const worker = await store.create(draft);
  const memoryFile = join(store.dir, 'memory/chief.md');
  handler = async (input) => {
    await input.callTool!('remember', { text: 'Saved ' + secret });
    return input.callTool!('list_bots', {});
  };
  await chat.send('chief', 'Remember');
  await finished();
  expect(await readFile(memoryFile, 'utf8')).toBe('Saved [REDACTED]\n');
  expect(results[0]).toContainEqual(
    expect.objectContaining({ id: 'chief', memory: 'Saved [REDACTED]\n' }),
  );
  expect(JSON.stringify(events)).not.toContain(secret);

  await store.setMemory('chief', 'Edited ' + secret);
  expect(await readFile(memoryFile, 'utf8')).toBe('Edited [REDACTED]');
  await writeFile(memoryFile, 'Legacy ' + secret);
  await store.setMemory(worker.id, 'x'.repeat(295) + secret);
  await writeFile(join(store.dir, 'memory', worker.id + '.md'), 'x'.repeat(295) + secret);
  handler = (input) => input.callTool!('list_bots', {});
  await chat.send('chief', 'Read old notes');
  await finished();
  expect(inputs.at(-1)?.memory).toBe('Legacy [REDACTED]');
  expect(results.at(-1)).toContainEqual(
    expect.objectContaining({ id: 'chief', memory: 'Legacy [REDACTED]' }),
  );
  expect(JSON.stringify(results)).not.toContain(secret);
  expect(JSON.stringify(results.at(-1))).not.toContain(secret.slice(0, 5));
  await chat.send(worker.id, 'Read truncated notes');
  await expect.poll(() => chat.isBotActive(worker.id)).toBe(false);
  expect(inputs.at(-1)?.memory).toBe('x'.repeat(295) + '[REDACTED]');

  await writeFile(memoryFile, 'x'.repeat(7995) + secret);
  await chat.send('chief', 'Read long notes');
  await finished();
  expect(inputs.at(-1)?.memory).toBe(('x'.repeat(7995) + '[REDACTED]').slice(0, 8000));
});

it('saves the exact creation preview when parent permissions expand during approval', async () => {
  const project = join(dir, 'project');
  await mkdir(project);
  const parent = await store.create({
    ...draft,
    name: 'Parent',
    workdir: project,
    readScope: [project],
    writeScope: [],
    sandbox: 'read-only',
  });
  handler = (input) => input.callTool!('create_bot', { draft });
  await chat.send(parent.id, 'Create');
  const approval = await request();
  await store.update(parent.id, {
    workdir: dir,
    readScope: [dir],
    writeScope: [dir],
    sandbox: 'workspace-write',
    connections: ['filesystem'],
  });
  await chat.approvals.respond(approval.approvalId, 'approved');
  await expect.poll(() => chat.isBotActive(parent.id)).toBe(false);
  expect(store.get('writer')).toEqual(approval.data?.bot);
});

it.each([false, true])(
  'revalidates creation against a narrowed current caller ceiling (edited: %s)',
  async (edited) => {
    const parent = await store.create({
      ...draft,
      name: 'Parent',
      writeScope: [],
      sandbox: 'read-only',
      connections: ['filesystem'],
    });
    handler = (input) =>
      input.callTool!('create_bot', {
        draft: { ...draft, connections: ['filesystem'] },
      });
    await chat.send(parent.id, 'Create');
    const approval = await request();
    await store.update(parent.id, { connections: [] });
    await expect(
      chat.approvals.respond(
        approval.approvalId,
        'approved',
        edited ? { ...draft, connections: ['filesystem'] } : undefined,
      ),
    ).rejects.toThrow('errors.connectionCeiling');
    expect(store.list()).toHaveLength(2);
    expect(resolutions()).toEqual([]);
    await chat.approvals.respond(approval.approvalId, 'approved', draft);
    await expect.poll(() => chat.isBotActive(parent.id)).toBe(false);
    expect(store.get('writer').connections).toEqual([]);
  },
);

it('refuses overwriting a bot that takes a previewed ID while approval is pending', async () => {
  handler = (input) => input.callTool!('create_bot', { draft });
  await chat.send('chief', 'Create');
  const approval = await request();
  const existing = await store.create(draft);
  await expect(chat.approvals.respond(approval.approvalId, 'approved')).rejects.toThrow();
  expect(store.get(existing.id)).toEqual(existing);
  expect(store.list()).toHaveLength(2);
  await chat.approvals.respond(approval.approvalId, 'rejected');
  await finished();
});

it.each([false, true])(
  'revalidates approved update fields against the current ceiling (edited: %s)',
  async (edited) => {
    const parent = await store.create({ ...draft, name: 'Parent', connections: ['filesystem'] });
    const child = await store.create({ ...draft, name: 'Child' }, parent.id);
    handler = (input) =>
      input.callTool!('update_bot', {
        id: child.id,
        patch: { connections: ['filesystem'], name: child.name },
      });
    await chat.send(parent.id, 'Update');
    const approval = await request();
    expect(approval.data?.after).toEqual({ connections: ['filesystem'] });
    await store.update(parent.id, { connections: [] });
    await expect(
      chat.approvals.respond(
        approval.approvalId,
        'approved',
        edited ? { connections: ['filesystem'] } : undefined,
      ),
    ).rejects.toThrow('errors.connectionCeiling');
    expect(store.get(child.id)).toEqual(child);
    await chat.approvals.respond(approval.approvalId, 'approved', { name: 'Renamed' });
    await expect.poll(() => chat.isBotActive(parent.id)).toBe(false);
    expect(store.get(child.id).name).toBe('Renamed');
  },
);

it('applies the approved update after fields without reusing unchanged proposal fields', async () => {
  const worker = await store.create(draft);
  handler = (input) =>
    input.callTool!('update_bot', {
      id: worker.id,
      patch: { name: 'Renamed', model: worker.model },
    });
  await chat.send('chief', 'Update');
  const approval = await request();
  expect(approval.data?.after).toEqual({ name: 'Renamed' });
  const update = vi.spyOn(store, 'update');
  await chat.approvals.respond(approval.approvalId, 'approved');
  await finished();
  expect(update).toHaveBeenCalledWith(worker.id, approval.data?.after, 'chief');
  expect(store.get(worker.id)).toEqual({ ...worker, name: 'Renamed' });
});

it('rejects a creation snapshot instead of silently inheriting a narrowed write scope', async () => {
  handler = (input) => input.callTool!('create_bot', { draft });
  await chat.send('chief', 'Create');
  const approval = await request();
  await store.update('chief', { writeScope: [] });
  await expect(chat.approvals.respond(approval.approvalId, 'approved')).rejects.toThrow(
    'errors.writeCeiling',
  );
  expect(store.list()).toHaveLength(1);
  expect(resolutions()).toEqual([]);
  await chat.approvals.respond(approval.approvalId, 'approved', draft);
  await finished();
  expect(store.get('writer').writeScope).toEqual([]);
});

it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)(
  'defaults create_bot and spawn_temp_bot to a bounded workspace under %s',
  async (sandbox) => {
    await store.update('chief', { sandbox });
    handler = async (input) => {
      if (input.bot.id !== 'chief') return 'Child result';
      await input.callTool!('create_bot', { draft });
      return input.callTool!('spawn_temp_bot', { name: 'Temp worker', task: 'Work' });
    };
    await chat.send('chief', 'Create both');
    const approval = await request();
    const expected = sandbox === 'read-only' ? 'read-only' : 'workspace-write';
    expect(approval.data?.bot).toMatchObject({ sandbox: expected, network: false });
    await chat.approvals.respond(approval.approvalId, 'approved');
    await finished();
    expect(store.get('writer').sandbox).toBe(expected);
    expect(store.get('temp-worker').sandbox).toBe(expected);
  },
);
it('rejects network escalation through all bot tools before approvals or execution', async () => {
  const worker = await store.create(draft);
  await store.update('chief', { network: false });
  handler = async (input) => {
    await expect(
      input.callTool!('create_bot', { draft: { ...draft, network: true } }),
    ).rejects.toThrow('Network');
    await expect(
      input.callTool!('update_bot', { id: worker.id, patch: { network: true } }),
    ).rejects.toThrow('Network');
    await expect(
      input.callTool!('spawn_temp_bot', { name: 'Online', network: true, task: 'Research' }),
    ).rejects.toThrow('Network');
    return 'Denied';
  };
  await chat.send('chief', 'Test network');
  await finished();
  expect(requests()).toEqual([]);
  expect(store.list()).toHaveLength(2);
});
it.each(['read', 'write', 'full'] as const)(
  'rejects vault read paths in create/update/spawn and %s project grants before approval',
  async (level) => {
    const project = join(dir, 'project');
    const safe = { ...draft, workdir: project, readScope: [project], writeScope: [project] };
    const worker = await store.create(safe);
    knowledgeDir = join(dir, 'vault');
    projects = [{ id: 'vault-project', name: 'Vault', description: '', folders: [knowledgeDir] }];
    const error = 'errors.knowledgeScope: ' + knowledgeDir;
    handler = async (input) => {
      await expect(
        input.callTool!('create_bot', { draft: { ...safe, readScope: [knowledgeDir] } }),
      ).rejects.toThrow(translate('en', 'errors.knowledgeScope') + ': ' + knowledgeDir);
      await expect(
        input.callTool!('update_bot', { id: worker.id, patch: { readScope: [knowledgeDir] } }),
      ).rejects.toThrow(translate('en', 'errors.knowledgeScope') + ': ' + knowledgeDir);
      await expect(
        input.callTool!('spawn_temp_bot', {
          ...safe,
          name: 'Unsafe reader',
          task: 'Work',
          readScope: [knowledgeDir],
        }),
      ).rejects.toThrow(translate('en', 'errors.knowledgeScope') + ': ' + knowledgeDir);
      await expect(
        input.callTool!('grant_project', { botId: worker.id, projectId: 'vault-project', level }),
      ).rejects.toThrow(translate('en', 'errors.knowledgeScope') + ': ' + knowledgeDir);
      return 'Denied';
    };
    await chat.send('chief', 'Test vault');
    await finished();
    await expect(store.grantProject('chief', worker.id, 'vault-project', level)).rejects.toThrow(
      error,
    );
    await expect(
      store.create({ ...safe, projects: [{ project: 'vault-project', level }] }),
    ).rejects.toThrow(error);
    await expect(
      store.update(worker.id, { projects: [{ project: 'vault-project', level }] }),
    ).rejects.toThrow(error);
    expect(requests()).toEqual([]);
    expect(store.list()).toHaveLength(2);
    expect(store.get(worker.id)).toEqual(worker);
  },
);

it.each(['en', 'tr'] as const)(
  'localizes a saved Turkish system routine approval in %s',
  async (language) => {
    const file = join(store.dir, 'chief.md');
    await store.close();
    const saved = matter(await readFile(file, 'utf8'));
    saved.data.routines[0].name = translate('tr', 'routines.reportProcessing');
    saved.data.routines[0].prompt = translate('tr', 'routines.reportPrompt');
    await writeFile(file, matter.stringify(saved.content, saved.data));
    store = new BotStore(store.dir, chiefBot(dir, 'en'));
    await store.init();
    vi.spyOn(chat, 'language').mockReturnValue(language);
    handler = (input) =>
      input.callTool!('update_routine', { routineId: 'vault-update', patch: { enabled: true } });
    await chat.send('chief', 'Change schedule');
    const approval = await request();
    expect(approval.title).toBe(
      translate(language, 'approval.updateRoutine', {
        name: translate(language, 'routines.reportProcessing'),
      }),
    );
    expect(approval.details).toBe(translate(language, 'routines.reportPrompt'));
    await chat.approvals.respond(approval.approvalId, 'rejected');
    await finished();
  },
);
