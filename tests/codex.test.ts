import { translate } from '../src/shared/i18n';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { ThreadEvent } from '@openai/codex-sdk';
import { CodexEngine } from '../src/main/engines/codex';
import type { EngineContext, RunInput } from '../src/main/engines/types';
import { allowClaudeTool, allowsConnection, normalizeServer } from '../src/main/engines/scopes';
import { collect, removeTemporary, temporaryDirectory, testBot } from './helpers';

const mock = vi.hoisted(() => ({
  homedir: vi.fn(),
  runStreamed: vi.fn(),
  startThread: vi.fn(),
  resumeThread: vi.fn(),
  constructor: vi.fn(),
  mcpNames: vi.fn(),
}));
vi.mock('../src/main/engines/codex-mcp', () => ({ codexMcpNames: mock.mcpNames }));
vi.mock('node:os', () => ({ homedir: mock.homedir }));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: unknown) {
      mock.constructor(options);
    }
    startThread = mock.startThread;
    resumeThread = mock.resumeThread;
  },
}));
const context: EngineContext = {
  auth: () => ({ mode: 'local-cli' }),
  knowledgeDir: () => undefined,
};
const input = (): RunInput => ({
  bot: testBot(process.cwd(), { engine: 'codex', model: 'gpt-5.3-codex' }),
  conversationId: 'conversation',
  prompt: 'Hello',
  signal: new AbortController().signal,
});
function stream(events: ThreadEvent[]): void {
  mock.runStreamed.mockResolvedValue({
    events: (async function* () {
      yield* events;
    })(),
  });
}
let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  mock.mcpNames.mockResolvedValue([]);
  directory = await temporaryDirectory();
  vi.stubEnv('CODEX_HOME', directory);
  mock.homedir.mockReturnValue(directory);
  const thread = { id: 'codex-session', runStreamed: mock.runStreamed };
  mock.startThread.mockReturnValue(thread);
  mock.resumeThread.mockReturnValue(thread);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTemporary(directory);
});
it('cancels an active streamed turn using its AbortSignal', async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  mock.runStreamed.mockImplementation(
    async (_input: unknown, { signal }: { signal: AbortSignal }) => ({
      events: (async function* () {
        yield { type: 'turn.started' } as const;
        ready();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new Error('aborted');
      })(),
    }),
  );
  const engine = new CodexEngine(context);
  const result = collect(engine.run(input()));
  await started;
  engine.cancel('conversation');
  expect((await result).at(-1)).toMatchObject({ type: 'run.done', cancelled: true });
});
it('configures only team HTTP MCP, passes its token through env and revokes it after completion', async () => {
  const engine = new CodexEngine(context);
  let url = '';
  let token = '';
  mock.mcpNames.mockResolvedValue(['archived', 'penathon', 'team', 'a.b"quoted']);
  mock.runStreamed.mockImplementation(async () => {
    const options = mock.constructor.mock.calls[0][0];
    const config = options.configOverrides[0] as string;
    url = /url="([^"]+)"/.exec(config)![1];
    token = options.env.PENATHON_MCP_TOKEN;
    expect(config).toContain('mcp_servers={team={');
    expect(config).toContain('default_tools_approval_mode="approve"');
    expect(config.match(/default_tools_approval_mode/g)).toHaveLength(1);
    expect(mock.startThread.mock.calls[0][0]).toMatchObject({
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      networkAccessEnabled: false,
    });
    expect(options.configOverrides).toHaveLength(1);
    expect(config).toContain('"archived"={enabled=false}');
    expect(config).toContain('"penathon"={enabled=false}');
    expect(config).not.toContain('codex_app');
    expect(config).toContain('"a.b\\"quoted"={enabled=false}');
    expect(config).toContain('bearer_token_env_var="PENATHON_MCP_TOKEN"');
    expect(config).not.toContain(token);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'remember', arguments: { text: 'Remember me' } },
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).result.isError).not.toBe(true);
    return {
      events: (async function* () {
        yield {
          type: 'item.completed',
          item: {
            id: 'token-output',
            type: 'command_execution',
            command: 'echo ' + token,
            aggregated_output: 'x'.repeat(1990) + token,
            status: 'completed',
            exit_code: 0,
          },
        };
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
        };
      })(),
    };
  });
  const callTool = vi.fn().mockResolvedValue('Saved');
  const addRedactionSecret = vi.fn();
  try {
    const events = await collect(
      engine.run({ ...input(), callTool, addRedactionSecret, runId: 'run-test' }),
    );
    expect(addRedactionSecret).toHaveBeenCalledExactlyOnceWith(token);
    expect(addRedactionSecret.mock.invocationCallOrder[0]).toBeLessThan(
      mock.constructor.mock.invocationCallOrder[0],
    );
    expect(events.at(-1)?.type).toBe('run.done');
    expect(JSON.stringify(events)).not.toContain(token.slice(0, 10));
    expect(events).toContainEqual({
      type: 'tool.end',
      toolId: 'token-output',
      resultSummary: 'x'.repeat(1990) + '[REDACTED]',
      error: false,
    });
    expect(callTool).toHaveBeenCalledWith('remember', { text: 'Remember me' });
    expect(mock.runStreamed.mock.calls[0][0]).not.toContain('bu motorda kullanılamaz');
    expect((await fetch(url, { headers: { Authorization: 'Bearer ' + token } })).status).toBe(401);
  } finally {
    await engine.close();
  }
});
it('maps incremental/full messages, command/search/MCP/file changes, completion usage and thread resume', async () => {
  stream([
    { type: 'thread.started', thread_id: 'codex-session' },
    { type: 'turn.started' },
    { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'Hel' } },
    { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'Hello' } },
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Hello' } },
    {
      type: 'item.started',
      item: {
        id: 'cmd',
        type: 'command_execution',
        command: 'echo test',
        aggregated_output: '',
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'cmd',
        type: 'command_execution',
        command: 'echo test',
        aggregated_output: 'test',
        exit_code: 1,
        status: 'completed',
      },
    },
    { type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'topic' } },
    {
      type: 'item.completed',
      item: {
        id: 'mcp',
        type: 'mcp_tool_call',
        server: 'test',
        tool: 'read',
        arguments: {},
        status: 'failed',
        error: { message: 'denied' },
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'file',
        type: 'file_change',
        status: 'completed',
        changes: [{ path: 'a.ts', kind: 'update' }],
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 15,
        output_tokens: 3,
        cached_input_tokens: 2,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 1,
      },
    },
  ]);
  const events = await collect(
    new CodexEngine(context).run({ ...input(), resumeToken: 'previous' }),
  );
  expect(
    events.filter((event) => event.type === 'message.delta').map((event) => event.text),
  ).toEqual(['Hel', 'lo']);
  expect(events).toContainEqual({ type: 'message.done', messageId: 'm1', text: 'Hello' });
  expect(events.filter((event) => event.type === 'tool.start').map((event) => event.kind)).toEqual([
    'command',
    'search',
    'mcp',
    'file_write',
  ]);
  expect(events).toContainEqual({
    type: 'tool.end',
    toolId: 'mcp',
    resultSummary: 'denied',
    error: true,
  });
  expect(events).toContainEqual({
    type: 'tool.end',
    toolId: 'cmd',
    resultSummary: 'test',
    error: true,
  });
  expect(events.at(-1)).toMatchObject({
    type: 'run.done',
    resumeToken: 'codex-session',
    usage: { inputTokens: 15, outputTokens: 3, cachedInputTokens: 2 },
  });
  expect(mock.resumeThread).toHaveBeenCalledWith(
    'previous',
    expect.objectContaining({
      modelReasoningEffort: 'medium',
      workingDirectory: process.cwd(),
      sandboxMode: 'workspace-write',
      additionalDirectories: [process.cwd()],
      approvalPolicy: 'never',
    }),
  );
  expect(mock.runStreamed).toHaveBeenCalledWith(
    expect.stringContaining('Help with the task.'),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
it('maps failures, thrown errors and cancellation; starts new threads and passes API key only in memory', async () => {
  const engine = new CodexEngine({
    ...context,
    auth: () => ({ mode: 'api-key', apiKey: 'test-only-key' }),
  });
  stream([{ type: 'turn.failed', error: { message: 'failed' } }]);
  expect((await collect(engine.run(input()))).at(-1)).toMatchObject({
    type: 'run.error',
    message: 'failed',
  });
  expect(mock.startThread).toHaveBeenCalledOnce();
  expect(mock.constructor).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: 'test-only-key' }),
  );
  expect(mock.constructor.mock.calls[0][0].env.CODEX_API_KEY).toBeUndefined();
  stream([{ type: 'error', message: 'stream error' }]);
  expect((await collect(engine.run(input()))).at(-1)).toMatchObject({
    type: 'run.error',
    message: 'stream error',
  });
  mock.runStreamed.mockRejectedValue(new Error('failed spawn'));
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
it('does not probe accounts from status/models', async () => {
  const engine = new CodexEngine(context);
  expect(await engine.checkAuth()).toMatchObject({ state: 'unverified' });
  expect(await engine.models()).not.toHaveLength(0);
  expect(mock.constructor).not.toHaveBeenCalled();
});

