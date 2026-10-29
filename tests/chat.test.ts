import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Repository } from '../src/main/db';
import { BotStore, chiefBot } from '../src/main/bots/store';
import { ChatService } from '../src/main/chat';
import type { EngineAdapter } from '../src/main/engines/types';
import type { BotEvent, EventEnvelope } from '../src/shared/events';
import { removeTemporary, temporaryDirectory } from './helpers';

let directory: string;
let db: Repository;
let bots: BotStore;
let chat: ChatService;
let release: (() => void) | undefined;
afterEach(async () => {
  release?.();
  await chat?.close();
  db?.close();
  await bots?.close();
  if (directory) await removeTemporary(directory);
});
it('persists/emits a redacted stream, resumes sessions and prevents overlapping runs', async () => {
  directory = await temporaryDirectory();
  bots = new BotStore(join(directory, 'bots'), chiefBot(directory, 'en'));
  await bots.init();
  db = new Repository(join(directory, 'chat.sqlite'));
  const envelopes: EventEnvelope[] = [];
  const received: (string | undefined)[] = [];
  const receivedInstructions: string[] = [];
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake: EngineAdapter = {
    id: 'claude',
    models: async () => [],
    checkAuth: async () => ({
      mode: 'local-cli',
      state: 'unverified',
      messageKey: 'auth.localUnverified',
    }),
    cancel: () => {},
    async *run(input) {
      received.push(input.resumeToken);
      receivedInstructions.push(input.bot.instructions);
      yield { type: 'message.delta', messageId: 'answer', text: 'fake-key' };
      await hold;
      yield { type: 'message.done', messageId: 'answer', text: 'fake-key' };
      yield { type: 'run.done', durationMs: 1, resumeToken: 'saved-session' };
    },
  };
  chat = new ChatService(
    () => bots,
    db,
    { claude: fake, codex: { ...fake, id: 'codex' } },
    () => ['fake-key'],
    (event) => {
      envelopes.push(event);
    },
  );
  const first = await chat.send('chief', 'Prompt fake-key');
  await expect(chat.send('chief', 'Overlapping', first.conversationId)).rejects.toThrow(
    'errors.botBusy',
  );
  release!();
  await expect.poll(() => envelopes.length).toBe(4);
  bots.setLanguage('tr');
  const second = await chat.send('chief', 'Again', first.conversationId);
  expect(second.conversationId).toBe(first.conversationId);
  await chat.close();
  expect(received).toEqual([undefined, 'saved-session']);
  expect(receivedInstructions).toEqual([
    chiefBot(directory, 'en').instructions,
    chiefBot(directory, 'tr').instructions,
  ]);
  expect(JSON.stringify(envelopes)).not.toContain('fake-key');
  expect(JSON.stringify(db.get(first.conversationId))).not.toContain('fake-key');
  db.close();
  db = new Repository(join(directory, 'chat.sqlite'));
  expect((await readFile(join(directory, 'chat.sqlite'))).includes(Buffer.from('fake-key'))).toBe(
    false,
  );
});

