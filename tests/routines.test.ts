import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import matter from 'gray-matter';
import { BotStore, chiefBot, parseBot } from '../src/main/bots/store';
import { ChatService } from '../src/main/chat';
import { Repository } from '../src/main/db';
import { nextRunAt, Routines } from '../src/main/routines';
import { routinePatchSchema, type RoutineDraft, type Schedule } from '../src/shared/routines';
import type { EngineAdapter, RunInput } from '../src/main/engines/types';
import { removeTemporary, temporaryDirectory } from './helpers';

let dir: string;
let store: BotStore;
let db: Repository;
let chat: ChatService;
let knowledgeDir: string | undefined;
let handler: (input: RunInput) => Promise<string>;
let inputs: RunInput[];
let models: EngineAdapter['models'];
const draft: RoutineDraft = {
  name: 'Sabah mail özeti',
  schedule: { kind: 'daily', time: '09:00' },
  prompt: 'Summarize mail',
  enabled: true,
  model: 'haiku',
};
beforeEach(async () => {
  dir = await temporaryDirectory();
  knowledgeDir = undefined;
  store = new BotStore(join(dir, 'bots'), chiefBot(dir, 'en'), () => knowledgeDir);
  await store.init();
  db = new Repository(join(dir, 'test.sqlite'));
  inputs = [];
  models = vi.fn().mockResolvedValue([
    { id: 'default', label: 'Default' },
    { id: 'gpt-cached', label: 'Cached Codex model' },
    { id: 'haiku', label: 'Invalid alias in cache' },
  ]);
  handler = async () => 'Final result';
  const engine: EngineAdapter = {
    id: 'claude',
    cancel() {},
    models: () => models(),
    checkAuth: async () => ({ mode: 'local-cli', state: 'unverified', messageKey: '' }),
    async *run(input) {
      inputs.push(input);
      const text = await handler(input);
      yield { type: 'message.done', messageId: 'answer', text };
      yield { type: 'run.done', durationMs: 12, cancelled: input.signal.aborted };
    },
  };
  chat = new ChatService(
    () => store,
    db,
    { claude: engine, codex: engine },
    () => [],
    () => {},
  );
});
afterEach(async () => {
  await chat.close();
  db.close();
  await store.close();
  await removeTemporary(dir);
});
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const check = (schedule: Schedule, after: Date, expected: Date) =>
  expect(nextRunAt(schedule, after)).toEqual(expected);

