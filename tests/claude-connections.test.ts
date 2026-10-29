import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  query,
  type McpServerStatus,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeEngine } from '../src/main/engines/claude';
import { connectorSummary, mcpSecrets, userMcpServers } from '../src/main/engines/claude-mcp';
import { allowClaudeTool } from '../src/main/engines/scopes';
import { Approvals } from '../src/main/bots/approvals';
import type { BotEvent } from '../src/shared/events';
import type { EngineContext, RunInput } from '../src/main/engines/types';
import { collect, testBot } from './helpers';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn(),
}));
let configDir: string;
const context: EngineContext = {
  auth: () => ({ mode: 'local-cli' }),
  knowledgeDir: () => undefined,
};
const input = (connections: string[] = []): RunInput => ({
  bot: testBot(process.cwd(), { connections }),
  conversationId: 'c',
  prompt: 'Hello',
  signal: new AbortController().signal,
});
const status = (name: string, state = 'connected') => ({ name, status: state }) as McpServerStatus;
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1,
  usage: { input_tokens: 0, output_tokens: 0 },
} as SDKMessage;

function mockStream(mcpServerStatus = vi.fn().mockResolvedValue([])) {
  const sent: SDKUserMessage[] = [];
  const close = vi.fn();
  let started!: () => void;
  const startedQuery = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(query).mockImplementation(({ prompt }) => {
    const first =
      typeof prompt === 'string'
        ? Promise.resolve()
        : prompt[Symbol.asyncIterator]()
            .next()
            .then((value) => {
              if (!value.done) sent.push(value.value);
            });
    started();
    return Object.assign(
      (async function* () {
        await first;
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 's',
          mcp_servers: [],
        } as unknown as SDKMessage;
        yield result;
      })(),
      { mcpServerStatus, close },
    ) as unknown as ReturnType<typeof query>;
  });
  return { sent, close, startedQuery, mcpServerStatus };
}
beforeEach(async () => {
  vi.clearAllMocks();
  configDir = await mkdtemp(join(tmpdir(), 'penathon-connectors-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('does not cache the first empty status and waits through pending until connected', async () => {
  vi.useFakeTimers();
  const sdk = mockStream(
    vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([status('Gmail', 'pending')])
      .mockResolvedValue([status('Gmail')]),
  );
  const engine = new ClaudeEngine(context);
  let resolved = false;
  const discovery = engine.connections().then((value) => {
    resolved = true;
    return value;
  });
  await sdk.startedQuery;
  await vi.advanceTimersByTimeAsync(0);
  const simultaneous = engine.connections();
  expect(resolved).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(resolved).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(await discovery).toEqual([{ name: 'Gmail', status: 'connected', source: 'other' }]);
  expect(await simultaneous).toEqual(await engine.connections());
  expect(query).toHaveBeenCalledOnce();
  expect(sdk.mcpServerStatus).toHaveBeenCalledTimes(3);
  expect(sdk.close).toHaveBeenCalledOnce();
});

it.each(['empty', 'pending', 'stalled'])(
  'returns the latest status after the 20 second probe deadline: %s',
  async (mode) => {
    vi.useFakeTimers();
    const pending = [status('Gmail', 'pending')];
    const check = vi.fn().mockResolvedValue(mode === 'empty' ? [] : pending);
    if (mode === 'stalled')
      check.mockResolvedValueOnce(pending).mockImplementation(() => new Promise(() => {}));
    const sdk = mockStream(check);
    const engine = new ClaudeEngine(context);
    const discovery = engine.connections();
    await sdk.startedQuery;
    await vi.advanceTimersByTimeAsync(20000);
    expect(await discovery).toEqual(
      mode === 'empty' ? [] : [{ name: 'Gmail', status: 'pending', source: 'other' }],
    );
    await engine.connections();
    expect(query).toHaveBeenCalledOnce();
    expect(sdk.close).toHaveBeenCalledOnce();
  },
);

it.each([undefined, 'previous-session'])(
  'holds the first message for permitted connectors, including resume %s',
  async (resumeToken) => {
    vi.useFakeTimers();
    const sdk = mockStream(
      vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([status('Gmail', 'pending'), status('unpermitted', 'pending')])
        .mockResolvedValue([status('Gmail'), status('unpermitted', 'pending')]),
    );
    const events: BotEvent[] = [];
    const running = (async () => {
      for await (const event of new ClaudeEngine(context).run({ ...input(['Gmail']), resumeToken }))
        events.push(event);
    })();
    await sdk.startedQuery;
    await vi.advanceTimersByTimeAsync(500);
    expect(sdk.sent).toEqual([]);
    expect(events).toContainEqual({ type: 'status', status: 'thinking' });
    expect(events).toContainEqual({
      type: 'notice',
      level: 'info',
      message: 'notice.connectorsWarming',
    });
    await vi.advanceTimersByTimeAsync(500);
    await running;
    expect(sdk.sent).toEqual([
      expect.objectContaining({ message: { role: 'user', content: 'Hello' } }),
    ]);
    expect(vi.mocked(query).mock.calls[0][0].options?.resume).toBe(resumeToken);
    expect(events.at(-1)).toMatchObject({ type: 'run.done' });
  },
);

it.each(['Gmail', '*'])(
  'sends the message after the 15 second run deadline for %s',
  async (connection) => {
    vi.useFakeTimers();
    const sdk = mockStream(vi.fn().mockResolvedValue([status('team'), status('Gmail', 'pending')]));
    const running = collect(new ClaudeEngine(context).run(input([connection])));
    await sdk.startedQuery;
    await vi.advanceTimersByTimeAsync(14999);
    expect(sdk.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect((await running).at(-1)).toMatchObject({ type: 'run.done' });
    expect(sdk.sent).toHaveLength(1);
  },
);

it('does not wait or use streaming input when the bot has no connections', async () => {
  const sdk = mockStream();
  const events = await collect(new ClaudeEngine(context).run(input()));
  expect(vi.mocked(query).mock.calls[0][0].prompt).toBe('Hello');
  expect(sdk.mcpServerStatus).not.toHaveBeenCalled();
  expect(events.some((event) => event.type === 'notice')).toBe(false);
});

it('keeps discovered connections when a run reports only its permitted servers', async () => {
  mockStream(vi.fn().mockResolvedValue([status('Gmail'), status('penathon')]));
  const engine = new ClaudeEngine(context);
  await engine.connections();
  mockStream(vi.fn().mockResolvedValue([status('Gmail')]));
  await collect(engine.run(input(['Gmail'])));
  expect((await engine.connections()).map((connection) => connection.name)).toEqual([
    'penathon',
    'Gmail',
  ]);
});

it('cancels promptly during connector warmup without submitting a user message', async () => {
  const sdk = mockStream(vi.fn().mockImplementation(() => new Promise(() => {})));
  const engine = new ClaudeEngine(context);
  const running = collect(engine.run(input(['Gmail'])));
  await sdk.startedQuery;
  engine.cancel('c');
  expect((await running).at(-1)).toMatchObject({ type: 'run.done', cancelled: true });
  expect(sdk.sent).toEqual([]);
});

it.each([false, true])(
  'reads only global and current workdir MCPs with custom config dir %s',
  async (custom) => {
    if (!custom) {
      vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
      vi.stubEnv('HOME', configDir);
      vi.stubEnv('USERPROFILE', configDir);
    }
    const definitions = {
      'chrome-devtools': { command: 'node', args: ['chrome.js'], env: { TOKEN: 'fixture-only' } },
      penathon: {
        type: 'http',
        url: 'https://example.invalid/crm',
        headers: { Authorization: 'Bearer fixture-only' },
      },
    };
    const override = { type: 'sse', url: 'https://example.invalid/events' };
    await writeFile(
      join(configDir, '.claude.json'),
      JSON.stringify({
        mcpServers: definitions,
        projects: {
          [process.cwd().replaceAll('\\', '/')]: { mcpServers: { penathon: override } },
          '/different-project': { mcpServers: { unrelated: definitions.penathon } },
        },
      }),
    );
    const plugins = join(configDir, '.claude', 'plugins');
    await mkdir(plugins, { recursive: true });
    await writeFile(
      join(plugins, '.mcp.json'),
      JSON.stringify({ mcpServers: { plugin: definitions.penathon } }),
    );
    expect(await userMcpServers(process.cwd())).toEqual({ ...definitions, penathon: override });
    const sdk = mockStream(
      vi.fn().mockResolvedValue([status('penathon'), status('chrome-devtools')]),
    );
    const engine = new ClaudeEngine(context);
    const connections = await engine.connections();
    expect(connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'penathon', source: 'user' }),
        expect.objectContaining({ name: 'chrome-devtools', source: 'user' }),
      ]),
    );
    expect(vi.mocked(query).mock.calls[0][0].options?.mcpServers).toMatchObject({
      ...definitions,
      penathon: override,
    });
    await collect(engine.run(input(['penathon'])));
    let options = vi.mocked(query).mock.calls.at(-1)![0].options!;
    expect(options.settingSources).toEqual([]);
    expect(Object.keys(options.mcpServers!)).toEqual(['penathon', 'team']);
    expect(options.mcpServers?.penathon).toEqual(override);
    await collect(engine.run(input(['chrome-devtools'])));
    options = vi.mocked(query).mock.calls.at(-1)![0].options!;
    expect(Object.keys(options.mcpServers!)).toEqual(['chrome-devtools', 'team']);
    expect(options.mcpServers?.['chrome-devtools']).toEqual(definitions['chrome-devtools']);
    await collect(engine.run(input()));
    options = vi.mocked(query).mock.calls.at(-1)![0].options!;
    expect(Object.keys(options.mcpServers!)).toEqual(['team']);
    expect(sdk.close).toHaveBeenCalledOnce();
  },
);

