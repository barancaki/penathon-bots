import { beforeEach, expect, it, vi } from 'vitest';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';
import { allowClaudeTool } from '../src/main/engines/scopes';
import { ClaudeEngine } from '../src/main/engines/claude';
import type { EngineContext, RunInput } from '../src/main/engines/types';
import { collect, testBot } from './helpers';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn(),
}));
const context: EngineContext = {
  auth: () => ({ mode: 'local-cli' }),
  knowledgeDir: () => undefined,
};
const input = (): RunInput => ({
  bot: testBot(),
  conversationId: 'conversation',
  prompt: 'Hello',
  signal: new AbortController().signal,
});
function mockQuery(messages: unknown[]): void {
  vi.mocked(query).mockReturnValue(
    (async function* () {
      for (const message of messages) yield message as SDKMessage;
    })() as ReturnType<typeof query>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
});
it('keeps the full raw Bash command for write classification instead of truncating its summary', async () => {
  const command = 'echo ' + 'x'.repeat(2100) + ' > changed.md';
  mockQuery([
    {
      type: 'assistant',
      message: {
        id: 'command',
        content: [{ type: 'tool_use', id: 'shell', name: 'Bash', input: { command } }],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'test',
      duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ]);
  const events = await collect(new ClaudeEngine(context).run(input()));
  expect(events).toContainEqual({
    type: 'tool.start',
    toolId: 'shell',
    kind: 'command',
    title: 'Bash',
    argsSummary: command,
  });
});
it('cancels an active SDK query using its abort controller', async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  vi.mocked(query).mockImplementation(
    ({ options }) =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'cancel-session' } as SDKMessage;
        ready();
        await new Promise<void>((resolve) =>
          options!.abortController!.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        throw new Error('aborted');
      })() as ReturnType<typeof query>,
  );
  const engine = new ClaudeEngine(context);
  const result = collect(engine.run(input()));
  await started;
  engine.cancel('conversation');
  expect((await result).at(-1)).toMatchObject({ type: 'run.done', cancelled: true });
});
it('maps text deltas/final text, tools, structured diffs, usage and session IDs without duplicate deltas', async () => {
  mockQuery([
    { type: 'system', subtype: 'init', session_id: 'claude-session' },
    {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'm1' } },
    },
    {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm1',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'updated' }] },
      tool_use_result: {
        filePath: 'a.ts',
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'claude-session',
      duration_ms: 25,
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 2 },
      total_cost_usd: 0.01,
    },
  ]);
  const engine = new ClaudeEngine(context);
  const events = await collect(engine.run({ ...input(), resumeToken: 'previous-session' }));
  expect(events.filter((event) => event.type === 'message.delta')).toEqual([
    { type: 'message.delta', messageId: 'm1', text: 'Hello' },
  ]);
  expect(events).toContainEqual({ type: 'message.done', messageId: 'm1', text: 'Hello' });
  expect(events).toContainEqual({
    type: 'tool.start',
    toolId: 't1',
    kind: 'file_write',
    title: 'Edit',
    argsSummary: '{"file_path":"a.ts"}',
    files: ['a.ts'],
  });
  expect(events).toContainEqual({
    type: 'tool.end',
    toolId: 't1',
    resultSummary: 'updated',
    error: false,
  });
  expect(events).toContainEqual({
    type: 'diff',
    file: 'a.ts',
    unifiedDiff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
  });
  expect(events.at(-1)).toEqual({
    type: 'run.done',
    resumeToken: 'claude-session',
    durationMs: 25,
    usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2, costUsd: 0.01 },
  });
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        cwd: process.cwd(),
        resume: 'previous-session',
        model: 'sonnet',
        effort: 'medium',
        thinking: { type: 'adaptive' },
        systemPrompt: expect.objectContaining({
          preset: 'claude_code',
          append: expect.stringContaining('Help with the task.'),
        }),
      }),
    }),
  );
});
it('maps tool failures and SDK result failures and does not emit done on failure', async () => {
  mockQuery([
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'denied', is_error: true }],
      },
    },
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['failed'] },
  ]);
  const events = await collect(new ClaudeEngine(context).run(input()));
  expect(events).toContainEqual({
    type: 'tool.end',
    toolId: 't',
    resultSummary: 'denied',
    error: true,
  });
  expect(events.at(-1)).toMatchObject({
    type: 'run.error',
    code: 'claude',
    message: 'failed',
  });
  expect(events.some((event) => event.type === 'run.done')).toBe(false);
});
it('handles plain assistant messages, thrown errors, cancellation and API-key mode', async () => {
  mockQuery([
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'plain', content: [{ type: 'text', text: 'Hi' }] },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    },
  ]);
  const engine = new ClaudeEngine({
    ...context,
    auth: () => ({ mode: 'api-key', apiKey: 'test-only-key' }),
  });
  expect(
    (await collect(engine.run(input()))).filter((event) => event.type === 'message.delta'),
  ).toHaveLength(1);
  expect(vi.mocked(query).mock.calls[0][0].options?.env?.ANTHROPIC_API_KEY).toBe('test-only-key');
  vi.mocked(query).mockImplementation(() => {
    throw new Error('failed spawn');
  });
  expect((await collect(engine.run(input()))).at(-1)).toMatchObject({
    type: 'run.error',
    message: 'failed spawn',
  });
  const controller = new AbortController();
  controller.abort();
  expect(
    (await collect(engine.run({ ...input(), signal: controller.signal }))).at(-1),
  ).toMatchObject({ type: 'run.done', cancelled: true });
});