it('calculates daily/weekly/interval times strictly after the cursor, across midnight', () => {
  check({ kind: 'daily', time: '09:00' }, local(28, 8), local(28, 9));
  check({ kind: 'daily', time: '09:00' }, local(28, 9), local(29, 9));
  check({ kind: 'daily', time: '00:00' }, local(28, 23, 59), local(29, 0));
  check({ kind: 'weekly', time: '09:00', days: [1, 5] }, local(28, 12), local(30, 9));
  check({ kind: 'weekly', time: '09:00', days: [3] }, local(28, 9), local(35, 9));
  check({ kind: 'interval', everyMinutes: 15 }, local(28, 23, 50), local(29, 0, 5));
  expect(() => nextRunAt({ kind: 'interval', everyMinutes: 14 }, local(28, 8))).toThrow();
});
it('anchors interval windows locally, handles from/to and overnight end boundaries', () => {
  check(
    { kind: 'interval', everyMinutes: 30, from: '09:00', to: '17:00' },
    local(28, 8),
    local(28, 9),
  );
  check(
    { kind: 'interval', everyMinutes: 30, from: '09:00', to: '17:00' },
    local(28, 9, 1),
    local(28, 9, 30),
  );
  check(
    { kind: 'interval', everyMinutes: 30, from: '09:00', to: '17:00' },
    local(28, 16, 59),
    local(29, 9),
  );
  check(
    { kind: 'interval', everyMinutes: 30, from: '22:00', to: '02:00' },
    local(28, 23, 59),
    local(29, 0),
  );
  check(
    { kind: 'interval', everyMinutes: 30, from: '22:00', to: '02:00' },
    local(29, 2),
    local(29, 22),
  );
  check({ kind: 'interval', everyMinutes: 30, to: '01:00' }, local(28, 0, 30), local(29, 0));
  check(
    { kind: 'interval', everyMinutes: 30, from: '23:30' },
    local(28, 23, 59),
    local(29, 23, 30),
  );
});
it('skips missing DST wall times, runs a repeated daily wall time once, and keeps interval elapsed minutes', () => {
  const script = `import { nextRunAt } from './src/main/routines.ts';
    console.log(JSON.stringify([
      nextRunAt({kind:'daily',time:'02:30'},new Date('2026-03-08T00:00:00-05:00')).toISOString(),
      nextRunAt({kind:'daily',time:'01:30'},new Date('2026-11-01T01:30:00-04:00')).toISOString(),
      nextRunAt({kind:'interval',everyMinutes:60,from:'01:00',to:'04:00'},new Date('2026-03-08T01:30:00-05:00')).toISOString()
      ,nextRunAt({kind:'weekly',days:[0],time:'02:30'},new Date('2026-03-02T00:00:00-05:00')).toISOString()
    ]));`;
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' },
  );
  expect(JSON.parse(output)).toEqual([
    '2026-03-09T06:30:00.000Z',
    '2026-11-02T06:30:00.000Z',
    '2026-03-08T07:00:00.000Z',
    '2026-03-15T06:30:00.000Z',
  ]);
});
it('starts a new titled conversation with a per-run model and finishes its history record', async () => {
  const state = await chat.routines.save('chief', draft);
  const run = await chat.routines.runNow('chief', state.routine.id);
  await expect.poll(() => chat.isBotActive('chief')).toBe(false);
  expect(db.get(run.conversationId).conversation.title).toBe(draft.name);
  expect(inputs[0].bot.model).toBe('haiku');
  expect(store.get('chief').model).toBe('default');
  expect(db.routineRuns('chief', state.routine.id)).toMatchObject([
    {
      conversationId: run.conversationId,
      status: 'done',
      durationMs: 12,
      summary: 'Final result',
      finishedAt: expect.any(String),
    },
  ]);
});
it.each([
  ['claude', 'haiku', true],
  ['claude', 'sonnet', true],
  ['claude', 'opus', true],
  ['claude', 'claude-custom-version', true],
  ['claude', 'gpt-cached', false],
  ['claude', 'unknown', false],
  ['codex', 'haiku', false],
  ['codex', 'sonnet', false],
  ['codex', 'opus', false],
  ['codex', 'claude-custom-version', false],
  ['codex', 'gpt-cached', true],
  ['codex', 'gpt-not-in-cache', false],
  ['codex', 'default', true],
] as const)(
  'applies only compatible routine model overrides: %s / %s',
  async (engine, model, compatible) => {
    await store.update('chief', { engine, model: 'configured-model' });
    const state = await chat.routines.save('chief', { ...draft, model });
    const run = await chat.routines.runNow('chief', state.routine.id);
    await expect.poll(() => chat.isBotActive('chief')).toBe(false);
    expect(inputs[0].bot.model).toBe(compatible ? model : 'default');
    expect(store.get('chief').model).toBe('configured-model');
    const notices = db
      .get(run.conversationId)
      .events.filter(({ event }) => event.type === 'notice');
    expect(notices).toHaveLength(compatible ? 0 : 1);
    if (!compatible)
      expect(notices[0].event).toMatchObject({
        type: 'notice',
        level: 'warning',
        message: expect.stringContaining(model),
      });
  },
);
it('falls back with a notice when the Codex model cache cannot be read', async () => {
  await store.update('chief', { engine: 'codex' });
  vi.mocked(models).mockRejectedValueOnce(new Error('Cache unavailable'));
  const state = await chat.routines.save('chief', { ...draft, model: 'gpt-cached' });
  const run = await chat.routines.runNow('chief', state.routine.id);
  await expect.poll(() => chat.isBotActive('chief')).toBe(false);
  expect(inputs[0].bot.model).toBe('default');
  expect(db.get(run.conversationId).events.some(({ event }) => event.type === 'notice')).toBe(true);
});
it('skips busy bots and does not overlap running routines or replay missed startup occurrences', async () => {
  const state = await chat.routines.save('chief', draft);
  // Opening after today's slot selects tomorrow without recording or replaying today.
  const scheduler = new Routines(() => store, db, chat);
  scheduler.refresh(local(28, 12));
  await scheduler.tick(local(28, 12));
  expect(inputs).toEqual([]);
  expect(db.routineRuns('chief', state.routine.id)).toEqual([]);
  let release!: () => void;
  handler = () =>
    new Promise((resolve) => {
      release = () => resolve('Done');
    });
  await chat.send('chief', 'Hold');
  await expect.poll(() => inputs.length).toBe(1);
  try {
    await scheduler.tick(local(29, 9));
    expect(db.routineRuns('chief', state.routine.id)[0]).toMatchObject({
      status: 'skipped',
      summary: 'bot meşguldü',
    });
    await scheduler.tick(local(29, 9));
    expect(db.routineRuns('chief', state.routine.id)).toHaveLength(1);
    await expect(chat.routines.runNow('chief', state.routine.id)).rejects.toThrow('errors.botBusy');
  } finally {
    release();
  }
  await expect.poll(() => chat.isBotActive('chief')).toBe(false);
  handler = async () => 'Done';
  await Promise.all([scheduler.tick(local(30, 9)), scheduler.tick(local(30, 9))]);
  await expect.poll(() => chat.isBotActive('chief')).toBe(false);
  expect(inputs).toHaveLength(2);
  expect(db.routineRuns('chief', state.routine.id)).toHaveLength(2);
});
it('keeps disabled routines paused and records launch errors', async () => {
  const state = await chat.routines.save('chief', { ...draft, enabled: false });
  chat.routines.refresh(local(28, 8));
  await chat.routines.tick(local(28, 10));
  expect(inputs).toHaveLength(0);
  await chat.routines.save('chief', { ...draft, id: state.routine.id, enabled: true });
  // Use the real due time because enabling starts a fresh future schedule.
  const due = chat.routines
    .list('chief')
    .find((value) => value.routine.id === state.routine.id)!.nextRunAt!;
  vi.spyOn(chat, 'send').mockRejectedValueOnce(new Error('Cannot start'));
  await chat.routines.tick(new Date(due));
  expect(db.routineRuns('chief', state.routine.id)[0]).toMatchObject({
    status: 'error',
    summary: 'Cannot start',
  });
});
it('cancels interrupted routine history on reopening once', async () => {
  const state = await chat.routines.save('chief', draft);
  db.start(store.get('chief'), draft.prompt, undefined, { routineId: state.routine.id });
  db.close();
  db = new Repository(join(dir, 'test.sqlite'));
  const record = db.routineRuns('chief', state.routine.id)[0];
  expect(record).toMatchObject({
    status: 'cancelled',
    durationMs: expect.any(Number),
    finishedAt: expect.any(String),
  });
  db.close();
  db = new Repository(join(dir, 'test.sqlite'));
  expect(db.routineRuns('chief', state.routine.id)[0]).toEqual(record);
});
it('ticks every 30 seconds and stops cleanly', async () => {
  vi.useFakeTimers();
  const tick = vi.spyOn(chat.routines, 'tick').mockResolvedValue();
  try {
    chat.routines.start();
    chat.routines.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
    await chat.routines.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    tick.mockRestore();
  }
});
it('enables Vault update on first startup with an already configured knowledge folder and preserves a later pause', async () => {
  const seeded = new BotStore(join(dir, 'seeded-bots'), chiefBot(dir, 'en'), () =>
    join(dir, 'vault'),
  );
  await seeded.init();
  try {
    const routine = seeded.get('chief').routines[0];
    expect(routine.enabled).toBe(true);
    const { system: _system, ...draft } = routine;
    void _system;
    await seeded.saveRoutine('chief', { ...draft, enabled: false });
  } finally {
    await seeded.close();
  }
  const reopened = new BotStore(seeded.dir, chiefBot(dir, 'en'), () => join(dir, 'vault'));
  await reopened.init();
  try {
    expect(reopened.get('chief').routines[0].enabled).toBe(false);
  } finally {
    await reopened.close();
  }
});
it('migrates legacy routine records with a log while keeping valid definitions', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { instructions, ...bot } = store.get('chief');
  try {
    const result = parseBot(
      matter.stringify(instructions, {
        ...bot,
        routines: [...bot.routines, { id: 'old', schedule: 'every morning', prompt: 'Hi' }],
      }),
    );
    expect(result.routines).toEqual(bot.routines);
    expect(warn).toHaveBeenCalledWith('Skipped legacy routine:', 'chief');
  } finally {
    warn.mockRestore();
  }
  expect(routinePatchSchema.parse({ prompt: 'New prompt' })).toEqual({ prompt: 'New prompt' });
});
it('seeds, protects, persists and toggles Vault update when the knowledge folder changes', async () => {
  expect(store.get('chief').routines).toMatchObject([
    { id: 'vault-update', enabled: false, model: 'haiku', system: true },
  ]);
  knowledgeDir = join(dir, 'vault');
  await store.syncVaultRoutine();
  const routine = store.get('chief').routines[0];
  expect(routine.enabled).toBe(true);
  await chat.routines.save('chief', {
    ...draft,
    id: routine.id,
    name: routine.name,
    model: routine.model,
    enabled: false,
  });
  await expect(chat.routines.delete('chief', routine.id)).rejects.toThrow();
  await expect(chat.routines.save('chief', { ...draft, id: routine.id })).rejects.toThrow();
  await expect(store.save({ ...store.get('chief'), routines: [] })).rejects.toThrow();
  knowledgeDir = undefined;
  await store.syncVaultRoutine();
  expect(store.get('chief').routines[0].enabled).toBe(false);
  await store.close();
  const file = join(store.dir, 'chief.md');
  const { instructions, ...metadata } = store.get('chief');
  await writeFile(file, matter.stringify(instructions, { ...metadata, routines: [] }));
  store = new BotStore(store.dir, chiefBot(dir, 'en'), () => knowledgeDir);
  await store.init();
  expect(parseBot(await readFile(file, 'utf8')).routines[0].id).toBe('vault-update');
});