it('rejects malformed definitions without logging their secret values and reserves team', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await writeFile(
    join(configDir, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        broken: { type: 'http', url: 'secret-value' },
        team: { command: 'untrusted' },
        valid: { command: 'node', env: { TOKEN: 'secret-value' } },
      },
    }),
  );
  expect(Object.keys(await userMcpServers(process.cwd()))).toEqual(['valid']);
  expect(warning).toHaveBeenCalledWith('Invalid Claude user MCP definition');
  await writeFile(join(configDir, '.claude.json'), '{secret-value');
  expect(await userMcpServers(process.cwd())).toEqual({});
  expect(JSON.stringify(warning.mock.calls)).not.toContain('secret-value');
});

it('masks MCP env values in probe and warmup errors', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await writeFile(
    join(configDir, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        Gmail: { command: 'node', env: { TOKEN: 'fixture-secret' } },
      },
    }),
  );
  mockStream(vi.fn().mockRejectedValue(new Error('Cannot connect with fixture-secret')));
  const engine = new ClaudeEngine(context);
  expect(await engine.connections()).toEqual([]);
  await collect(engine.run(input(['Gmail'])));
  expect(warning).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warning.mock.calls)).not.toContain('fixture-secret');
  expect(JSON.stringify(warning.mock.calls)).toContain('[REDACTED]');
});