it.each(['', 'default', 'explicit-model'])(
  'passes model only when explicitly selected: %s',
  async (model) => {
    mockQuery([
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['test failure'],
      },
    ]);
    await collect(
      new ClaudeEngine(context).run({ ...input(), bot: testBot(process.cwd(), { model }) }),
    );
    const options = vi.mocked(query).mock.calls[0][0].options;
    if (model && model !== 'default') expect(options?.model).toBe(model);
    else expect(options).not.toHaveProperty('model');
  },
);
it.each([
  ['Authentication failed: OAuth token expired', 'auth', 'errors.claudeAuth'],
  ['Not logged in · Please run /login', 'auth', 'errors.claudeAuth'],
  ['authentication_error: access denied', 'auth', 'errors.claudeAuth'],
  ['Something failed', 'claude', 'Something failed'],
])(
  'classifies is_error even when the SDK subtype is success: %s',
  async (result, code, message) => {
    mockQuery([{ type: 'result', subtype: 'success', is_error: true, result }]);
    expect((await collect(new ClaudeEngine(context).run(input()))).at(-1)).toEqual({
      type: 'run.error',
      code,
      message,
    });
  },
);
it('classifies thrown authentication failures', async () => {
  vi.mocked(query).mockImplementation(() => {
    throw new Error('401 Unauthorized');
  });
  expect((await collect(new ClaudeEngine(context).run(input()))).at(-1)).toEqual({
    type: 'run.error',
    code: 'auth',
    message: 'errors.claudeAuth',
  });
});
it.each(['done', 'error'] as const)(
  'emits one terminal event/status even if SDK cleanup throws after %s',
  async (ending) => {
    vi.mocked(query).mockReturnValue(
      (async function* () {
        try {
          yield (ending === 'done'
            ? {
                type: 'result',
                subtype: 'success',
                is_error: false,
                duration_ms: 1,
                usage: { input_tokens: 0, output_tokens: 0 },
                total_cost_usd: 0,
              }
            : {
                type: 'result',
                subtype: 'success',
                is_error: true,
                result: 'first failure',
              }) as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            is_error: true,
            result: 'duplicate failure',
          } as SDKMessage;
        } finally {
          await Promise.reject(new Error('cleanup failure'));
        }
      })() as ReturnType<typeof query>,
    );
    const events = await collect(new ClaudeEngine(context).run(input()));
    expect(
      events.filter((event) => event.type === 'run.done' || event.type === 'run.error'),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.type === 'status' && ['done', 'error', 'idle'].includes(event.status),
      ),
    ).toEqual([{ type: 'status', status: ending }]);
  },
);

it('enforces connection permissions in both SDK permission paths and attaches the app server', async () => {
  mockQuery([
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    },
  ]);
  const run = input();
  run.bot.connections = ['claude.ai Gmail'];
  await collect(new ClaudeEngine(context).run(run));
  const options = vi.mocked(query).mock.calls[0][0].options!;
  expect(options.settingSources).toEqual([]);
  expect(options.mcpServers?.team).toMatchObject({ type: 'sdk', name: 'team' });
  const hook = options.hooks!.PreToolUse![0].hooks[0];
  for (const [name, allowed] of [
    ['mcp__claude_ai_Gmail__read', true],
    ['mcp__Drive__read', false],
    ['mcp__team__list_bots', true],
  ] as const) {
    expect(
      await options.canUseTool!(
        name,
        {},
        { signal: run.signal, toolUseID: 't', requestId: 'request' },
      ),
    ).toMatchObject({ behavior: allowed ? 'allow' : 'deny' });
    expect(
      await hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 's',
          transcript_path: '',
          cwd: process.cwd(),
          tool_name: name,
          tool_input: {},
          tool_use_id: 't',
        },
        't',
        { signal: run.signal },
      ),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: allowed ? 'allow' : 'deny' } });
  }
});
it('lets team deletions reach app permissions through both SDK permission paths', async () => {
  mockQuery([]);
  const requestApproval = vi.fn().mockResolvedValue(true);
  const run = {
    ...input(),
    bot: testBot(process.cwd(), { sandbox: 'read-only', writeScope: [] }),
    requestApproval,
  };
  await collect(new ClaudeEngine(context).run(run));
  const options = vi.mocked(query).mock.calls[0][0].options!;
  const hook = options.hooks!.PreToolUse![0].hooks[0];
  for (const server of [undefined, { name: 'team', source: 'sdk' }]) {
    const name = 'mcp__team__delete_routine';
    const args = { botId: 'worker', routineId: 'routine' };
    expect(
      await options.canUseTool!(name, args, {
        signal: run.signal,
        toolUseID: 'routine',
        requestId: 'request',
        mcpServer: server,
      }),
    ).toMatchObject({ behavior: 'allow' });
    expect(
      await hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 's',
          transcript_path: '',
          cwd: process.cwd(),
          tool_name: name,
          tool_input: args,
          tool_use_id: 'routine',
          mcp_server: server,
        },
        'routine',
        { signal: run.signal },
      ),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
  }
  expect(requestApproval).not.toHaveBeenCalled();
});

