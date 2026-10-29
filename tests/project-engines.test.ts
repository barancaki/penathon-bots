import { translate } from '../src/shared/i18n';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeEngine } from '../src/main/engines/claude';
import { CodexEngine } from '../src/main/engines/codex';
import { Approvals } from '../src/main/bots/approvals';
import { BotStore, chiefBot } from '../src/main/bots/store';
import { deletionCommand, indirectDeletion } from '../src/main/engines/deletions';
import { allowClaudeTool, effectiveAccess } from '../src/main/engines/scopes';
import type { BotEvent } from '../src/shared/events';
import type { Project } from '../src/shared/projects';
import type { EngineContext, RunInput } from '../src/main/engines/types';
import { collect, removeTemporary, temporaryDirectory, testBot } from './helpers';
import { allSteps, touchedFiles } from '../src/renderer/src/ui/state';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn(),
}));
const codex = vi.hoisted(() => ({ start: vi.fn(), run: vi.fn() }));
vi.mock('../src/main/engines/codex-mcp', () => ({ codexMcpNames: async () => [] }));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread = codex.start;
  },
}));
let dir: string;
let work: string;
let read: string;
let full: string;
let projects: Project[];
let context: EngineContext;
let input: RunInput;
beforeEach(async () => {
  vi.clearAllMocks();
  dir = await temporaryDirectory();
  work = join(dir, 'work');
  read = join(dir, 'read');
  full = join(dir, 'full');
  for (const folder of [work, read, full]) await mkdir(folder);
  projects = [
    { id: 'writer', name: 'Writer', folders: [work], description: '' },
    { id: 'reader', name: 'Reader', folders: [read], description: '' },
    { id: 'full', name: 'Full', folders: [full], description: '' },
  ];
  context = {
    auth: () => ({ mode: 'local-cli' }),
    knowledgeDir: () => undefined,
    projects: () => projects,
    secrets: () => ['known-secret'],
  };
  input = {
    bot: testBot(work, {
      sandbox: 'read-only',
      writeScope: [],
      projects: [
        { project: 'writer', level: 'write' },
        { project: 'reader', level: 'read' },
        { project: 'full', level: 'full' },
      ],
    }),
    conversationId: 'c',
    prompt: 'Work',
    signal: new AbortController().signal,
  };
  vi.mocked(query).mockReturnValue(
    (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'test-only',
      } as SDKMessage;
    })() as ReturnType<typeof query>,
  );
});
afterEach(async () => {
  await removeTemporary(dir);
});
async function options() {
  await collect(new ClaudeEngine(context).run(input));
  return vi.mocked(query).mock.calls[0][0].options!;
}
it.each(['en', 'tr'] as const)(
  'localizes denied empty Writes in %s and never marks the file edited',
  async (language) => {
    context.language = () => language;
    const file = join(work, 'keep.md');
    await writeFile(file, 'Keep this text');
    const requestApproval = vi.fn(async () => false);
    input.requestApproval = requestApproval;
    const args = { file_path: file, content: '' };
    vi.mocked(query).mockImplementation(
      ({ options }) =>
        (async function* () {
          yield {
            type: 'assistant',
            message: {
              id: 'write-message',
              content: [{ type: 'tool_use', id: 'denied-write', name: 'Write', input: args }],
            },
          } as SDKMessage;
          const permission = await options!.canUseTool!('Write', args, {
            toolUseID: 'denied-write',
          } as never);
          expect(permission).toMatchObject({
            behavior: 'deny',
            message: translate(language, 'errors.deletionDenied'),
          });
          const hook = options!.hooks!.PreToolUse![0].hooks[0];
          const result = await hook(
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Write',
              tool_input: args,
              tool_use_id: 'denied-write',
            } as never,
            undefined,
            { signal: input.signal },
          );
          expect(result).toMatchObject({
            hookSpecificOutput: {
              permissionDecision: 'deny',
              permissionDecisionReason: translate(language, 'errors.deletionDenied'),
            },
          });
          yield {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'denied-write',
                  is_error: true,
                  content: `PreToolUse Write hook error: ${translate(language, 'errors.deletionDenied')}`,
                },
              ],
            },
          } as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: 'test',
            duration_ms: 1,
            usage: { input_tokens: 1, output_tokens: 1 },
          } as SDKMessage;
        })() as ReturnType<typeof query>,
    );
    const events = await collect(new ClaudeEngine(context).run(input));
    expect(requestApproval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: translate(language, 'approval.deleteFiles'),
      }),
    );
    expect(
      touchedFiles(
        allSteps(
          events.map((event, sequence) => ({
            event,
            sequence,
            runId: 'run',
            conversationId: 'chat',
            createdAt: '',
          })),
        ),
      ),
    ).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('Keep this text');
  },
);
it.each([
  'rm -rf old',
  'rmdir old',
  'del /f /q old',
  'erase old',
  'rd /s /q old',
  'Remove-Item -LiteralPath old -Recurse -Force',
  'ri old',
  'unlink old',
  'git rm -f old',
  'git clean -fd',
  'find old -name "*.tmp" -delete',
  'python -c "import shutil; shutil.rmtree(\'old\')"',
  'python -c "import os; os.remove(\'old\')"',
  'r""m old',
  'X=1 sudo command env Y=2 nohup time rm old',
  'sudo -n -E -u root rm old',
  'command -p rm old',
  'env -u HOME rm old',
  'env -S "rm old"',
  'time -p rm old',
  'cmd /c "del old"',
  'powershell -Command "Remove-Item -Recurse old"',
  'pwsh -c "ri old"',
  'bash -c "sh -c \'rm old\'"',
  'shred -u old',
  'find -P old -delete',
  'find -L old -delete',
  'find -H old -delete',
  'find old -exec rm {} \\;',
  "node -e \"require('fs').rmSync('old', {recursive: true})\"",
  "node -e \"require('fs').unlinkSync('old')\"",
])('recognizes deletion commands without executing them: %s', (command) => {
  expect(deletionCommand(command, work)).toMatchObject({
    paths: [join(work, command === 'git clean -fd' ? '.' : 'old')],
  });
});
it('keeps quoted paths, marks unknown paths and does not classify ordinary writes as deletes', () => {
  expect(deletionCommand('rm "old file.txt"', work)?.paths).toEqual([join(work, 'old file.txt')]);
  for (const command of [
    'cmd /c del "old file.txt"',
    'powershell -Command Remove-Item -Recurse "old file.txt"',
  ])
    expect(deletionCommand(command, work)?.paths).toEqual([join(work, 'old file.txt')]);
  expect(deletionCommand('rm "$TARGET"', work)).toMatchObject({ paths: [], uncertain: true });
  expect(deletionCommand('python -c "import os; os.remove(target)"', work)).toMatchObject({
    paths: [],
    uncertain: true,
  });
  expect(
    deletionCommand('python -c "import os; os.remove(\'old\'); os.remove(target)"', work)
      ?.uncertain,
  ).toBe(true);
  expect(deletionCommand('echo hello', work)).toBeUndefined();
  for (const redirect of ['2>&1', '&> NUL', '>&2', '2>/dev/null', '>$null', '> NUL', '2>nul']) {
    expect(deletionCommand('npm test ' + redirect, work), redirect).toBeUndefined();
    expect(deletionCommand('rm old ' + redirect, work), redirect).toEqual({
      paths: [join(work, 'old')],
      uncertain: false,
    });
  }
  expect(deletionCommand('grep "rm" notes.txt', work)).toBeUndefined();
  expect(
    deletionCommand("rm 'a b'; rmdir c && unlink d || shred e | rm f & rm g\nrm h", work)?.paths,
  ).toEqual(['a b', 'c', 'd', 'e', 'f', 'g', 'h'].map((path) => join(work, path)));
  expect(deletionCommand('find -P first second -delete', work)?.paths).toEqual([
    join(work, 'first'),
    join(work, 'second'),
  ]);
});

