import { afterEach, beforeEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PenathonHttpServer } from '../src/main/bots/http-tools';
import { ChatService } from '../src/main/chat';
import { Repository } from '../src/main/db';
import { BotStore, chiefBot } from '../src/main/bots/store';
import type { EngineAdapter, RunInput } from '../src/main/engines/types';
import type { EventEnvelope } from '../src/shared/events';
import { removeTemporary, temporaryDirectory } from './helpers';

let directory: string;
let db: Repository;
let bots: BotStore;
let chat: ChatService;
let http: PenathonHttpServer;
let events: EventEnvelope[];
type Connection = Awaited<ReturnType<PenathonHttpServer['register']>> & {
  input: RunInput;
  finish(): void;
};
let connections: Connection[];
let requestId = 0;

beforeEach(async () => {
  directory = await temporaryDirectory();
  bots = new BotStore(join(directory, 'bots'), chiefBot(directory, 'en'));
  await bots.init();
  db = new Repository(':memory:');
  http = new PenathonHttpServer();
  events = [];
  connections = [];
  const engine: EngineAdapter = {
    id: 'codex',
    cancel() {},
    models: async () => [],
    checkAuth: async () => ({ mode: 'local-cli', state: 'unverified', messageKey: '' }),
    async *run(input) {
      const registration = await http.register({
        botId: input.bot.id,
        runId: input.runId!,
        conversationId: input.conversationId,
        chief: input.bot.id === 'chief',
        signal: input.signal,
        call: input.callTool!,
      });
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      input.signal.addEventListener('abort', finish, { once: true });
      connections.push({ ...registration, input, finish });
      try {
        yield { type: 'status', status: 'thinking' };
        await done;
        yield { type: 'run.done', durationMs: 1, cancelled: input.signal.aborted };
      } finally {
        registration.revoke();
        input.signal.removeEventListener('abort', finish);
      }
    },
  };
  chat = new ChatService(
    () => bots,
    db,
    { claude: { ...engine, id: 'claude' }, codex: engine },
    () => [],
    (event) => events.push(event),
  );
});
afterEach(async () => {
  await chat?.close();
  await http?.close();
  db?.close();
  await bots?.close();
  if (directory) await removeTemporary(directory);
});
async function start(botId = 'chief'): Promise<Connection> {
  const count = connections.length;
  await chat.send(botId, 'Use team');
  await expect.poll(() => connections.length).toBe(count + 1);
  return connections[count];
}
function request(
  connection: Connection,
  method: string,
  params: unknown = {},
  token: string | undefined = connection.token,
) {
  return fetch(connection.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  });
}
async function call(connection: Connection, name: string, args: unknown) {
  const response = await request(connection, 'tools/call', { name, arguments: args });
  expect(response.status).toBe(200);
  return (await response.json()).result;
}

it('binds only to loopback and rejects absent, incorrect, revoked and cancelled tokens', async () => {
  const connection = await start();
  expect(new URL(connection.url).hostname).toBe('127.0.0.1');
  expect(new URL(connection.url).port).not.toBe('0');
  expect((await request(connection, 'tools/list', {}, '')).status).toBe(401);
  expect((await request(connection, 'tools/list', {}, 'incorrect')).status).toBe(401);
  const list = await request(connection, 'tools/list');
  expect((await list.json()).result.tools.map((tool: { name: string }) => tool.name)).toContain(
    'create_room',
  );
  connection.finish();
  await expect.poll(() => chat.isBotActive('chief')).toBe(false);
  expect((await request(connection, 'tools/list')).status).toBe(401);
  const next = await start();
  expect(next.token).not.toBe(connection.token);
  chat.cancel(next.input.conversationId);
  expect((await request(next, 'tools/list')).status).toBe(401);
});

it('supports an actual Streamable HTTP MCP client handshake and tool calls', async () => {
  const connection = await start();
  const client = new Client({ name: 'penathon-test', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { Authorization: 'Bearer ' + connection.token } },
      }),
    );
    expect((await client.listTools()).tools.some((tool) => tool.name === 'remember')).toBe(true);
    expect(
      await client.callTool({ name: 'remember', arguments: { text: 'Chief memory' } }),
    ).not.toHaveProperty('isError', true);
    expect(await bots.getMemory('chief')).toContain('Chief memory');
  } finally {
    await client.close();
  }
});