describe('stream secret redaction', () => {
  const secret = 'K7q9B2m4Z6p8R0v3';

  async function startStream(run: EngineAdapter['run'], secrets = [secret]) {
    directory = await temporaryDirectory();
    bots = new BotStore(join(directory, 'bots'), chiefBot(directory, 'en'));
    await bots.init();
    db = new Repository(join(directory, 'chat.sqlite'));
    const envelopes: EventEnvelope[] = [];
    const appended: BotEvent[] = [];
    const append = db.append.bind(db);
    vi.spyOn(db, 'append').mockImplementation((runId, event) => {
      appended.push(event);
      return append(runId, event);
    });
    const fake: EngineAdapter = {
      id: 'claude',
      models: async () => [],
      checkAuth: async () => ({
        mode: 'local-cli',
        state: 'unverified',
        messageKey: 'auth.localUnverified',
      }),
      cancel: () => {},
      run,
    };
    chat = new ChatService(
      () => bots,
      db,
      { claude: fake, codex: { ...fake, id: 'codex' } },
      () => secrets,
      (event) => envelopes.push(event),
    );
    return { ...(await chat.send('chief', 'Public prompt')), envelopes, appended };
  }

  async function expectNoFragments(
    result: Awaited<ReturnType<typeof startStream>>,
    keys = [secret],
  ) {
    const detail = db.get(result.conversationId);
    const text = JSON.stringify({ ipc: result.envelopes, sqliteInput: result.appended, detail });
    for (const key of keys)
      for (let i = 0; i <= key.length - 4; i++) expect(text).not.toContain(key.slice(i, i + 4));
    expect(result.envelopes.map((envelope) => envelope.event)).toEqual(result.appended);
    db.close();
    db = new Repository(join(directory, 'chat.sqlite'));
    expect(db.get(result.conversationId)).toEqual(detail);
    const bytes = await readFile(join(directory, 'chat.sqlite'));
    for (const key of keys)
      for (let i = 0; i <= key.length - 4; i++)
        expect(bytes.includes(Buffer.from(key.slice(i, i + 4)))).toBe(false);
  }

  it.each(['done', 'error', 'cancel', 'throw', 'end'] as const)(
    'publishes exactly one terminal event and matching final status: %s',
    async (ending) => {
      const result = await startStream(async function* () {
        yield { type: 'status', status: 'thinking' };
        yield { type: 'status', status: 'error' };
        yield { type: 'status', status: 'done' };
        if (ending === 'throw') throw new Error('test failure');
        if (ending === 'end') return;
        if (ending === 'error') yield { type: 'run.error', code: 'test', message: 'first failure' };
        else yield { type: 'run.done', durationMs: 1, cancelled: ending === 'cancel' };
        yield { type: 'status', status: 'error' };
        yield { type: 'run.error', code: 'test', message: 'duplicate failure' };
      }, []);
      await expect.poll(() => chat.isBotActive('chief')).toBe(false);
      const expected = ending === 'done' ? 'done' : ending === 'cancel' ? 'idle' : 'error';
      for (const events of [
        result.appended,
        result.envelopes.map((envelope) => envelope.event),
        db.get(result.conversationId).events.map((envelope) => envelope.event),
      ]) {
        expect(
          events.filter((event) => event.type === 'run.done' || event.type === 'run.error'),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) => event.type === 'status' && ['done', 'error', 'idle'].includes(event.status),
          ),
        ).toEqual([{ type: 'status', status: expected }]);
      }
    },
  );

  it('redacts a run secret registered by the engine, including split tokens and tool logs', async () => {
    const token = secret.repeat(4);
    const result = await startStream(async function* (input) {
      input.addRedactionSecret!(token);
      yield { type: 'message.delta', messageId: 'answer', text: token.slice(0, 40) };
      yield { type: 'message.delta', messageId: 'answer', text: token.slice(40) };
      yield { type: 'message.done', messageId: 'answer', text: token };
      yield {
        type: 'tool.start',
        toolId: 'cmd',
        kind: 'command',
        title: token,
        argsSummary: token,
      };
      yield { type: 'tool.end', toolId: 'cmd', resultSummary: token, error: true };
      yield { type: 'run.error', code: 'test', message: token };
    }, []);
    await expect.poll(() => chat.isBotActive('chief')).toBe(false);
    expect(
      result.appended
        .filter((event) => event.type === 'message.delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('[REDACTED]');
    expect(db.get(result.conversationId).messages.at(-1)?.text).toBe('[REDACTED]');
    await expectNoFragments(result, [token]);
  });

  it.each([2, 3])(
    'redacts keys split across %i chunks before SQLite and IPC, including full message text',
    async (count) => {
      const prefix = 'Public text '.repeat(5);
      const suffix = ' safe ending';
      const fullText = prefix + secret + suffix;
      const result = await startStream(async function* () {
        yield { type: 'message.delta', messageId: 'answer', text: prefix };
        for (let i = 0; i < count; i++)
          yield {
            type: 'message.delta',
            messageId: 'answer',
            text: secret.slice(
              Math.floor((i * secret.length) / count),
              Math.floor(((i + 1) * secret.length) / count),
            ),
          };
        yield { type: 'message.delta', messageId: 'answer', text: suffix };
        yield { type: 'message.done', messageId: 'answer', text: fullText };
        yield { type: 'run.done', durationMs: 1 };
      });
      await expect.poll(() => chat.isBotActive('chief')).toBe(false);
      for (const events of [result.appended, result.envelopes.map((envelope) => envelope.event)]) {
        expect(
          events
            .filter((event) => event.type === 'message.delta')
            .map((event) => event.text)
            .join(''),
        ).toBe(prefix + '[REDACTED]' + suffix);
        expect(events).toContainEqual({
          type: 'message.done',
          messageId: 'answer',
          text: prefix + '[REDACTED]' + suffix,
        });
      }
      expect(db.get(result.conversationId).messages.at(-1)?.text).toBe(
        prefix + '[REDACTED]' + suffix,
      );
      await expectNoFragments(result);
    },
  );

  it.each(['run.done', 'run.error', 'throw', 'end'] as const)(
    'flushes buffered text on %s without message.done',
    async (ending) => {
      const result = await startStream(async function* () {
        yield { type: 'message.delta', messageId: 'answer', text: secret.slice(0, 8) };
        yield {
          type: 'message.delta',
          messageId: 'answer',
          text: secret.slice(8) + ' safe ending',
        };
        if (ending === 'run.done') yield { type: 'run.done', durationMs: 1 };
        if (ending === 'run.error')
          yield { type: 'run.error', code: 'test', message: 'Failure ' + secret };
        if (ending === 'throw') throw new Error(secret);
      });
      await expect.poll(() => chat.isBotActive('chief')).toBe(false);
      expect(
        result.appended
          .filter((event) => event.type === 'message.delta')
          .map((event) => event.text)
          .join(''),
      ).toBe('[REDACTED] safe ending');
      expect(['run.done', 'run.error']).toContain(result.appended.at(-1)?.type);
      await expectNoFragments(result);
    },
  );

  it('flushes on cancellation immediately and masks a truncated key prefix', async () => {
    let reached = false;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await startStream(async function* () {
      yield {
        type: 'message.delta',
        messageId: 'answer',
        text: 'Public text '.repeat(5) + secret.slice(0, 8),
      };
      reached = true;
      await hold;
      yield { type: 'message.delta', messageId: 'answer', text: secret.slice(8) };
      yield { type: 'run.done', durationMs: 1, cancelled: true };
    });
    await expect.poll(() => reached).toBe(true);
    expect(
      result.appended.some(
        (event) => event.type === 'message.delta' && event.text.includes('Public'),
      ),
    ).toBe(true);
    chat.cancel(result.conversationId);
    expect(
      result.appended
        .filter((event) => event.type === 'message.delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('Public text '.repeat(5) + '[REDACTED]');
    release!();
    await chat.close();
    await expectNoFragments(result);
  });

  it('keeps interleaved messages separate and handles overlapping keys and escaped characters', async () => {
    const short = secret.slice(0, 8);
    const escaped = 'V5n1"\n\\C9x2';
    const result = await startStream(
      async function* () {
        yield { type: 'message.delta', messageId: 'one', text: secret.slice(0, 4) };
        yield { type: 'message.delta', messageId: 'two', text: escaped.slice(0, 6) };
        yield { type: 'message.delta', messageId: 'one', text: secret.slice(4) + ' ' + short };
        yield { type: 'message.delta', messageId: 'two', text: escaped.slice(6) };
        yield { type: 'message.done', messageId: 'one', text: secret + ' ' + short };
        yield { type: 'message.done', messageId: 'two', text: escaped };
        yield { type: 'run.done', durationMs: 1 };
      },
      [short, secret, escaped, ''],
    );
    await expect.poll(() => chat.isBotActive('chief')).toBe(false);
    for (const [messageId, expected] of [
      ['one', '[REDACTED] [REDACTED]'],
      ['two', '[REDACTED]'],
    ]) {
      expect(
        result.appended
          .filter((event) => event.type === 'message.delta' && event.messageId === messageId)
          .map((event) => (event.type === 'message.delta' ? event.text : ''))
          .join(''),
      ).toBe(expected);
      expect(result.appended).toContainEqual({ type: 'message.done', messageId, text: expected });
    }
    await expectNoFragments(result, [secret, escaped]);
  });

  it('redacts all textual event fields and nested tool results before persistence and IPC', async () => {
    const events: BotEvent[] = [
      { type: 'tool.start', toolId: 'tool', kind: 'command', title: secret, argsSummary: secret },
      { type: 'tool.end', toolId: 'tool', resultSummary: secret, error: false },
      { type: 'notice', level: 'warning', message: secret },
      { type: 'diff', file: secret, unifiedDiff: secret },
      { type: 'card', cardId: 'card', kind: 'output', data: { nested: [{ stdout: secret }] } },
      { type: 'approval.request', approvalId: 'approval', title: secret, details: secret },
      { type: 'approval.resolved', approvalId: 'approval', decision: 'rejected' },
      { type: 'run.error', code: 'command', message: secret },
    ];
    const result = await startStream(async function* () {
      yield* events;
    });
    await expect.poll(() => chat.isBotActive('chief')).toBe(false);
    expect(result.appended).toHaveLength(events.length + 1);
    expect(result.appended).toContainEqual({
      type: 'tool.end',
      toolId: 'tool',
      resultSummary: '[REDACTED]',
      error: false,
    });
    expect(result.appended).toContainEqual({
      type: 'card',
      cardId: 'card',
      kind: 'output',
      data: { nested: [{ stdout: '[REDACTED]' }] },
    });
    await expectNoFragments(result);
  });

  it.each(['message.done', 'run.done', 'run.error', 'throw', 'end', 'cancel'] as const)(
    'preserves ordinary suffixes and short key prefixes on %s',
    async (ending) => {
      const key = 'sk-K7q9B2m4Z6p8R0v3';
      const prefix = 'Public text '.repeat(5);
      const suffixes = [
        'Thanks',
        'Windows',
        'ask',
        'risk-',
        ...Array.from({ length: 7 }, (_, i) => key.slice(0, i + 1)),
        key.slice(0, 8),
        key.slice(0, 11),
        key.slice(0, -1),
        key,
        key.slice(1, 10),
      ];
      let reached = false;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const result = await startStream(
        async function* () {
          for (const [i, suffix] of suffixes.entries()) {
            const messageId = String(i);
            const split = Math.ceil(suffix.length / 2);
            yield { type: 'message.delta', messageId, text: prefix + suffix.slice(0, split) };
            yield { type: 'message.delta', messageId, text: suffix.slice(split) };
            if (ending === 'message.done')
              yield { type: 'message.done', messageId, text: prefix + suffix };
          }
          reached = true;
          if (ending === 'cancel') {
            await hold;
            yield { type: 'run.done', durationMs: 1, cancelled: true };
          } else if (ending === 'message.done' || ending === 'run.done')
            yield { type: 'run.done', durationMs: 1 };
          else if (ending === 'run.error')
            yield { type: 'run.error', code: 'test', message: 'Failure' };
          else if (ending === 'throw') throw new Error('Failure');
        },
        [key],
      );
      await expect.poll(() => reached).toBe(true);
      if (ending === 'cancel') {
        chat.cancel(result.conversationId);
        expect(
          result.appended
            .filter((event) => event.type === 'message.delta' && event.messageId === '0')
            .map((event) => (event.type === 'message.delta' ? event.text : ''))
            .join(''),
        ).toBe(prefix + 'Thanks');
        release!();
      }
      await expect.poll(() => chat.isBotActive('chief')).toBe(false);
      const detail = db.get(result.conversationId);
      for (const events of [
        result.appended,
        result.envelopes.map((event) => event.event),
        detail.events.map((event) => event.event),
      ]) {
        for (const [i, suffix] of suffixes.entries()) {
          const masked =
            suffix === key || (ending === 'cancel' && suffix.length >= 8 && key.startsWith(suffix));
          expect(
            events
              .filter((event) => event.type === 'message.delta' && event.messageId === String(i))
              .map((event) => (event.type === 'message.delta' ? event.text : ''))
              .join(''),
          ).toBe(prefix + (masked ? '[REDACTED]' : suffix));
        }
      }
      if (ending === 'message.done')
        expect(
          detail.messages
            .filter((message) => message.role === 'assistant')
            .map((message) => message.text),
        ).toEqual(suffixes.map((suffix) => prefix + (suffix === key ? '[REDACTED]' : suffix)));
    },
  );

  it('passes public chunks through immediately when there are no secrets', async () => {
    const result = await startStream(async function* () {
      yield { type: 'message.delta', messageId: 'answer', text: 'Hello' };
      yield { type: 'message.delta', messageId: 'answer', text: ' world' };
      yield { type: 'message.done', messageId: 'answer', text: 'Hello world' };
      yield { type: 'run.done', durationMs: 1 };
    }, []);
    await expect.poll(() => chat.isBotActive('chief')).toBe(false);
    expect(result.appended.filter((event) => event.type === 'message.delta')).toEqual([
      { type: 'message.delta', messageId: 'answer', text: 'Hello' },
      { type: 'message.delta', messageId: 'answer', text: ' world' },
    ]);
  });
  it('deletes an idle conversation and reports missing IDs', async () => {
    const result = await startStream(async function* () {
      yield { type: 'message.done', messageId: 'a', text: 'Answer' };
      yield { type: 'run.done', durationMs: 1 };
    }, []);
    await expect.poll(() => chat.isBotActive('chief')).toBe(false);
    await chat.delete(result.conversationId);
    expect(db.list('chief')).toEqual([]);
    await expect(chat.delete(result.conversationId)).rejects.toThrow('errors.conversationMissing');
  });

  it('cancels a running conversation and waits for its terminal event before deleting', async () => {
    let signal: AbortSignal | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await startStream(async function* (input) {
      signal = input.signal;
      yield { type: 'status', status: 'thinking' };
      await hold;
      yield { type: 'run.done', durationMs: 1, cancelled: true };
    }, []);
    await expect.poll(() => !!signal).toBe(true);
    const deleting = chat.delete(result.conversationId);
    expect(signal!.aborted).toBe(true);
    expect(db.get(result.conversationId).conversation.id).toBe(result.conversationId);
    release!();
    await deleting;
    expect(result.appended.at(-1)).toMatchObject({ type: 'run.done', cancelled: true });
    expect(db.list('chief')).toEqual([]);
    expect(chat.isBotActive('chief')).toBe(false);
  });

  it('bounds cancellation waits and ignores late events even after the database closes', async () => {
    let started = false;
    let finished!: () => void;
    const ended = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await startStream(async function* () {
      started = true;
      yield { type: 'status', status: 'thinking' };
      await hold;
      try {
        yield { type: 'message.done', messageId: 'late', text: 'Late answer' };
        yield { type: 'run.done', durationMs: 6000, cancelled: true };
      } finally {
        finished();
      }
    }, []);
    await expect.poll(() => started).toBe(true);
    vi.useFakeTimers();
    try {
      const deleting = chat.delete(result.conversationId);
      await vi.advanceTimersByTimeAsync(5000);
      await deleting;
    } finally {
      vi.useRealTimers();
    }
    expect(db.list('chief')).toEqual([]);
    expect(chat.isBotActive('chief')).toBe(false);
    const count = result.envelopes.length;
    db.close();
    release!();
    await ended;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(result.envelopes).toHaveLength(count);
    db = new Repository(join(directory, 'chat.sqlite'));
    expect(db.list('chief')).toEqual([]);
  });
  it('refreshes redaction for credentials added during an existing run, including split streams', async () => {
    const current = [secret];
    const apiKey = 'B8m4Y6p2V0r7D9t1';
    const telegram = '123456:J9q8N7k6M5b4V3c2';
    const sessionKey = 'Q4w8E2r6T0y1U3i5';
    const result = await startStream(async function* (input) {
      input.addRedactionSecret!(sessionKey);
      current.push(apiKey, telegram);
      const text = [apiKey, telegram, sessionKey].join(' ');
      for (let offset = 0; offset < text.length; offset += 3)
        yield { type: 'message.delta', messageId: 'answer', text: text.slice(offset, offset + 3) };
      yield { type: 'message.done', messageId: 'answer', text };
      yield { type: 'card', cardId: 'card', kind: 'test', data: { nested: { apiKey, telegram } } };
      yield { type: 'run.error', code: 'test', message: text };
    }, current);
    await expect.poll(() => chat.isBotActive('chief')).toBe(false);
    expect(db.get(result.conversationId).messages.at(-1)?.text).toBe(
      '[REDACTED] [REDACTED] [REDACTED]',
    );
    await expectNoFragments(result, [apiKey, telegram, sessionKey]);
  });
});

it('publishes activity for launches, approval resolution and shutdown cancellation', async () => {
  directory = await temporaryDirectory();
  bots = new BotStore(join(directory, 'bots'), chiefBot(directory, 'en'));
  await bots.init();
  db = new Repository(join(directory, 'chat.sqlite'));
  const events: EventEnvelope[] = [];
  const fake: EngineAdapter = {
    id: 'claude',
    models: async () => [],
    checkAuth: async () => ({
      mode: 'local-cli',
      state: 'unverified',
      messageKey: 'auth.localUnverified',
    }),
    cancel: vi.fn(),
    close: vi.fn(),
    async *run(input) {
      await input.requestApproval!({ title: 'Allow write', details: 'file' });
      yield { type: 'run.done', durationMs: 1, cancelled: input.signal.aborted };
    },
  };
  chat = new ChatService(
    () => bots,
    db,
    { claude: fake, codex: { ...fake, id: 'codex' } },
    () => [],
    (event) => events.push(event),
  );
  const activity = vi.fn();
  chat.on('activity', activity);
  expect(chat.activity()).toEqual({ running: [], pendingApprovals: 0 });
  const run = await chat.send('chief', 'Need approval');
  expect(activity).toHaveBeenLastCalledWith({
    running: [{ botId: 'chief', name: 'Chief', conversationId: run.conversationId }],
    pendingApprovals: 0,
  });
  await expect.poll(() => chat.activity().pendingApprovals).toBe(1);
  expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ pendingApprovals: 1 }));
  const request = events.find(({ event }) => event.type === 'approval.request')!.event;
  if (request.type !== 'approval.request') throw new Error('Missing approval request');
  await chat.approvals.respond(request.approvalId, 'approved');
  await expect.poll(() => chat.activity().running).toEqual([]);
  expect(activity).toHaveBeenLastCalledWith({ running: [], pendingApprovals: 0 });
  await chat.send('chief', 'Cancel during quit');
  await expect.poll(() => chat.activity().pendingApprovals).toBe(1);
  await chat.close();
  expect(fake.cancel).toHaveBeenCalled();
  expect(fake.close).toHaveBeenCalled();
  expect(activity).toHaveBeenLastCalledWith({ running: [], pendingApprovals: 0 });
});