it('uses current BotStore scopes in an open run after project removal trims legacy roots', async () => {
  const store = new BotStore(
    join(dir, 'bots'),
    chiefBot(work, 'en'),
    () => undefined,
    () => [],
    () => projects,
  );
  await store.init();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const parent = await store.create({ name: 'Parent', engine: 'claude', instructions: '' });
    await store.grantProject('chief', parent.id, 'full', 'full');
    const child = await store.create(
      {
        name: 'Child',
        engine: 'claude',
        instructions: '',
        workdir: full,
        readScope: [full],
        writeScope: [full],
      },
      parent.id,
    );
    input.bot = child;
    let approve!: (value: boolean) => void;
    input.requestApproval = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        }),
    );
    context.getBot = (id) => store.get(id);
    const sdk = await options();
    const call = (name: string, args: Record<string, unknown>) =>
      sdk.canUseTool!(name, args, {
        signal: input.signal,
        toolUseID: name,
        requestId: 'r',
      });
    expect(await call('Bash', { command: 'touch x' })).toMatchObject({ behavior: 'allow' });
    const pending = call('Bash', { command: 'rm x' });
    await expect.poll(() => vi.mocked(input.requestApproval!).mock.calls.length).toBe(1);
    await store.removeProject('full', async () => {
      projects = projects.filter((project) => project.id !== 'full');
    });
    expect(store.get(child.id).workdir).toBe(join(store.dir, 'workspaces', child.id));
    approve(true);
    expect(await pending).toMatchObject({ behavior: 'deny' });
    for (const [name, args] of [
      ['Bash', { command: 'touch x' }],
      ['Bash', { command: 'rm x' }],
      ['Write', { file_path: join(full, 'x'), content: 'new' }],
      ['Edit', { file_path: join(full, 'x'), old_string: 'old', new_string: 'new' }],
    ] as const)
      expect(await call(name, args)).toMatchObject({ behavior: 'deny' });
    const hook = sdk.hooks!.PreToolUse![0].hooks[0];
    expect(
      await hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 's',
          transcript_path: '',
          cwd: full,
          tool_name: 'Bash',
          tool_input: { command: 'touch x' },
          tool_use_id: 'trimmed',
        },
        'trimmed',
        { signal: input.signal },
      ),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    context.getBot = () => {
      throw new Error('errors.botMissing');
    };
    expect(await call('Read', { file_path: join(work, 'x') })).toMatchObject({ behavior: 'deny' });
    expect(input.requestApproval).toHaveBeenCalledOnce();
  } finally {
    warning.mockRestore();
    await store.close();
  }
});
it.each(['approved', 'rejected', 'expired'] as const)(
  'blocks the actual PreToolUse hook until Writer deletion approval is %s',
  async (decision) => {
    const approvals = new Approvals();
    const controller = new AbortController();
    const events: BotEvent[] = [];
    input.signal = controller.signal;
    input.requestApproval = (request) =>
      approvals
        .request(
          'run',
          request,
          controller.signal,
          (event) => events.push(event),
          async () => true,
        )
        .then(Boolean);
    const sdk = await options();
    const hook = sdk.hooks!.PreToolUse![0].hooks[0];
    const command = 'rm "' + join(work, 'old.txt') + '"';
    let settled = false;
    const pending = hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '',
        cwd: work,
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: 'delete',
      },
      'delete',
      { signal: input.signal },
    ).then((result) => {
      settled = true;
      return result;
    });
    await expect.poll(() => events.some((event) => event.type === 'approval.request')).toBe(true);
    expect(settled).toBe(false);
    const request = events.find((event) => event.type === 'approval.request')!;
    expect(request).toMatchObject({
      kind: 'file.delete',
      data: { command, paths: [join(work, 'old.txt')] },
    });
    if (decision === 'expired') controller.abort();
    else await approvals.respond(request.approvalId, decision);
    expect(await pending).toMatchObject({
      hookSpecificOutput: { permissionDecision: decision === 'approved' ? 'allow' : 'deny' },
    });
    if (decision !== 'approved')
      expect(JSON.stringify(await pending)).toContain('The user did not approve deletion.');
    expect(events.at(-1)).toMatchObject({ type: 'approval.resolved', decision });
    if (decision === 'approved') {
      expect(
        await sdk.canUseTool!(
          'Bash',
          { command },
          { signal: input.signal, toolUseID: 'delete', requestId: 'r' },
        ),
      ).toMatchObject({ behavior: 'allow' });
      expect(events.filter((event) => event.type === 'approval.request')).toHaveLength(1);
    }
  },
);
it('denies writes/deletes in Reader roots and allows Full deletion without asking', async () => {
  input.requestApproval = vi.fn().mockResolvedValue(true);
  const sdk = await options();
  for (const name of ['Write', 'Edit'])
    expect(
      await sdk.canUseTool!(
        name,
        { file_path: join(read, 'x') },
        { signal: input.signal, toolUseID: name, requestId: 'r' },
      ),
    ).toMatchObject({ behavior: 'deny' });
  expect(
    await sdk.canUseTool!(
      'Bash',
      { command: 'rm "' + join(read, 'x') + '"' },
      { signal: input.signal, toolUseID: 'reader', requestId: 'r' },
    ),
  ).toMatchObject({ behavior: 'deny' });
  expect(
    await sdk.canUseTool!(
      'Bash',
      { command: 'rm "' + join(full, 'x') + '"' },
      { signal: input.signal, toolUseID: 'full', requestId: 'r' },
    ),
  ).toMatchObject({ behavior: 'allow' });
  expect(input.requestApproval).not.toHaveBeenCalled();
});
it('rejects ambiguous deletes, asks for legacy writes, and fails closed without an approval callback', async () => {
  input.bot.projects = [];
  input.bot.sandbox = 'workspace-write';
  input.bot.writeScope = [work];
  input.requestApproval = vi.fn().mockResolvedValue(false);
  const sdk = await options();
  for (const command of ['rm "$TARGET"', 'rm old']) {
    expect(
      await sdk.canUseTool!(
        'Bash',
        { command },
        { signal: input.signal, toolUseID: command, requestId: 'r' },
      ),
    ).toMatchObject({ behavior: 'deny' });
  }
  expect(input.requestApproval).toHaveBeenCalledTimes(1);
  delete input.requestApproval;
  vi.mocked(query).mockClear();
  const noCallback = await options();
  expect(
    await noCallback.canUseTool!(
      'Bash',
      { command: 'rm old' },
      { signal: input.signal, toolUseID: 'none', requestId: 'r' },
    ),
  ).toMatchObject({ behavior: 'deny' });
});
it('passes effective directories and sanitized rules to Claude without loading project settings', async () => {
  await writeFile(join(work, 'AGENTS.md'), 'RULE known-secret');
  const sdk = await options();
  expect(sdk.settingSources).toEqual([]);
  expect(sdk.additionalDirectories).toEqual(expect.arrayContaining([work, read, full]));
  expect(sdk.systemPrompt).toMatchObject({ append: expect.stringContaining('RULE [REDACTED]') });
});
it('keeps project Full inside Codex writable roots with Writer chat instructions and project rules', async () => {
  await writeFile(join(work, 'CLAUDE.md'), 'CODEX_RULE known-secret');
  codex.start.mockReturnValue({ runStreamed: codex.run });
  codex.run.mockResolvedValue({
    events: (async function* () {
      yield {
        type: 'turn.completed',
        usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
      };
    })(),
  });
  input.bot.engine = 'codex';
  await collect(new CodexEngine(context).run(input));
  expect(codex.start).toHaveBeenCalledWith(
    expect.objectContaining({
      sandboxMode: 'workspace-write',
      additionalDirectories: [work, full],
    }),
  );
  expect(codex.run.mock.calls[0][0]).toContain(
    'dosya silmeden önce kullanıcıdan sohbette onay iste',
  );
  expect(codex.run.mock.calls[0][0]).toContain('CODEX_RULE [REDACTED]');
  expect(codex.run.mock.calls[0][0]).not.toContain('known-secret');
});