it('caches normalized MCP status metadata and tool counts from initialization', async () => {
  mockQuery([
    {
      type: 'system',
      subtype: 'init',
      session_id: 's',
      tools: ['mcp__claude_ai_Gmail__read', 'mcp__team__remember'],
      mcp_servers: [
        { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' },
        { name: 'team', status: 'connected', source: 'sdk' },
      ],
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    },
  ]);
  const engine = new ClaudeEngine(context);
  await collect(engine.run(input()));
  expect(await engine.connections()).toEqual([
    { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai', toolCount: 1 },
    { name: 'team', status: 'connected', source: 'app', toolCount: 1 },
  ]);
  expect(query).toHaveBeenCalledTimes(1);
});
it('probes MCP status without sending a user prompt, caches it and closes the probe', async () => {
  const close = vi.fn();
  const status = vi.fn().mockResolvedValue([
    { name: 'team', source: 'sdk', status: 'connected', tools: [{ name: 'remember' }] },
    { name: 'chrome-devtools', source: 'user', status: 'needs-auth', tools: [] },
  ]);
  vi.mocked(query).mockReturnValue(
    Object.assign(
      (async function* () {
        yield {} as SDKMessage;
      })(),
      { mcpServerStatus: status, close },
    ) as unknown as ReturnType<typeof query>,
  );
  const engine = new ClaudeEngine(context);
  expect(await engine.connections()).toEqual([
    { name: 'team', source: 'app', status: 'connected', toolCount: 1 },
    { name: 'chrome-devtools', source: 'user', status: 'needs-auth', toolCount: 0 },
  ]);
  const request = vi.mocked(query).mock.calls[0][0];
  expect(typeof request.prompt).toBe('object');
  if (typeof request.prompt !== 'string')
    expect(await request.prompt[Symbol.asyncIterator]().next()).toEqual({
      done: true,
      value: undefined,
    });
  expect(request.options?.persistSession).toBe(false);
  expect(close).toHaveBeenCalledOnce();
  await engine.connections();
  expect(query).toHaveBeenCalledTimes(1);
  await engine.connections(true);
  expect(query).toHaveBeenCalledTimes(2);
});
it('returns an empty connection list and logs discovery failure', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(query).mockImplementation(() => {
    throw new Error('probe failed');
  });
  try {
    expect(await new ClaudeEngine(context).connections(true)).toEqual([]);
    expect(warning).toHaveBeenCalledWith('Claude connection discovery failed:', 'probe failed');
  } finally {
    warning.mockRestore();
  }
});

it.each([false, true])(
  'exposes and authorizes Claude web tools only when network is %s',
  async (network) => {
    mockQuery([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const bot = testBot(process.cwd(), { network });
    await collect(new ClaudeEngine(context).run({ ...input(), bot }));
    const options = vi.mocked(query).mock.calls[0][0].options!;
    expect(options.tools).toEqual([
      'Read',
      'Write',
      'Edit',
      'Grep',
      'Glob',
      'Bash',
      ...(network ? ['WebFetch', 'WebSearch'] : []),
    ]);
    for (const tool of ['WebFetch', 'WebSearch']) {
      expect(await allowClaudeTool(bot, tool, {})).toBe(network);
      expect(
        await options.canUseTool!(
          tool,
          {},
          { signal: new AbortController().signal, toolUseID: tool, requestId: tool },
        ),
      ).toMatchObject({
        behavior: network ? 'allow' : 'deny',
      });
    }
  },
);
it('warns when legacy vault read paths are stripped before starting Claude', async () => {
  mockQuery([
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  ]);
  const root = process.cwd();
  const vault = join(root, 'vault');
  const project = join(root, 'project');
  const bot = testBot(project, { readScope: [root, vault, join(vault, 'nested'), project] });
  const events = await collect(
    new ClaudeEngine({ ...context, knowledgeDir: () => vault }).run({ ...input(), bot }),
  );
  expect(events).toContainEqual({
    type: 'notice',
    level: 'warning',
    message: 'notice.knowledgePathsRemoved',
  });
  expect(events.at(-1)?.type).toBe('run.done');
  expect(vi.mocked(query).mock.calls[0][0].options!.additionalDirectories).toEqual([project]);
});