it('reads visible models from CODEX_HOME without starting an SDK or reading credentials', async () => {
  await writeFile(
    join(directory, 'models_cache.json'),
    JSON.stringify({
      fetched_at: '2026-10-28',
      models: [
        { slug: 'available', display_name: 'Available model', visibility: 'list' },
        { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'unlisted', visibility: 'none' },
        { slug: 'alias', visibility: 'list' },
      ],
    }),
  );
  const engine = new CodexEngine(context);
  expect(await engine.models()).toEqual([
    { id: 'default', label: 'Default' },
    { id: 'available', label: 'Available model' },
    { id: 'alias', label: 'alias' },
  ]);
  expect(mock.constructor).not.toHaveBeenCalled();
});
it('uses ~/.codex when CODEX_HOME is absent', async () => {
  vi.stubEnv('CODEX_HOME', undefined);
  await mkdir(join(directory, '.codex'));
  await writeFile(
    join(directory, '.codex', 'models_cache.json'),
    JSON.stringify({
      models: [{ slug: 'home-model', visibility: 'list' }],
    }),
  );
  expect(await new CodexEngine(context).models()).toEqual([
    { id: 'default', label: 'Default' },
    { id: 'home-model', label: 'home-model' },
  ]);
});
it.each([
  undefined,
  '{',
  '{}',
  '{"models":null}',
  '{"models":[{"slug":4,"visibility":"list"}]}',
  '{"models":[]}',
])('offers only the default for a missing, malformed or empty cache: %s', async (contents) => {
  if (contents !== undefined) await writeFile(join(directory, 'models_cache.json'), contents);
  expect(await new CodexEngine(context).models()).toEqual([{ id: 'default', label: 'Default' }]);
});
it.each(['', 'default', 'explicit-model'])(
  'passes model only when explicitly selected: %s',
  async (model) => {
    stream([{ type: 'turn.failed', error: { message: 'test failure' } }]);
    await collect(
      new CodexEngine(context).run({
        ...input(),
        bot: testBot(process.cwd(), { engine: 'codex', model }),
      }),
    );
    const options = mock.startThread.mock.calls[0][0];
    if (model && model !== 'default') expect(options.model).toBe(model);
    else expect(options).not.toHaveProperty('model');
  },
);
it('maps non-fatal SDK error items to warnings and lets the turn complete', async () => {
  const message = 'Model metadata for custom not found. Defaulting to fallback metadata';
  stream([
    { type: 'item.completed', item: { id: 'warning', type: 'error', message } },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  ]);
  const events = await collect(new CodexEngine(context).run(input()));
  expect(events).toContainEqual({ type: 'notice', level: 'warning', message });
  expect(events.some((event) => event.type === 'tool.end' || event.type === 'run.error')).toBe(
    false,
  );
  expect(events.at(-1)?.type).toBe('run.done');
});
it.each(['error', 'turn.failed', 'throw'] as const)(
  'classifies authentication failure from %s',
  async (kind) => {
    const message = '401 Unauthorized: authentication token expired. Run codex login';
    if (kind === 'throw') mock.runStreamed.mockRejectedValue(new Error(message));
    else stream([kind === 'error' ? { type: kind, message } : { type: kind, error: { message } }]);
    expect((await collect(new CodexEngine(context).run(input()))).at(-1)).toEqual({
      type: 'run.error',
      code: 'auth',
      message: 'errors.codexAuth',
    });
  },
);
it.each(['done', 'error'] as const)(
  'emits one terminal event/status even if SDK cleanup throws after %s',
  async (ending) => {
    mock.runStreamed.mockResolvedValue({
      events: (async function* () {
        try {
          if (ending === 'done')
            yield {
              type: 'turn.completed',
              usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
            };
          else yield { type: 'error', message: 'first failure' };
          yield { type: 'turn.failed', error: { message: 'duplicate failure' } };
        } finally {
          await Promise.reject(new Error('cleanup failure'));
        }
      })(),
    });
    const events = await collect(new CodexEngine(context).run(input()));
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

it('gives only Chief the knowledge directory and warns when legacy read paths are removed', async () => {
  const vault = join(directory, 'vault');
  stream([
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  ]);
  const engine = new CodexEngine({
    ...context,
    knowledgeDir: () => vault,
    profile: () => ({ name: 'Alex', address: 'Captain' }),
  });
  const chief = testBot(directory, { engine: 'codex', id: 'chief', system: true });
  await collect(engine.run({ ...input(), bot: chief, memory: 'Prefer tea' }));
  expect(mock.constructor.mock.calls[0][0].configOverrides).toEqual(['mcp_servers={}']);
  expect(mock.startThread.mock.calls[0][0].additionalDirectories).toEqual([directory, vault]);
  expect(mock.runStreamed.mock.calls[0][0]).toContain('Prefer tea');
  expect(mock.runStreamed.mock.calls[0][0]).toContain('Alex');
  expect(mock.runStreamed.mock.calls[0][0]).toContain(vault);
  vi.clearAllMocks();
  const thread = { id: 's', runStreamed: mock.runStreamed };
  mock.startThread.mockReturnValue(thread);
  stream([
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  ]);
  const project = join(directory, 'project');
  const events = await collect(
    engine.run({
      ...input(),
      bot: testBot(project, {
        engine: 'codex',
        readScope: [vault],
        writeScope: [project],
      }),
      memory: 'Own memory',
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: 'run.done' });
  expect(events).toContainEqual({
    type: 'notice',
    level: 'warning',
    message: 'notice.knowledgePathsRemoved',
  });
  expect(mock.startThread).toHaveBeenCalledOnce();
  expect(mock.startThread.mock.calls[0][0].additionalDirectories).toEqual([project]);
  expect(mock.runStreamed.mock.calls[0][0]).toContain('Own memory');
  expect(mock.runStreamed.mock.calls[0][0]).toContain('Bilgi klasörüne erişme.');
  expect(mock.runStreamed.mock.calls[0][0]).not.toContain(vault);
});

it.each([
  'workdir-ancestor',
  'workdir-equal',
  'workdir-inside',
  'write-ancestor',
  'write-equal',
  'write-inside',
])('rejects overlapping Codex writable roots before starting the SDK: %s', async (kind) => {
  const vault = join(directory, 'vault');
  const project = join(directory, 'project');
  const roots = { ancestor: directory, equal: vault, inside: join(vault, 'nested') };
  const [field, relation] = kind.split('-');
  const overlap = roots[relation as keyof typeof roots];
  const alias = (process.platform === 'win32' ? overlap.toUpperCase() : overlap) + sep;
  const bot = testBot(project, {
    engine: 'codex',
    ...(field === 'workdir' ? { workdir: alias } : { writeScope: [alias] }),
  });
  const engine = new CodexEngine({ ...context, knowledgeDir: () => vault + sep });
  expect((await collect(engine.run({ ...input(), bot }))).at(-1)).toMatchObject({
    type: 'run.error',
    message: expect.stringContaining(translate('en', 'errors.knowledgeScope') + ': ' + alias),
  });
  expect(mock.constructor).not.toHaveBeenCalled();
  expect(mock.runStreamed).not.toHaveBeenCalled();
});

it.each([[], ['mail_api'], ['*']])(
  'uses the same normalized connection permission as Claude without replacing transports: %j',
  async (...connections: string[]) => {
    const names = ['mail.api', 'drive', 'mail.api_extra'];
    mock.mcpNames.mockResolvedValue([...names, 'team']);
    stream([{ type: 'turn.failed', error: { message: 'test failure' } }]);
    const bot = testBot(directory, { engine: 'codex', connections });
    await collect(new CodexEngine(context).run({ ...input(), bot }));
    const config = mock.constructor.mock.calls[0][0].configOverrides[0] as string;
    for (const name of names) {
      const allowed = allowsConnection(connections, name);
      expect(config).toContain(`"${name}"={enabled=${allowed}}`);
      expect(await allowClaudeTool(bot, 'mcp__' + normalizeServer(name) + '__read', {})).toBe(
        allowed,
      );
    }
    expect(config).toContain('"team"={enabled=false}');
    expect(config).not.toMatch(/url|command|args|env/);
  },
);
it.each([false, true])('passes bot network permission to Codex: %s', async (network) => {
  stream([{ type: 'turn.failed', error: { message: 'test failure' } }]);
  await collect(
    new CodexEngine(context).run({
      ...input(),
      bot: testBot(directory, { engine: 'codex', network }),
    }),
  );
  expect(mock.startThread).toHaveBeenCalledWith(
    expect.objectContaining({ networkAccessEnabled: network }),
  );
});
it('lists config-defined Codex connections without starting the engine', async () => {
  mock.mcpNames.mockResolvedValue(['mail', 'team', 'filesystem']);
  expect(await new CodexEngine(context).connections()).toEqual([
    { name: 'mail', source: 'codex', status: 'unknown' },
    { name: 'filesystem', source: 'codex', status: 'unknown' },
  ]);
  expect(mock.constructor).not.toHaveBeenCalled();
});