it('keeps vault access blocked while allowing a confined Writer deletion to wait for approval', async () => {
  const vault = join(dir, 'vault');
  await mkdir(vault);
  context.knowledgeDir = () => vault;
  input.requestApproval = vi.fn().mockResolvedValue(true);
  const sdk = await options();
  expect(
    await sdk.canUseTool!(
      'Bash',
      { command: 'rm "' + join(work, 'old') + '"' },
      { signal: input.signal, toolUseID: 'safe', requestId: 'r' },
    ),
  ).toMatchObject({ behavior: 'allow' });
  expect(input.requestApproval).toHaveBeenCalledOnce();
  for (const command of [
    'rm "' + join(vault, 'secret') + '"',
    'rm old; cat "' + join(vault, 'secret') + '"',
    'rm "$TARGET"',
  ])
    expect(
      await sdk.canUseTool!(
        'Bash',
        { command },
        { signal: input.signal, toolUseID: command, requestId: 'r' },
      ),
    ).toMatchObject({ behavior: 'deny' });
  expect(input.requestApproval).toHaveBeenCalledOnce();
});
it('keeps Claude sandbox protections for mixed Full/Reader grants', async () => {
  const sdk = await options();
  if (process.platform === 'win32') {
    expect(
      await sdk.canUseTool!(
        'Bash',
        { command: 'echo x > "' + join(read, 'x') + '"' },
        { signal: input.signal, toolUseID: 'write', requestId: 'r' },
      ),
    ).toMatchObject({ behavior: 'deny' });
  } else {
    expect(sdk.sandbox).toMatchObject({
      enabled: true,
      filesystem: { allowWrite: [work, full], denyWrite: [read] },
    });
  }
});