it('lets a worker list bots and report over HTTP without bypassing Chief permissions or app approvals', async () => {
  const worker = await bots.create({ name: 'Briefing', engine: 'codex', instructions: 'Report' });
  const connection = await start(worker.id);
  expect((await call(connection, 'list_bots', {})).isError).not.toBe(true);
  expect(
    (await call(connection, 'report_to_chief', { summary: 'Completed briefing' })).isError,
  ).not.toBe(true);
  expect(db.reports()).toMatchObject([{ botId: worker.id, summary: 'Completed briefing' }]);
  expect(
    await call(connection, 'mark_reports_processed', {
      ids: [db.reports()[0].id],
      into: 'notes.md',
    }),
  ).toMatchObject({ isError: true });
  expect(events.some(({ event }) => event.type === 'approval.request')).toBe(false);
  const pending = call(connection, 'create_bot', {
    draft: { name: 'Needs approval', engine: 'codex', instructions: 'Help' },
  });
  await expect.poll(() => events.some(({ event }) => event.type === 'approval.request')).toBe(true);
  expect(bots.list().some((bot) => bot.name === 'Needs approval')).toBe(false);
  const approval = events
    .map(({ event }) => event)
    .find((event) => event.type === 'approval.request')!;
  await chat.approvals.respond(approval.approvalId, 'rejected');
  await pending;
  expect(bots.list().some((bot) => bot.name === 'Needs approval')).toBe(false);
});

it('redacts the bearer token from HTTP tool arguments, persisted logs, results and errors', async () => {
  const connection = await start();
  await call(connection, 'remember', { text: 'Remember ' + connection.token });
  expect(await bots.getMemory('chief')).toContain('Remember [REDACTED]');
  expect(JSON.stringify(events)).not.toContain(connection.token);
  expect(JSON.stringify(db.get(connection.input.conversationId))).not.toContain(connection.token);
  for (const fail of [false, true]) {
    const registration = await http.register({
      botId: 'chief',
      runId: 'test',
      conversationId: 'test',
      chief: true,
      signal: new AbortController().signal,
      call: async () => {
        if (fail) throw new Error(registration.token);
        return registration.token;
      },
    });
    const result = await call({ ...connection, ...registration }, 'remember', { text: 'Safe' });
    expect(result.content[0].text).toBe('[REDACTED]');
    expect(result.isError).toBe(fail ? true : undefined);
    registration.revoke();
  }
});

it('uses the token owner for memory and permissions, including concurrent runs', async () => {
  const worker = await bots.create({ name: 'Worker', engine: 'codex', instructions: 'Help' });
  const chief = await start();
  const member = await start(worker.id);
  expect(member.token).not.toBe(chief.token);
  expect((await call(member, 'remember', { text: 'Worker memory' })).isError).not.toBe(true);
  expect(await bots.getMemory(worker.id)).toContain('Worker memory');
  expect(await bots.getMemory('chief')).not.toContain('Worker memory');
  expect(await call(member, 'remember', { text: 'Injected', botId: 'chief' })).toMatchObject({
    isError: true,
  });
  expect(
    await call(member, 'update_bot', { id: 'chief', patch: { name: 'Hijacked' } }),
  ).toMatchObject({ isError: true });
  expect(await call(member, 'list_reports', {})).toMatchObject({ isError: true });
  expect(await call(member, 'create_room', { name: 'Denied', members: [worker.id] })).toMatchObject(
    { isError: true },
  );
  expect(events.some(({ event }) => event.type === 'approval.request')).toBe(false);
  expect(
    (await call(chief, 'create_room', { name: 'Allowed', members: [worker.id] })).isError,
  ).not.toBe(true);
});

it('keeps a proposal HTTP request pending until the shared approval is resolved', async () => {
  const connection = await start();
  let resolved = false;
  const pending = call(connection, 'create_bot', {
    draft: { name: 'Approved HTTP bot', engine: 'codex', instructions: 'Help' },
  }).then((result) => {
    resolved = true;
    return result;
  });
  await expect.poll(() => events.some(({ event }) => event.type === 'approval.request')).toBe(true);
  expect(resolved).toBe(false);
  expect(bots.list().some((bot) => bot.name === 'Approved HTTP bot')).toBe(false);
  const approval = events
    .map(({ event }) => event)
    .find((event) => event.type === 'approval.request')!;
  await chat.approvals.respond(approval.approvalId, 'approved');
  expect((await pending).isError).not.toBe(true);
  expect(bots.list().some((bot) => bot.name === 'Approved HTTP bot')).toBe(true);
});

it('cancels outstanding HTTP proposals and prevents later approval or token reuse', async () => {
  const connection = await start();
  const pending = request(connection, 'tools/call', {
    name: 'create_bot',
    arguments: { draft: { name: 'Cancelled HTTP bot', engine: 'codex', instructions: 'Help' } },
  })
    .then(async (response) => {
      await response.text();
    })
    .catch(() => {});
  await expect.poll(() => events.some(({ event }) => event.type === 'approval.request')).toBe(true);
  const approval = events
    .map(({ event }) => event)
    .find((event) => event.type === 'approval.request')!;
  chat.cancel(connection.input.conversationId);
  await pending;
  await expect(chat.approvals.respond(approval.approvalId, 'approved')).rejects.toThrow();
  expect(bots.list().some((bot) => bot.name === 'Cancelled HTTP bot')).toBe(false);
  expect((await request(connection, 'tools/list')).status).toBe(401);
});