it('does not exempt old app tool names; penathon now needs an ordinary connection grant', async () => {
  const bot = testBot();
  expect(await allowClaudeTool(bot, 'mcp__team__create_bot', {})).toBe(true);
  expect(await allowClaudeTool(bot, 'mcp__penathon__create_bot', {})).toBe(false);
  expect(
    await allowClaudeTool(
      { ...bot, connections: ['penathon'] },
      'mcp__penathon__search_contacts',
      {},
    ),
  ).toBe(true);
});

it('does not match action words in the server prefix', async () => {
  mockStream(vi.fn().mockResolvedValue([status('SendMail')]));
  const run = input(['SendMail']);
  run.requestApproval = vi.fn().mockResolvedValue(false);
  await collect(new ClaudeEngine(context).run(run));
  const options = vi.mocked(query).mock.calls[0][0].options!;
  expect(
    await options.canUseTool!(
      'mcp__SendMail__lookup',
      {},
      {
        signal: run.signal,
        toolUseID: 'read',
        requestId: 'r',
      },
    ),
  ).toMatchObject({ behavior: 'allow' });
  expect(run.requestApproval).not.toHaveBeenCalled();
});

it.each([
  ['sendMessage', {}, true],
  ['send-message', {}, true],
  ['batchExecute', { operations: [{ options: { action: 'sendMessage' } }] }, true],
  ['manage', { nested: [{ operation: { method: 'POST' } }] }, true],
  ['manage', { operations: [{ type: 'delete-message' }] }, true],
  ['manage', { nested: { kind: 'shareLink' } }, true],
  ['get_message', { action: 'send' }, true],
  ['execute', { script: 'mailer.sendMessage(message)' }, true],
  ['invokeTool', { commands: [{ tool: 'publish-post' }] }, true],
  ['call', { sendMessage: { to: 'reader@example.invalid' } }, true],
  ['bulk', { commands: ['archive-thread'] }, true],
  ['run', { steps: ['transferFunds'] }, true],
  ['manage', { body: 'Please send a reply' }, false],
  ['search_threads', { query: 'send message' }, false],
  ['getSharedMessage', {}, false],
  ['batch_execute', { operations: [{ action: 'read' }] }, false],
  ['createDraft', {}, false],
] as const)(
  'detects external actions in tool names and nested input: %s %j',
  async (tool, args, approval) => {
    mockStream(vi.fn().mockResolvedValue([status('Gmail')]));
    const run = input(['Gmail']);
    run.requestApproval = vi.fn().mockResolvedValue(false);
    await collect(new ClaudeEngine(context).run(run));
    const options = vi.mocked(query).mock.calls[0][0].options!;
    const name = 'mcp__Gmail__' + tool;
    expect(
      await options.canUseTool!(name, args, {
        signal: run.signal,
        toolUseID: 'action',
        requestId: 'r',
      }),
    ).toMatchObject({ behavior: approval ? 'deny' : 'allow' });
    const hook = options.hooks!.PreToolUse![0].hooks[0];
    expect(
      await hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 's',
          transcript_path: '',
          cwd: process.cwd(),
          tool_name: name,
          tool_input: args,
          tool_use_id: 'action',
        },
        'action',
        { signal: run.signal },
      ),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: approval ? 'deny' : 'allow' } });
    expect(run.requestApproval).toHaveBeenCalledTimes(approval ? 1 : 0);
  },
);