it.each([
  'find -files0-from targets -delete',
  'find . -files0-from targets -delete',
  'xargs rm',
  'cat targets | xargs rm',
  'rm "$(cat targets)"',
  'rm ' + String.fromCharCode(96) + 'cat targets' + String.fromCharCode(96),
  'rm "$X"',
  'del %X%',
  'Remove-Item $env:X',
  'rm *',
  'rm */../outside',
  'git rm --pathspec-from-file=targets',
  'powershell -c "Remove-Item $X"',
  'bash -c "rm $X"',
  'python -c "import os; os.remove(target)"',
  'python -c "import os; os.remove(\'old\'); os.system(command)"',
  "node -e \"require('fs').rmSync('old', {recursive: evil()})\"",
  'rm',
])('rejects indirect deletion without asking in both SDK permission paths: %s', async (command) => {
  input.requestApproval = vi.fn().mockResolvedValue(true);
  const sdk = await options();
  expect(
    await sdk.canUseTool!(
      'Bash',
      { command },
      { signal: input.signal, toolUseID: 'indirect', requestId: 'r' },
    ),
  ).toMatchObject({ behavior: 'deny', message: translate('en', indirectDeletion) });
  const hook = sdk.hooks!.PreToolUse![0].hooks[0];
  expect(
    await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '',
        cwd: work,
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: 'indirect',
      },
      'indirect',
      { signal: input.signal },
    ),
  ).toMatchObject({
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: translate('en', indirectDeletion),
    },
  });
  expect(input.requestApproval).not.toHaveBeenCalled();
});
it('checks git deletion targets in the selected cwd and leaves writable moves free of approval', async () => {
  input.requestApproval = vi.fn().mockResolvedValue(true);
  const sdk = await options();
  const run = (command: string) =>
    sdk.canUseTool!(
      'Bash',
      { command },
      {
        signal: input.signal,
        toolUseID: command,
        requestId: 'r',
      },
    );
  for (const name of ['mv', 'Move-Item', 'move', 'ren', 'Rename-Item', 'git mv']) {
    expect(
      await run(name + ' "' + join(read, 'f') + '" "' + join(work, 'new') + '"'),
    ).toMatchObject({ behavior: 'deny' });
    for (const source of [work, full])
      expect(
        await run(name + ' "' + join(source, 'f') + '" "' + join(work, 'new') + '"'),
      ).toMatchObject({ behavior: 'allow' });
  }
  expect(input.requestApproval).not.toHaveBeenCalled();
  for (const [subcommand, target] of [
    ['rm -- old', 'old'],
    ['clean -fd', '.'],
  ]) {
    const command = (cwd: string) =>
      'git --no-pager -c color.ui=false -C "' + cwd + '" ' + subcommand;
    expect(deletionCommand(command(work), read)).toEqual({
      paths: [join(work, target)],
      uncertain: false,
    });
    expect(await run(command(read))).toMatchObject({ behavior: 'deny' });
    expect(await run(command(full))).toMatchObject({ behavior: 'allow' });
    expect(await run(command(work))).toMatchObject({ behavior: 'allow' });
    expect(input.requestApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'file.delete',
        data: { command: command(work), paths: [join(work, target)] },
      }),
    );
  }
  expect(input.requestApproval).toHaveBeenCalledTimes(2);
  const command = 'git --git-dir="' + join(work, '.git') + '" --work-tree="' + full + '" rm -- old';
  expect(deletionCommand(command, work)).toEqual({ paths: [join(full, 'old')], uncertain: false });
  expect(await run(command)).toMatchObject({ behavior: 'allow' });
  expect(input.requestApproval).toHaveBeenCalledTimes(2);
});
it('rechecks every target after approval and after cached approval if a symlink escapes', async () => {
  const target = join(work, 'target');
  await mkdir(target);
  let answer!: (approved: boolean) => void;
  input.requestApproval = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  const sdk = await options();
  const command = 'rm "' + join(target, 'old') + '"';
  const pending = sdk.canUseTool!(
    'Bash',
    { command },
    { signal: input.signal, toolUseID: 'swap', requestId: 'r' },
  );
  await expect
    .poll(() => input.requestApproval && vi.mocked(input.requestApproval).mock.calls.length)
    .toBe(1);
  await rename(target, join(work, 'original-target'));
  await symlink(read, target, process.platform === 'win32' ? 'junction' : 'dir');
  answer(true);
  expect(await pending).toMatchObject({ behavior: 'deny' });
  expect(
    await sdk.canUseTool!(
      'Bash',
      { command },
      { signal: input.signal, toolUseID: 'swap', requestId: 'r' },
    ),
  ).toMatchObject({ behavior: 'deny' });
  expect(input.requestApproval).toHaveBeenCalledOnce();
});
it.each(['', ' \n\t '])(
  'asks before overwriting an existing Writer file with blank content: %j',
  async (content) => {
    const file = join(work, 'document.txt');
    await writeFile(file, 'keep this');
    input.requestApproval = vi.fn().mockResolvedValue(false);
    const sdk = await options();
    expect(
      await sdk.canUseTool!(
        'Write',
        { file_path: file, content },
        { signal: input.signal, toolUseID: 'blank', requestId: 'r' },
      ),
    ).toMatchObject({ behavior: 'deny', message: 'The user did not approve deletion.' });
    expect(input.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'file.delete',
        data: { command: expect.stringContaining('Write'), paths: [file] },
      }),
    );
  },
);
it('allows approved blank overwrites, skips new empty files and Full roots, and denies Reader/outside files', async () => {
  for (const folder of [work, read, full, dir]) await writeFile(join(folder, 'existing'), 'keep');
  input.requestApproval = vi.fn().mockResolvedValue(true);
  const sdk = await options();
  const blank = (file: string) =>
    sdk.canUseTool!(
      'Write',
      { file_path: file, content: '' },
      { signal: input.signal, toolUseID: file, requestId: 'r' },
    );
  expect(await blank(join(work, 'existing'))).toMatchObject({ behavior: 'allow' });
  expect(await blank(join(work, 'new'))).toMatchObject({ behavior: 'allow' });
  expect(await blank(join(full, 'existing'))).toMatchObject({ behavior: 'allow' });
  expect(await blank(join(read, 'existing'))).toMatchObject({ behavior: 'deny' });
  expect(await blank(join(dir, 'existing'))).toMatchObject({ behavior: 'deny' });
  expect(input.requestApproval).toHaveBeenCalledOnce();
});
it.each(['delete_file', 'remove_file', 'rm', 'rmdir', 'unlink', 'trash_file'])(
  'requires deletion approval for MCP %s and checks every target',
  async (tool) => {
    input.bot.connections = ['filesystem'];
    input.requestApproval = vi.fn().mockResolvedValue(false);
    const sdk = await options();
    const name = 'mcp__filesystem__' + tool;
    const externalAction = /delete|remove|trash/.test(tool);
    const call = (paths: string[]) =>
      sdk.canUseTool!(
        name,
        { files: paths.map((path) => ({ path })) },
        { signal: input.signal, toolUseID: paths.join(','), requestId: 'r' },
      );
    expect(await call([join(work, 'old')])).toMatchObject({
      behavior: 'deny',
      message: externalAction
        ? 'The connector action was not approved.'
        : 'The user did not approve deletion.',
    });
    expect(input.requestApproval).toHaveBeenCalledWith(
      externalAction
        ? { title: 'filesystem: ' + tool, details: expect.any(String) }
        : expect.objectContaining({
            kind: 'file.delete',
            data: { command: expect.stringContaining(name), paths: [join(work, 'old')] },
          }),
    );
    expect(await call([join(full, 'old')])).toMatchObject({
      behavior: externalAction ? 'deny' : 'allow',
    });
    expect(await call([join(read, 'old')])).toMatchObject({ behavior: 'deny' });
    expect(await call([join(work, 'old'), join(dir, 'outside')])).toMatchObject({
      behavior: 'deny',
    });
    expect(input.requestApproval).toHaveBeenCalledTimes(externalAction ? 2 : 1);
  },
);
it('rechecks MCP deletion targets after approval', async () => {
  input.bot.connections = ['filesystem'];
  let answer!: (approved: boolean) => void;
  input.requestApproval = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  const sdk = await options();
  const pending = sdk.canUseTool!(
    'mcp__filesystem__trash_file',
    { path: join(work, 'old') },
    { signal: input.signal, toolUseID: 'mcp', requestId: 'r' },
  );
  await expect.poll(() => vi.mocked(input.requestApproval!).mock.calls.length).toBe(1);
  projects = projects.map((project) =>
    project.id === 'writer' ? { ...project, folders: [read] } : project,
  );
  answer(true);
  expect(await pending).toMatchObject({ behavior: 'deny' });
});
it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)(
  'uses Codex root permissions without project sandbox escalation: %s',
  async (sandbox) => {
    input.bot.engine = 'codex';
    input.bot.sandbox = sandbox;
    codex.start.mockReturnValue({ runStreamed: codex.run });
    codex.run.mockResolvedValue({
      events: (async function* () {
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        };
      })(),
    });
    await collect(new CodexEngine(context).run(input));
    expect(codex.start).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxMode: sandbox === 'danger-full-access' ? sandbox : 'workspace-write',
        additionalDirectories: [work, full],
      }),
    );
  },
);
it('uses Codex read-only mode when there are no write/full roots', async () => {
  input.bot.engine = 'codex';
  input.bot.projects = [{ project: 'reader', level: 'read' }];
  codex.start.mockReturnValue({ runStreamed: codex.run });
  codex.run.mockResolvedValue({
    events: (async function* () {
      yield {
        type: 'turn.completed',
        usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
      };
    })(),
  });
  await collect(new CodexEngine(context).run(input));
  expect(codex.start).toHaveBeenCalledWith(
    expect.objectContaining({ sandboxMode: 'read-only', additionalDirectories: [] }),
  );
});
it.each(['win32', 'linux', 'darwin'])(
  'allows ordinary Bash from Writer and Reader directories on %s',
  async (platform) => {
    input.bot.sandbox = 'workspace-write';
    input.bot.writeScope = [work];
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      for (const command of [
        'npm test',
        'git status',
        'ls',
        'node script.js',
        'python -m pytest',
        'grep "rm" notes.txt',
      ])
        expect(
          await allowClaudeTool(
            input.bot,
            'Bash',
            { command },
            undefined,
            undefined,
            effectiveAccess(input.bot, projects),
          ),
        ).toBe(true);
      expect(
        await allowClaudeTool(
          { ...input.bot, workdir: read },
          'Bash',
          { command: 'npm test' },
          undefined,
          undefined,
          effectiveAccess({ ...input.bot, workdir: read }, projects),
        ),
      ).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  },
);

