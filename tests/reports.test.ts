import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Project } from '../src/shared/projects';
import { BotStore, chiefBot } from '../src/main/bots/store';
import { ChatService } from '../src/main/chat';
import { Repository } from '../src/main/db';
import type { BotEvent } from '../src/shared/events';
import type { EngineAdapter, RunInput } from '../src/main/engines/types';
import { removeTemporary, temporaryDirectory } from './helpers';

let dir: string;
let db: Repository;
let store: BotStore;
let chat: ChatService;
let events: BotEvent[];
let terminal: BotEvent;
let secrets: string[];
let knowledgeDir: string | undefined;
let projects: Project[];
let inputs: RunInput[];
let handler: ((input: RunInput) => Promise<void>) | undefined;
beforeEach(async () => {
  dir = await temporaryDirectory();
  secrets = ['report-secret-123456'];
  knowledgeDir = undefined;
  projects = [];
  store = new BotStore(
    join(dir, 'bots'),
    chiefBot(dir, 'en'),
    () => knowledgeDir,
    () => [],
    () => projects,
  );
  await store.init();
  await store.create({ name: 'Worker', engine: 'claude', instructions: 'Work' });
  db = new Repository(join(dir, 'reports.sqlite'));
  inputs = [];
  handler = undefined;
  events = [];
  terminal = { type: 'run.done', durationMs: 8 };
  const engine: EngineAdapter = {
    id: 'claude',
    cancel() {},
    models: async () => [],
    checkAuth: async () => ({ mode: 'local-cli', state: 'unverified', messageKey: '' }),
    async *run(input) {
      inputs.push(input);
      await handler?.(input);
      for (const event of events) yield event;
      yield {
        type: 'message.done',
        messageId: 'final',
        text: 'Summary ' + secrets[0] + 'x'.repeat(800),
      };
      yield terminal;
    },
  };
  chat = new ChatService(
    () => store,
    db,
    { claude: engine, codex: engine },
    () => secrets,
    () => {},
  );
});
afterEach(async () => {
  await chat.close();
  db.close();
  await store.close();
  await removeTemporary(dir);
});
const write: BotEvent = {
  type: 'tool.start',
  toolId: 'write',
  kind: 'file_write',
  title: 'Write',
  argsSummary: JSON.stringify({ file_path: 'changed.md' }),
};
const writeEnd: BotEvent = {
  type: 'tool.end',
  toolId: 'write',
  resultSummary: 'Done',
  error: false,
};
async function finish(botId = 'worker') {
  const run = await chat.send(botId, 'Work');
  await expect.poll(() => chat.isBotActive(botId)).toBe(false);
  return run;
}
it.each([
  ['read only', [], false],
  ['successful file write', [write, writeEnd], true],
  ['unfinished file write', [write], false],
  ['failed file write', [write, { ...writeEnd, error: true }], false],
  ['diff', [{ type: 'diff', file: 'diff.md', unifiedDiff: '+new' }], true],
  [
    'approved project',
    [
      {
        type: 'approval.request',
        approvalId: 'grant',
        title: 'Grant',
        details: '',
        kind: 'project.grant',
      },
      { type: 'approval.resolved', approvalId: 'grant', decision: 'approved' },
    ],
    true,
  ],
  [
    'rejected change',
    [
      { type: 'approval.request', approvalId: 'no', title: 'No', details: '', kind: 'bot.update' },
      { type: 'approval.resolved', approvalId: 'no', decision: 'rejected' },
    ],
    false,
  ],
  [
    'unrelated approval',
    [
      {
        type: 'approval.request',
        approvalId: 'other',
        title: 'Other',
        details: '',
        kind: 'file.delete',
      },
      { type: 'approval.resolved', approvalId: 'other', decision: 'approved' },
    ],
    false,
  ],
] as [string, BotEvent[], boolean][])(
  'creates an automatic report only for qualifying changes: %s',
  async (_name, changes, expected) => {
    events = changes;
    const changed = vi.fn();
    db.on('reportsChanged', changed);
    const run = await finish();
    expect(db.reports()).toHaveLength(expected ? 1 : 0);
    expect(changed).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (expected) {
      const report = db.reports()[0];
      expect(report).toMatchObject({
        ...run,
        source: 'auto',
        botId: 'worker',
        decisions: [],
        open: [],
      });
      expect(report.summary).toHaveLength(600);
      expect(report.summary).toContain('[REDACTED]');
      expect(JSON.stringify(report)).not.toContain(secrets[0]);
    }
  },
);
it.each([
  ['touch changed.md', true],
  ['cp source.md changed.md', true],
  ['sed -i s/old/new/ changed.md', true],
  ['echo updated > changed.md', true],
  ['printf updated >> changed.md', true],
  ['rm old.md', true],
  ['find . -name old.md -delete', true],
  ['git -C . restore changed.md', true],
  ['git -c core.autocrlf=false checkout -- changed.md', true],
  ['git reset --hard HEAD', true],
  ['git apply changes.patch', true],
  ['git commit -m update', true],
  ['npm install package', true],
  ['X=1 env bash -c "touch changed.md"', true],
  [`python -c "open('changed.md', 'w').write('data')"`, true],
  [`python -c "open('changed.md', 'a').write('data')"`, true],
  [`python -c "open('changed.md', 'x').write('data')"`, true],
  [`python -c "Path('changed.md').write_text('data')"`, true],
  [`python -c "Path('changed.md').write_bytes(b'data')"`, true],
  [`node -e "fs.writeFileSync('changed.md', 'data')"`, true],
  [`node -e "fs.appendFileSync('changed.md', 'data')"`, true],
  [`node -e "fs.createWriteStream('changed.md')"`, true],
  [`node -e "fs.promises.writeFile('changed.md', 'data')"`, true],
  [`powershell -c "[IO.File]::WriteAllText('changed.md', 'data')"`, true],
  [`python -c "open('changed.md', 'r').read()"`, false],
  [`node -e "fs.readFileSync('changed.md')"`, false],
  ['ls', false],
  ['git status', false],
  ['git -C . status', false],
  ['git diff', false],
  ['npm test', false],
  ['npm test 2>&1', false],
  ['npm test > /dev/null', false],
  ['cat < changed.md', false],
  ['echo "touch changed.md"', false],
])(
  'reports successful shell steps according to the existing Bash classifier: %s',
  async (command, expected) => {
    for (const argsSummary of [command, JSON.stringify({ command })]) {
      events = [{ ...write, kind: 'command', title: 'Bash', argsSummary }, writeEnd];
      const run = await finish();
      const reports = db.reports().filter((report) => report.runId === run.runId);
      expect(reports).toHaveLength(expected ? 1 : 0);
      if (expected) expect(reports[0].files).toEqual([]);
    }
  },
);
it.each([false, true])(
  'ignores failed or unfinished shell writes (finished: %s)',
  async (finished) => {
    events = [{ ...write, kind: 'command', title: 'command', argsSummary: 'touch changed.md' }];
    if (finished) events.push({ ...writeEnd, error: true });
    await finish();
    expect(db.reports()).toEqual([]);
  },
);
it('collects full file paths despite truncated args, deduplicates diffs and masks every path', async () => {
  events = [
    { ...write, argsSummary: '{truncated', files: ['file-' + secrets[0] + '.md', 'other.md'] },
    writeEnd,
    { type: 'diff', file: 'other.md', unifiedDiff: '+new' },
  ];
  await finish();
  expect(db.reports()[0].files).toEqual(['file-[REDACTED].md', 'other.md']);
});
it.each(['cancelled', 'error', 'chief'] as const)('does not auto-report a %s run', async (kind) => {
  events = [write, writeEnd];
  if (kind === 'cancelled') terminal = { type: 'run.done', durationMs: 1, cancelled: true };
  if (kind === 'error') terminal = { type: 'run.error', code: 'engine', message: 'Failed' };
  await finish(kind === 'chief' ? 'chief' : 'worker');
  expect(db.reports()).toEqual([]);
});
it('keeps changes scoped to the current run when a conversation continues', async () => {
  events = [write, writeEnd];
  const first = await finish();
  events = [];
  await chat.send('worker', 'Just discuss', first.conversationId);
  await expect.poll(() => chat.isBotActive('worker')).toBe(false);
  expect(db.reports()).toHaveLength(1);
});
it.each(['knowledge', 'write', 'full'] as const)(
  'processes just the selected report using a %s destination',
  async (destination) => {
    const first = db.addReport({
      botId: 'worker',
      conversationId: 'source',
      summary: 'FIRST',
      decisions: [],
      files: [],
      open: [],
      source: 'bot',
    });
    const other = db.addReport({
      botId: 'worker',
      conversationId: 'source',
      summary: 'SECOND',
      decisions: [],
      files: [],
      open: [],
      source: 'bot',
    });
    await expect(chat.processReportNow(first.id)).rejects.toThrow('Knowledge');
    const notes = join(dir, 'notes');
    await mkdir(notes);
    const into = join(notes, 'today.md');
    if (destination === 'knowledge') knowledgeDir = notes;
    else {
      projects = [{ id: 'notes', name: 'Notes', description: '', folders: [notes] }];
      await store.grantProject('chief', 'chief', 'notes', destination);
    }
    handler = async (input) => {
      expect(input.bot.id).toBe('chief');
      expect(input.bot.model).toBe('haiku');
      expect(input.prompt).toContain(first.id);
      expect(input.prompt).not.toContain(other.id);
      expect(input.prompt).toContain('AGENTS.md/CLAUDE.md');
      expect(input.prompt).toContain('kod projesini otomatik vault sayma');
      expect(await input.callTool!('list_reports', { pending: true })).toMatchObject([
        { id: first.id },
      ]);
      await expect(
        input.callTool!('mark_reports_processed', { ids: [other.id], into: 'daily/today.md' }),
      ).rejects.toThrow('selected report');
      await writeFile(into, first.summary);
      await input.callTool!('mark_reports_processed', { ids: [first.id], into });
    };
    const run = await chat.processReportNow(first.id);
    await expect.poll(() => chat.isBotActive('chief')).toBe(false);
    expect(db.get(run.conversationId).conversation.title).toBe('Vault güncelleme');
    expect(db.report(first.id)).toMatchObject({
      processedAt: expect.any(String),
      processedInto: into,
    });
    expect(await readFile(into, 'utf8')).toBe(first.summary);
    expect(db.reports({ pending: true }).map((report) => report.id)).toEqual([other.id]);
    expect(db.reports({ pending: false, botId: 'worker', limit: 1 })[0].id).toBe(first.id);
    await expect(chat.processReportNow(first.id)).rejects.toThrow('already processed');
  },
);
it.each(['ungranted', 'read', 'removed'] as const)(
  'refuses process-now with a %s project and no knowledge folder',
  async (access) => {
    projects = [{ id: 'notes', name: 'Notes', description: '', folders: [dir] }];
    if (access !== 'ungranted')
      await store.grantProject('chief', 'chief', 'notes', access === 'read' ? 'read' : 'write');
    if (access === 'removed') projects = [];
    const report = db.addReport({
      botId: 'worker',
      conversationId: 'source',
      summary: 'Pending',
      decisions: [],
      files: [],
      open: [],
      source: 'bot',
    });
    await expect(chat.processReportNow(report.id)).rejects.toThrow('Knowledge');
    expect(inputs).toEqual([]);
    expect(db.report(report.id).processedAt).toBeUndefined();
  },
);
it('marks report batches atomically and preserves their original destination on repeated marking', () => {
  const report = db.addReport({
    botId: 'worker',
    conversationId: 'source',
    summary: 'Done',
    decisions: [],
    files: [],
    open: [],
    source: 'bot',
  });
  expect(() => db.markReportsProcessed([report.id, 'missing'], 'daily.md')).toThrow();
  expect(db.report(report.id).processedAt).toBeUndefined();
  db.markReportsProcessed([report.id], 'daily.md');
  const processed = db.report(report.id);
  db.markReportsProcessed([report.id], 'other.md');
  expect(db.report(report.id)).toEqual(processed);
});
it('preserves the configured model when process-now starts a Codex Chief', async () => {
  knowledgeDir = join(dir, 'vault');
  await store.update('chief', { engine: 'codex', model: 'configured-codex-model' });
  const report = db.addReport({
    botId: 'worker',
    conversationId: 'source',
    summary: 'Done',
    decisions: [],
    files: [],
    open: [],
    source: 'bot',
  });
  const run = await chat.processReportNow(report.id);
  await expect.poll(() => chat.isBotActive('chief')).toBe(false);
  expect(inputs[0].bot).toMatchObject({ engine: 'codex', model: 'configured-codex-model' });
  expect(store.get('chief').model).toBe('configured-codex-model');
  expect(db.get(run.conversationId).events.map(({ event }) => event)).not.toContainEqual({
    type: 'notice',
    level: 'warning',
    message: expect.stringContaining('haiku'),
  });
});