it.each([false, true])(
  'checks nested MCP file URIs before approval, including Chief %s',
  async (chief) => {
    mockStream(vi.fn().mockResolvedValue([status('filesystem')]));
    const run = input(['filesystem']);
    // Keep denied paths out of scope even when TMPDIR is inside the repository.
    const workdir = join(configDir, 'work');
    await mkdir(workdir);
    run.bot = testBot(workdir, { connections: ['filesystem'] });
    if (chief) run.bot = { ...run.bot, id: 'chief', system: true };
    const vault = join(configDir, 'vault');
    run.requestApproval = vi.fn().mockResolvedValue(true);
    await collect(new ClaudeEngine({ ...context, knowledgeDir: () => vault }).run(run));
    const options = vi.mocked(query).mock.calls[0][0].options!;
    const outside = pathToFileURL(join(configDir, 'outside', 'x')).href;
    for (const [tool, args] of [
      ['delete_file', { uri: outside }],
      ['delete_file', { target: { url: outside } }],
      ['delete_file', { files: [{ file: outside }] }],
      ['batch_execute', { operations: [{ action: 'deleteFile', uri: outside }] }],
      ['batch_execute', { operations: [{ action: 'writeFile', url: outside }] }],
      ['send_message', { attachments: [{ path: outside }] }],
      ['read_file', { nested: { url: outside } }],
      [
        'delete_file',
        {
          path: join(configDir, 'outside', 'x')
            .replaceAll('\\', '/')
            .replace(/^([a-z]):\//i, '$1://'),
        },
      ],
    ] as const) {
      const name = 'mcp__filesystem__' + tool;
      expect(
        await options.canUseTool!(name, args, {
          signal: run.signal,
          toolUseID: tool,
          requestId: 'r',
        }),
      ).toMatchObject({ behavior: 'deny' });
      const hook = options.hooks!.PreToolUse![0].hooks[0];
      expect(
        await hook(
          {
            hook_event_name: 'PreToolUse',
            session_id: 's',
            transcript_path: '',
            cwd: process.cwd(),
            tool_name: name,
            tool_input: args,
            tool_use_id: tool,
          },
          tool,
          { signal: run.signal },
        ),
      ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    }
    expect(run.requestApproval).not.toHaveBeenCalled();
    if (!chief)
      expect(
        await options.canUseTool!(
          'mcp__filesystem__delete_file',
          { uri: pathToFileURL(join(vault, 'x')).href },
          { signal: run.signal, toolUseID: 'vault', requestId: 'r' },
        ),
      ).toMatchObject({ behavior: 'deny' });
    expect(run.requestApproval).not.toHaveBeenCalled();
    expect(
      await options.canUseTool!(
        'mcp__filesystem__delete_file',
        { uri: pathToFileURL(join(workdir, 'allowed file.md')).href },
        { signal: run.signal, toolUseID: 'allowed', requestId: 'r' },
      ),
    ).toMatchObject({ behavior: 'allow' });
    expect(run.requestApproval).toHaveBeenCalledOnce();
  },
);

it('rechecks URI scope after an external action is approved', async () => {
  mockStream(vi.fn().mockResolvedValue([status('filesystem')]));
  const run = input(['filesystem']);
  let current = run.bot;
  run.requestApproval = vi.fn(async () => {
    current = { ...current, sandbox: 'read-only', writeScope: [] };
    return true;
  });
  await collect(new ClaudeEngine({ ...context, getBot: () => current }).run(run));
  const options = vi.mocked(query).mock.calls[0][0].options!;
  expect(
    await options.canUseTool!(
      'mcp__filesystem__batch_execute',
      {
        operations: [
          { action: 'deleteFile', url: pathToFileURL(join(process.cwd(), 'allowed.md')).href },
        ],
      },
      { signal: run.signal, toolUseID: 'action', requestId: 'r' },
    ),
  ).toMatchObject({ behavior: 'deny' });
  expect(run.requestApproval).toHaveBeenCalledOnce();
});

it('registers only plausible MCP secrets and safely summarizes numeric and boolean arguments', () => {
  const secrets = mcpSecrets({
    demo: {
      command: 'node',
      env: {
        DEBUG: '1',
        ENABLED: 'true',
        COUNT: '12345678901234567890',
        RATIO: '-123456789.23456',
        API_KEY: '1',
        TOKEN: 'short',
        AUTH: 'false',
        OPAQUE: 'long-fixture-secret',
      },
    },
    remote: {
      type: 'http',
      url: 'https://example.invalid',
      headers: {
        Authorization: 'Bearer fixture-token',
        Debug: 'false',
      },
    },
  });
  expect(secrets).toEqual(['1', 'short', 'false', 'long-fixture-secret', 'Bearer fixture-token']);
  const text = connectorSummary(
    { count: 1, enabled: false, debug: '1', body: 'long-fixture-secret' },
    secrets,
  );
  expect(JSON.parse(text)).toEqual({
    count: 1,
    enabled: false,
    debug: '[REDACTED]',
    body: '[REDACTED]',
  });
});

it.each([false, true])(
  'requires one approval in both SDK paths for external actions, chief %s',
  async (chief) => {
    mockStream(vi.fn().mockResolvedValue([status('Gmail')]));
    const run = input(['Gmail']);
    if (chief) run.bot = { ...run.bot, id: 'chief', system: true };
    run.requestApproval = vi.fn().mockResolvedValue(true);
    const engine = new ClaudeEngine({ ...context, secrets: () => ['fixture-secret'] });
    await collect(engine.run(run));
    const options = vi.mocked(query).mock.calls[0][0].options!;
    const hook = options.hooks!.PreToolUse![0].hooks[0];
    for (const tool of [
      'send_message',
      'reply_message',
      'forward_message',
      'publish',
      'post',
      'delete_message',
      'trash',
      'remove',
      'archive',
      'pay',
      'purchase',
      'transfer',
      'invite',
      'share',
    ]) {
      const name = 'mcp__Gmail__' + tool;
      const args = {
        to: 'reader@example.invalid',
        subject: 'Test',
        token: 'hidden',
        body: 'fixture-secret ' + 'x'.repeat(400),
      };
      expect(
        await options.canUseTool!(name, args, {
          signal: run.signal,
          toolUseID: tool,
          requestId: 'r',
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
            tool_use_id: tool,
          },
          tool,
          { signal: run.signal },
        ),
      ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
      const card = vi.mocked(run.requestApproval!).mock.calls.at(-1)![0];
      expect(card).toEqual({ title: 'Gmail: ' + tool, details: expect.any(String) });
      expect(card.details).toContain('reader@example.invalid');
      expect(card.details).not.toContain('fixture-secret');
      expect(card.details).not.toContain('hidden');
      expect(card.details.length).toBeLessThanOrEqual(300);
    }
    expect(run.requestApproval).toHaveBeenCalledTimes(14);
    vi.mocked(run.requestApproval!).mockClear();
    for (const name of [
      'mcp__Gmail__create_draft',
      'mcp__Gmail__search_threads',
      'mcp__Gmail__get_shared_message',
      'mcp__Gmail__list_archived_threads',
      'mcp__Gmail__read_forwarded_message',
      'mcp__team__post_to_room',
      'mcp__team__delete_routine',
    ])
      expect(
        await options.canUseTool!(
          name,
          {},
          { signal: run.signal, toolUseID: name, requestId: 'r' },
        ),
      ).toMatchObject({ behavior: 'allow' });
    expect(run.requestApproval).not.toHaveBeenCalled();
  },
);

it.each(['approved', 'rejected', 'expired'] as const)(
  'waits for the real approval card and enforces %s',
  async (decision) => {
    mockStream(vi.fn().mockResolvedValue([status('Gmail')]));
    const controller = new AbortController();
    const run = { ...input(['Gmail']), signal: controller.signal };
    const approvals = new Approvals();
    const events: BotEvent[] = [];
    await collect(
      new ClaudeEngine(context).run({
        ...run,
        requestApproval: async (request) =>
          (await approvals.request(
            'run',
            request,
            controller.signal,
            (event) => events.push(event),
            async () => true,
          )) === true,
      }),
    );
    const options = vi.mocked(query).mock.calls[0][0].options!;
    const pending = options.canUseTool!(
      'mcp__Gmail__send_message',
      { to: 'a@example.invalid', subject: 'Review' },
      { signal: run.signal, toolUseID: 'send', requestId: 'r' },
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const card = events[0];
    expect(card).toMatchObject({ type: 'approval.request', title: 'Gmail: send_message' });
    expect(card).not.toHaveProperty('kind');
    if (card.type !== 'approval.request') throw new Error('Missing approval');
    if (decision === 'expired') approvals.expireRun('run');
    else await approvals.respond(card.approvalId, decision);
    expect(await pending).toMatchObject({ behavior: decision === 'approved' ? 'allow' : 'deny' });
  },
);