it.each(['r""m a.txt', 'cmd /c "del a.txt"', 'powershell -Command "Remove-Item -Recurse a.txt"'])(
  'asks once for explicit wrapped/split Writer deletion in both permission paths: %s',
  async (command) => {
    input.requestApproval = vi.fn().mockResolvedValue(true);
    const sdk = await options();
    const hook = sdk.hooks!.PreToolUse![0].hooks[0];
    expect(
      await hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 's',
          transcript_path: '',
          cwd: work,
          tool_name: 'Bash',
          tool_input: { command },
          tool_use_id: 'wrapped',
        },
        'wrapped',
        { signal: input.signal },
      ),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    expect(
      await sdk.canUseTool!(
        'Bash',
        { command },
        {
          signal: input.signal,
          toolUseID: 'wrapped',
          requestId: 'r',
        },
      ),
    ).toMatchObject({ behavior: 'allow' });
    expect(input.requestApproval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'file.delete',
        data: { command, paths: [join(work, 'a.txt')] },
      }),
    );
  },
);

it('denies every find start and explicit exec target outside write roots, including the vault', async () => {
  const vault = join(dir, 'vault');
  await mkdir(vault);
  context.knowledgeDir = () => vault;
  input.requestApproval = vi.fn().mockResolvedValue(true);
  const sdk = await options();
  for (const path of [join(vault, 'x'), join(read, 'x'), join(dir, 'outside')])
    for (const command of [
      'find -P "' + path + '" -delete',
      'find -P . "' + path + '" -delete',
      'find . -exec rm "' + path + '" {} \\;',
    ])
      expect(
        await sdk.canUseTool!(
          'Bash',
          { command },
          {
            signal: input.signal,
            toolUseID: command,
            requestId: 'r',
          },
        ),
      ).toMatchObject({ behavior: 'deny' });
  expect(input.requestApproval).not.toHaveBeenCalled();
});

it('allows ordinary commands without approval and rechecks Bash grants after approval', async () => {
  input.requestApproval = vi.fn().mockResolvedValue(true);
  const sdk = await options();
  for (const command of [
    'npm test',
    'git status',
    'ls',
    'grep "rm" notes.txt',
    'git diff > out.txt',
  ])
    expect(
      await sdk.canUseTool!(
        'Bash',
        { command },
        {
          signal: input.signal,
          toolUseID: command,
          requestId: 'r',
        },
      ),
    ).toMatchObject({ behavior: 'allow' });
  expect(input.requestApproval).not.toHaveBeenCalled();
  input.requestApproval = vi.fn(async () => {
    projects = projects.filter((project) => project.id !== 'writer');
    return true;
  });
  expect(
    await sdk.canUseTool!(
      'Bash',
      { command: 'rm a.txt' },
      {
        signal: input.signal,
        toolUseID: 'revoked',
        requestId: 'r',
      },
    ),
  ).toMatchObject({ behavior: 'deny' });
  expect(input.requestApproval).toHaveBeenCalledOnce();
});
