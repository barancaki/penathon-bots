import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { TelegramBridge, splitTelegramText } from '../src/main/telegram';
import { SettingsStore, type SecretStorage } from '../src/main/settings';
import { BotStore, chiefBot } from '../src/main/bots/store';
import { ChatService } from '../src/main/chat';
import { Repository } from '../src/main/db';
import type { EngineAdapter } from '../src/main/engines/types';
import type { EventEnvelope } from '../src/shared/events';
import type { TelegramStatus } from '../src/shared/telegram';
import { temporaryDirectory, removeTemporary, testBot } from './helpers';

const pollingDelay = vi.hoisted(() => vi.fn());
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) =>
      options?.signal ? pollingDelay(ms, value, options) : actual.setTimeout(ms, value, options),
  };
});
let sleeps: { ms: number; resume(): void }[];
let automaticDelay: boolean;
let clockAdvance: number;

const token = '123456:Only_a_fake_test_token';
const storage: SecretStorage = {
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptStringAsync: async (text) => Buffer.from(Buffer.from(text).toString('base64')),
  decryptStringAsync: async (data) => ({
    result: Buffer.from(data.toString(), 'base64').toString(),
    shouldReEncrypt: false,
  }),
};
type Call = { method: string; body: Record<string, unknown>; at: number };
let directory: string;
let settings: SettingsStore;
let bots: BotStore;
let db: Repository;
let chat: ChatService;
let bridge: TelegramBridge;
let events: EventEnvelope[];
let statuses: TelegramStatus[];
let calls: Call[];
let pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
let getMe: () => unknown;
let engineRun: EngineAdapter['run'];
let releases: (() => void)[];
let inputPrompts: { botId: string; prompt: string; conversationId: string }[];
let updateId: number;
const reply = (result: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: status === 200, result }), { status });
const methods = (method: string) => calls.filter((call) => call.method === method);
const messages = () => methods('sendMessage').map((call) => call.body.text as string);
const message = (text?: string, id = 42, type = 'private') => ({
  message: {
    message_id: updateId + 1,
    chat: { id, type, first_name: 'Alex' },
    ...(text === undefined ? {} : { text }),
  },
});

beforeEach(async () => {
  sleeps = [];
  automaticDelay = true;
  clockAdvance = 0;
  const now = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => now() + clockAdvance);
  pollingDelay.mockImplementation(
    (ms: number, _value: unknown, options: { signal: AbortSignal }) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('aborted'));
        options.signal.addEventListener('abort', abort, { once: true });
        if (automaticDelay) {
          clockAdvance += ms;
          options.signal.removeEventListener('abort', abort);
          resolve();
          return;
        }
        sleeps.push({
          ms,
          resume: () => {
            options.signal.removeEventListener('abort', abort);
            resolve();
          },
        });
      }),
  );
  directory = await temporaryDirectory();
  releases = [];
  events = [];
  statuses = [];
  calls = [];
  inputPrompts = [];
  pending = undefined;
  updateId = 0;
  getMe = () => ({ is_bot: true, username: 'test_bot' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      expect(new URL(url).origin).toBe('https://api.telegram.org');
      expect(options.redirect).toBe('error');
      const method = url.split('/').at(-1)!;
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      calls.push({ method, body, at: Date.now() });
      if (options.signal?.aborted) throw new Error('aborted');
      if (method === 'getMe') return reply(getMe());
      if (method === 'getUpdates') {
        return new Promise<Response>((resolve, reject) => {
          const abort = () => {
            pending = undefined;
            reject(new Error('aborted'));
          };
          options.signal?.addEventListener('abort', abort, { once: true });
          pending = {
            resolve: (value) => {
              options.signal?.removeEventListener('abort', abort);
              pending = undefined;
              resolve(value instanceof Response ? value : reply(value));
            },
            reject: (error) => {
              options.signal?.removeEventListener('abort', abort);
              pending = undefined;
              reject(error);
            },
          };
        });
      }
      return reply(method === 'sendMessage' ? { message_id: methods('sendMessage').length } : true);
    }),
  );
  settings = new SettingsStore(directory, storage);
  await settings.init();
  bots = new BotStore(join(directory, 'bots'), chiefBot(directory, 'tr'));
  await bots.init();
  await bots.save(testBot(directory, { id: 'research', name: 'Araştırma Asistanı' }));
  db = new Repository(join(directory, 'chat.sqlite'));
  engineRun = async function* () {
    yield { type: 'message.done', messageId: 'answer', text: 'Yanıt' };
    yield { type: 'run.done', durationMs: 1 };
  };
  const engine: EngineAdapter = {
    id: 'claude',
    models: async () => [],
    cancel: () => {},
    checkAuth: async () => ({
      mode: 'local-cli',
      state: 'unverified',
      messageKey: 'auth.localUnverified',
    }),
    run: (input) => {
      inputPrompts.push({
        botId: input.bot.id,
        prompt: input.prompt,
        conversationId: input.conversationId,
      });
      return engineRun(input);
    },
  };
  chat = new ChatService(
    () => bots,
    db,
    { claude: engine, codex: { ...engine, id: 'codex' } },
    () => settings.redactionSecrets(),
    (event) => {
      events.push(event);
      bridge.onEvent(event);
    },
  );
  bridge = new TelegramBridge(
    settings,
    () => bots,
    db,
    chat,
    (status) => statuses.push(status),
  );
  await bridge.init();
});
afterEach(async () => {
  for (const release of releases) release();
  await bridge?.close();
  await chat?.close();
  await bots?.close();
  db?.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (directory) await removeTemporary(directory);
});
async function connect() {
  const status = await bridge.setToken(token);
  expect(status).toMatchObject({ configured: true, enabled: true, botUsername: 'test_bot' });
  await expect.poll(() => !!pending).toBe(true);
}
async function push(...updates: object[]) {
  await expect.poll(() => !!pending).toBe(true);
  pending!.resolve(updates.map((update) => ({ update_id: updateId++, ...update })));
  await expect.poll(() => methods('getUpdates').at(-1)?.body.offset).toBe(updateId);
}
async function pair() {
  const status = await bridge.startPairing();
  expect(status.pairingCode).toMatch(/^\d{6}$/);
  await push(message('/start ' + status.pairingCode));
  expect(bridge.status().pairedChat).toEqual({ id: 42, name: 'Alex' });
}
async function connectedPair() {
  await connect();
  await pair();
}
async function answered(count = 1) {
  await expect.poll(() => messages().filter((text) => text === 'Yanıt').length).toBe(count);
}
function hold() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}

it('validates getMe before storing, encrypts/reloads secrets and reports invalid tokens safely', async () => {
  expect(await bridge.setToken('bad token')).toMatchObject({
    configured: false,
    lastError: 'telegram.invalidToken',
  });
  expect(methods('getMe')).toHaveLength(0);
  getMe = () => {
    throw new Error('Failed https://api.telegram.org/bot' + token + '/getMe');
  };
  expect(await bridge.setToken(token)).toMatchObject({
    configured: false,
    lastError: 'errors.operationFailed',
  });
  getMe = () => ({ is_bot: false, username: token });
  expect(await bridge.setToken(token)).toMatchObject({
    configured: false,
    lastError: 'telegram.invalidToken',
  });
  getMe = () => ({ is_bot: true, username: 'test_bot' });
  await connect();
  const reloaded = new SettingsStore(directory, storage);
  await reloaded.init();
  expect(await reloaded.apiKey('telegram')).toBe(token);
  expect(reloaded.get().telegram.hasToken).toBe(true);
  for (const file of ['settings.json', 'secrets.json'])
    expect(await readFile(join(directory, file), 'utf8')).not.toContain(token);
  expect(await bridge.setToken(null)).toMatchObject({
    configured: false,
    enabled: false,
    running: false,
  });
  expect(await settings.apiKey('telegram')).toBeUndefined();
  expect(JSON.stringify(statuses)).not.toContain(token);
});
it('reports HTTP 401 without storing the candidate token', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(reply(undefined, 401));
  expect(await bridge.setToken(token)).toMatchObject({
    lastError: 'telegram.invalidToken',
    configured: false,
  });
});
it('polls with timeout/offset, ignores duplicates and stops on conflict', async () => {
  await connect();
  expect(methods('getUpdates')[0].body).toEqual({
    timeout: 30,
    offset: 0,
    allowed_updates: ['message', 'callback_query'],
  });
  pending!.resolve([{ update_id: 78, ...message('ignored', 99) }]);
  await expect.poll(() => methods('getUpdates').at(-1)?.body.offset).toBe(79);
  pending!.resolve([{ update_id: 78, ...message('ignored', 99) }]);
  await expect.poll(() => methods('getUpdates').length).toBe(3);
  expect(methods('getUpdates').at(-1)?.body.offset).toBe(79);
  pending!.resolve(reply(undefined, 409));
  await expect.poll(() => bridge.status().lastError).toBe('telegram.conflict');
  expect(bridge.status().running).toBe(false);
  expect(methods('sendMessage')).toHaveLength(0);
});
it('stops on revoked tokens and can restart after being disabled', async () => {
  await connect();
  pending!.resolve(reply(undefined, 401));
  await expect.poll(() => bridge.status().lastError).toBe('telegram.invalidToken');
  expect(bridge.status().running).toBe(false);
  await bridge.setOptions({ enabled: false });
  await bridge.setOptions({ enabled: true });
  await expect.poll(() => !!pending).toBe(true);
  await bridge.close();
  expect(pending).toBeUndefined();
  expect(bridge.status().running).toBe(false);
});
it('pairs only with an active exact code in a private chat and ignores other senders', async () => {
  await connect();
  const { pairingCode } = await bridge.startPairing();
  await push(message('000000'), message('/start ' + pairingCode, 42, 'group'), message('hi', 99));
  expect(bridge.status().pairedChat).toBeUndefined();
  expect(messages()).toEqual([]);
  await push(message(pairingCode));
  expect(bridge.status().pairedChat?.id).toBe(42);
  expect(bridge.status().pairingCode).toBeUndefined();
  const before = messages().length;
  await push(message('hack', 99), message('hack', 42, 'supergroup'), message(undefined, 99));
  expect(messages()).toHaveLength(before);
  expect(inputPrompts).toEqual([]);
  await bridge.unpair();
  await push(message(pairingCode));
  expect(bridge.status().pairedChat).toBeUndefined();
});
it('rejects expired pairing codes and publishes their removal', async () => {
  await connect();
  const { pairingCode } = await bridge.startPairing();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  await bridge.startPairing();
  await vi.advanceTimersByTimeAsync(600_001);
  expect(bridge.status().pairingCode).toBeUndefined();
  expect(statuses.at(-1)?.pairingCode).toBeUndefined();
  vi.useRealTimers();
  await push(message(pairingCode));
  expect(bridge.status().pairedChat).toBeUndefined();
  expect(messages()).toEqual([]);
});
it('routes into one persisted Telegram conversation, supports fuzzy/multiword bot commands and /yeni', async () => {
  await connectedPair();
  await push(message('hello'));
  await answered();
  const first = settings.get().telegram.conversationId!;
  expect(db.get(first).conversation.title).toBe('Telegram');
  await push(message('again'));
  await answered(2);
  expect(settings.get().telegram.conversationId).toBe(first);
  await push(message('/bot arastir araştır'));
  await answered(3);
  expect(inputPrompts.at(-1)).toMatchObject({ botId: 'research', prompt: 'araştır' });
  await push(message('/bot Araştırma Asistanı incele'));
  await answered(4);
  expect(inputPrompts.at(-1)).toMatchObject({ botId: 'research', prompt: 'incele' });
  await bridge.setOptions({ routeTo: 'research' });
  const previous = settings.get().telegram.conversationId;
  await push(message('/yeni'), message('fresh'));
  await answered(5);
  expect(settings.get().telegram.conversationId).not.toBe(previous);
  expect(inputPrompts.at(-1)?.botId).toBe('research');
  const deleted = settings.get().telegram.conversationId!;
  await chat.delete(deleted);
  await push(message('restore'));
  await answered(6);
  expect(settings.get().telegram.conversationId).not.toBe(deleted);
  await expect(bridge.setOptions({ routeTo: 'absent' })).rejects.toThrow();
});
it('keeps existing settings and conversation on app restart', async () => {
  await connectedPair();
  await push(message('one'));
  await answered();
  const conversationId = settings.get().telegram.conversationId;
  await bridge.close();
  const reloaded = new SettingsStore(directory, storage);
  await reloaded.init();
  bridge = new TelegramBridge(
    reloaded,
    () => bots,
    db,
    chat,
    (status) => statuses.push(status),
  );
  await bridge.init();
  await push(message('two'));
  await answered(2);
  expect(reloaded.get().telegram.conversationId).toBe(conversationId);
  expect(bridge.status().pairedChat?.id).toBe(42);
});
it('queues behind an app run, does not block polling, and sends typing during execution', async () => {
  await connectedPair();
  const gate = hold();
  let first = true;
  engineRun = async function* () {
    if (first) {
      first = false;
      await gate.promise;
    }
    yield { type: 'message.done', messageId: 'answer', text: 'Yanıt' };
    yield { type: 'run.done', durationMs: 1 };
  };
  await chat.send('chief', 'from app');
  await push(message('queued'), message('second'));
  expect(messages().some((text) => text.includes('sıraya aldım'))).toBe(true);
  expect(inputPrompts).toHaveLength(1);
  gate.release();
  await answered(2);
  expect(inputPrompts.map((input) => input.prompt)).toEqual(['from app', 'queued', 'second']);
  expect(methods('sendChatAction').every((call) => call.body.action === 'typing')).toBe(true);
  expect(methods('sendChatAction').length).toBeGreaterThanOrEqual(2);
});
it('splits long replies at 4096 without markup or broken emoji, sends errors briefly', async () => {
  const text = 'a'.repeat(4095) + '😀' + '<unsafe>&_*'.repeat(600);
  expect(splitTelegramText(text).join('')).toBe(text);
  expect(
    splitTelegramText(text).every((part) => part.length <= 4096 && !/[\uD800-\uDBFF]$/.test(part)),
  ).toBe(true);
  await connectedPair();
  engineRun = async function* () {
    yield { type: 'message.done', messageId: 'answer', text };
    yield { type: 'run.done', durationMs: 1 };
  };
  const before = messages().length;
  await push(message('long'));
  await expect.poll(() => messages().slice(before).join('')).toBe(text);
  expect(methods('sendMessage').every((call) => !('parse_mode' in call.body))).toBe(true);
  engineRun = async function* () {
    yield { type: 'run.error', code: 'engine', message: token };
  };
  await push(message('fail'));
  await expect.poll(() => messages().at(-1)).toBe('Koşu tamamlanamadı. Uygulamayı kontrol et.');
});
it.each(['telegram-approve', 'telegram-reject', 'app-edited', 'app-reject'] as const)(
  'resolves inline approvals from either side: %s',
  async (source) => {
    await connectedPair();
    engineRun = async function* (input) {
      await input.callTool!('create_bot', {
        draft: { name: 'Editör', role: 'Yazı', engine: 'claude', instructions: 'Yaz.' },
      });
      yield { type: 'run.done', durationMs: 1 };
    };
    await push(message('approval'));
    await expect
      .poll(() => methods('sendMessage').some((call) => !!call.body.reply_markup))
      .toBe(true);
    const card = methods('sendMessage').find((call) => !!call.body.reply_markup)!;
    expect(card.body.text).toContain('Editör · Yazı · claude');
    const markup = card.body.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(markup.inline_keyboard[0].map((button) => button.text)).toEqual(['Onayla', 'Vazgeç']);
    const request = events
      .map((event) => event.event)
      .find((event) => event.type === 'approval.request')!;
    expect(JSON.stringify(markup)).not.toContain(request.approvalId);
    const data = markup.inline_keyboard[0][source === 'telegram-reject' ? 1 : 0].callback_data;
    expect(data.length).toBeLessThan(64);
    const cardId = methods('sendMessage').indexOf(card) + 1;
    const callback = (id = 42) => ({
      callback_query: {
        id: 'query',
        from: { id },
        message: { message_id: cardId, chat: { id, type: 'private' } },
        data,
      },
    });
    await push(callback(99));
    expect(methods('answerCallbackQuery')).toHaveLength(0);
    if (source.startsWith('telegram')) await push(callback());
    else
      await chat.approvals.respond(
        request.approvalId,
        source === 'app-reject' ? 'rejected' : 'approved',
        source === 'app-edited'
          ? { name: 'Edited Writer', role: 'Write', engine: 'claude', instructions: 'Yaz.' }
          : undefined,
      );
    await expect.poll(() => methods('editMessageText').length).toBe(1);
    const edit = methods('editMessageText')[0].body;
    expect(edit.text).toContain(source.endsWith('reject') ? 'Vazgeçildi' : 'Onaylandı');
    expect(edit.reply_markup).toEqual({ inline_keyboard: [] });
    if (source === 'app-edited')
      expect(bots.list().some((bot) => bot.name === 'Edited Writer')).toBe(true);
    await push(callback());
    await expect
      .poll(() => methods('answerCallbackQuery').length)
      .toBe(source.startsWith('telegram') ? 2 : 1);
    expect(methods('editMessageText')).toHaveLength(1);
  },
);
it('handles resolution before the approval message has finished sending', async () => {
  await connectedPair();
  const gate = hold();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const body = JSON.parse(String(args[1]?.body));
    if (body.reply_markup) await gate.promise;
    return original(...args);
  });
  engineRun = async function* (input) {
    await input.requestApproval!({ title: 'Confirm', details: '' });
    yield { type: 'run.done', durationMs: 1 };
  };
  await push(message('approve'));
  await expect
    .poll(() => events.some((envelope) => envelope.event.type === 'approval.request'))
    .toBe(true);
  const request = events
    .map((envelope) => envelope.event)
    .find((event) => event.type === 'approval.request')!;
  await chat.approvals.respond(request.approvalId, 'approved');
  gate.release();
  await expect.poll(() => methods('editMessageText').length).toBe(1);
});
it('notifies routine done/error (600 chars), skips skipped and disabled notifications', async () => {
  await connectedPair();
  const routine = await chat.routines.save('research', {
    name: 'Sabah özeti',
    prompt: 'summary',
    enabled: true,
    schedule: { kind: 'daily', time: '09:00' },
  });
  engineRun = async function* () {
    yield { type: 'message.done', messageId: 'answer', text: 'x'.repeat(900) };
    yield { type: 'run.done', durationMs: 1 };
  };
  await chat.routines.runNow('research', routine.routine.id);
  await expect.poll(() => messages().some((text) => text.startsWith('⏰'))).toBe(true);
  expect(messages().at(-1)).toBe('⏰ Sabah özeti: ' + 'x'.repeat(600));
  engineRun = async function* () {
    yield { type: 'run.error', code: 'test', message: 'Kısa hata' };
  };
  await expect.poll(() => chat.isBotActive('research')).toBe(false);
  await chat.routines.runNow('research', routine.routine.id);
  await expect.poll(() => messages().filter((text) => text.startsWith('⏰')).length).toBe(2);
  expect(messages().at(-1)).toBe('⏰ Sabah özeti: Kısa hata');
  db.skipRoutine('research', routine.routine.id, 'busy');
  expect(messages().filter((text) => text.startsWith('⏰'))).toHaveLength(2);
  db.skipRoutine('research', routine.routine.id, 'launch failed', new Date(), 'error');
  await expect.poll(() => messages().filter((text) => text.startsWith('⏰')).length).toBe(3);
  await bridge.setOptions({ notifyRoutines: false });
  db.skipRoutine('research', routine.routine.id, 'silent', new Date(), 'error');
  expect(messages().filter((text) => text.startsWith('⏰'))).toHaveLength(3);
});
it('limits accepted messages to 20 per rolling minute and handles unsupported media', async () => {
  await connectedPair();
  await push(message(undefined));
  expect(messages().at(-1)).toContain('henüz desteklenmiyor');
  const gate = hold();
  engineRun = async function* () {
    await gate.promise;
    yield { type: 'run.done', durationMs: 1 };
  };
  await push(...Array.from({ length: 21 }, (_, index) => message('run ' + index)));
  expect(messages().filter((text) => text.includes('Yavaşla'))).toHaveLength(2);
  gate.release();
  await expect.poll(() => inputPrompts.length, { timeout: 5000 }).toBe(19);
  clockAdvance += 60_001;
  await push(message('after window'));
  await expect.poll(() => inputPrompts.length).toBe(20);
});
it('redacts the token from persisted prompts, streaming events, approval summaries, status and logs', async () => {
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
  await connectedPair();
  engineRun = async function* () {
    yield { type: 'message.delta', messageId: 'answer', text: token.slice(0, 10) };
    yield { type: 'message.delta', messageId: 'answer', text: token.slice(10) };
    yield { type: 'message.done', messageId: 'answer', text: token };
    yield { type: 'run.done', durationMs: 1 };
  };
  await push(message('echo ' + token));
  await expect.poll(() => messages().at(-1)).toBe('[REDACTED]');
  const detail = db.get(settings.get().telegram.conversationId!);
  expect(detail.messages[0].text).toBe('echo [REDACTED]');
  expect(
    JSON.stringify({
      detail,
      events,
      statuses,
      messages: messages(),
      logs: logs.map((log) => log.mock.calls),
    }),
  ).not.toContain(token);
});
it('backs off exponentially up to 60 seconds, resets after success, and cancels waits on stop', async () => {
  automaticDelay = false;
  await connect();
  const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
  for (const [index, ms] of delays.entries()) {
    pending!.reject(new Error('Network error ' + token));
    await expect.poll(() => sleeps.length).toBe(index + 1);
    expect(sleeps[index].ms).toBe(ms);
    expect(bridge.status().lastError).toBe('errors.operationFailed');
    sleeps[index].resume();
    await expect.poll(() => !!pending).toBe(true);
  }
  await push(message('ignored', 99));
  expect(bridge.status().lastError).toBeUndefined();
  pending!.resolve(reply(undefined, 503));
  await expect.poll(() => sleeps.length).toBe(9);
  expect(sleeps[8].ms).toBe(1000);
  await bridge.setOptions({ enabled: false });
  expect(bridge.status().running).toBe(false);
  expect(JSON.stringify(statuses)).not.toContain(token);
});
it('ignores malformed updates without getting stuck and reports unknown bot commands briefly', async () => {
  await connectedPair();
  pending!.resolve([{ update_id: 100, message: { chat: 'bad' } }]);
  // The malformed update still advances Telegram's acknowledgment offset.
  updateId = 101;
  await expect.poll(() => methods('getUpdates').at(-1)?.body.offset).toBe(101);
  await push(message('/bot absent question'));
  expect(messages().at(-1)).toContain('Bot bulunamadı');
  await push(message('works'));
  await answered();
});
it('sends typing every five seconds and stops the timer when a run finishes', async () => {
  await connectedPair();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const gate = hold();
  engineRun = async function* () {
    await gate.promise;
    yield { type: 'run.done', durationMs: 1 };
  };
  await push(message('work'));
  await expect.poll(() => methods('sendChatAction').length).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(methods('sendChatAction')).toHaveLength(3);
  gate.release();
  await expect.poll(() => messages().at(-1)).toBe('Tamamlandı.');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(methods('sendChatAction')).toHaveLength(3);
  vi.useRealTimers();
});
it('cancels queued Telegram work on unpair without replying to a newly paired user', async () => {
  await connectedPair();
  const gate = hold();
  engineRun = async function* () {
    await gate.promise;
    yield { type: 'message.done', messageId: 'answer', text: 'old answer' };
    yield { type: 'run.done', durationMs: 1 };
  };
  await push(message('active'), message('queued'));
  await expect.poll(() => inputPrompts.length).toBe(1);
  await bridge.unpair();
  const { pairingCode } = await bridge.startPairing();
  await push(message(pairingCode, 99));
  gate.release();
  await expect.poll(() => chat.isBotActive('chief')).toBe(false);
  expect(inputPrompts.map((input) => input.prompt)).toEqual(['active']);
  expect(messages()).not.toContain('old answer');
  expect(bridge.status().pairedChat?.id).toBe(99);
});
it('redacts token-bearing approval fields and bot previews before Telegram and application events', async () => {
  await connectedPair();
  engineRun = async function* (input) {
    await input.requestApproval!({
      title: token,
      details: token,
      kind: 'bot.create',
      data: { bot: { name: token, role: token, engine: 'claude' } },
    });
    yield { type: 'run.done', durationMs: 1 };
  };
  await push(message('approval'));
  await expect
    .poll(() => methods('sendMessage').some((call) => !!call.body.reply_markup))
    .toBe(true);
  const request = events
    .map((event) => event.event)
    .find((event) => event.type === 'approval.request')!;
  await chat.approvals.respond(request.approvalId, 'rejected');
  await expect.poll(() => methods('editMessageText').length).toBe(1);
  expect(
    JSON.stringify({
      statuses,
      events,
      calls: calls.filter((call) => call.method !== 'getMe' && call.method !== 'getUpdates'),
    }),
  ).not.toContain(token);
});
it('includes unchanged name and engine when a bot update needs approval', async () => {
  await connectedPair();
  engineRun = async function* (input) {
    await input.callTool!('update_bot', { id: 'research', patch: { role: 'Yeni rol' } });
    yield { type: 'run.done', durationMs: 1 };
  };
  await push(message('update'));
  await expect
    .poll(() => methods('sendMessage').some((call) => !!call.body.reply_markup))
    .toBe(true);
  expect(methods('sendMessage').find((call) => !!call.body.reply_markup)?.body.text).toContain(
    'Araştırma Asistanı · Yeni rol · claude',
  );
  const request = events
    .map((event) => event.event)
    .find((event) => event.type === 'approval.request')!;
  await chat.approvals.respond(request.approvalId, 'rejected');
});
it('locks the active code after five private-chat failures across all senders, silently', async () => {
  await connect();
  const { pairingCode } = await bridge.startPairing();
  await push(...Array.from({ length: 8 }, (_, index) => message('wrong', index + 100, 'group')));
  expect(bridge.status().pairingCode).toBe(pairingCode);
  await push(...Array.from({ length: 4 }, (_, index) => message('wrong', index + 100)));
  expect(bridge.status().pairingCode).toBe(pairingCode);
  await push(message('/start wrong', 105));
  expect(bridge.status()).toMatchObject({
    lastError: 'telegram.pairingLocked',
  });
  expect(bridge.status().pairingCode).toBeUndefined();
  await push(message(pairingCode));
  expect(bridge.status().pairedChat).toBeUndefined();
  expect(bridge.status().lastError).toBe('telegram.pairingLocked');
  expect(messages()).toEqual([]);
  const next = await bridge.startPairing();
  expect(next.lastError).toBeUndefined();
  await push(message(next.pairingCode));
  expect(bridge.status().pairedChat?.id).toBe(42);
});
it('limits every chat to one outgoing request per second and total callbacks to 25', async () => {
  await connectedPair();
  await push(message('one'), message('two'), message('three'));
  await answered(3);
  const perChat = calls.filter((call) => call.body.chat_id === 42);
  for (let index = 1; index < perChat.length; index++)
    expect(perChat[index].at - perChat[index - 1].at).toBeGreaterThanOrEqual(1000);
  await push(
    ...Array.from({ length: 55 }, (_, index) => ({
      callback_query: {
        id: 'expired-' + index,
        from: { id: 42 },
        data: 'expired',
        message: { message_id: 1, chat: { id: 42, type: 'private' } },
      },
    })),
  );
  await expect.poll(() => methods('answerCallbackQuery').length).toBe(55);
  const callbacks = methods('answerCallbackQuery');
  for (let index = 25; index < callbacks.length; index++)
    expect(callbacks[index].at - callbacks[index - 25].at).toBeGreaterThanOrEqual(1000);
});
it.each([200, 429])(
  'retries 429 cards three times using retry_after, preserving queued routine notifications (HTTP %s)',
  async (status) => {
    await connectedPair();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let attempts = 0;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const result = await original(...args);
      const body = JSON.parse(String(args[1]?.body));
      if (body.reply_markup && !body.message_id && attempts++ < 3)
        return new Response(
          JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 3 } }),
          { status },
        );
      return result;
    });
    engineRun = async function* (input) {
      await input.requestApproval!({ title: 'Retry this card', details: '' });
      yield { type: 'run.done', durationMs: 1 };
    };
    await push(message('approve'));
    await expect.poll(() => attempts).toBe(4);
    db.skipRoutine('research', 'notice', 'Routine preserved', new Date(), 'error');
    await expect
      .poll(() => messages().some((text) => text.includes('Routine preserved')))
      .toBe(true);
    const cards = methods('sendMessage').filter((call) => !!call.body.reply_markup);
    expect(cards).toHaveLength(4);
    for (let index = 1; index < cards.length; index++)
      expect(cards[index].at - cards[index - 1].at).toBeGreaterThanOrEqual(3000);
    const request = events
      .map((event) => event.event)
      .find((event) => event.type === 'approval.request')!;
    await chat.approvals.respond(request.approvalId, 'approved');
    await expect.poll(() => methods('editMessageText').length).toBe(1);
  },
);
it.each(['delegation', 'temporary', 'room-chain'] as const)(
  'forwards child approvals belonging to the Telegram root: %s',
  async (mode) => {
    await connectedPair();
    await bots.save(testBot(directory, { id: 'third', name: 'Third' }));
    const room = chat.rooms.create({ name: 'Root chain', members: ['chief', 'research', 'third'] });
    const gate = hold();
    engineRun = async function* (input) {
      if (input.bot.id === 'chief') {
        if (mode === 'delegation')
          await input.callTool!('delegate_to_bot', { id: 'research', task: 'child' });
        else if (mode === 'temporary')
          await input.callTool!('spawn_temp_bot', {
            name: 'Temp',
            engine: 'claude',
            instructions: 'Help.',
            task: 'child',
          });
        else await input.callTool!('post_to_room', { roomId: room.id, text: '@research child' });
      } else {
        if (mode === 'room-chain') await gate.promise;
        await input.requestApproval!({ title: 'Child ' + input.bot.id, details: '' });
        yield {
          type: 'message.done',
          messageId: 'answer',
          text: mode === 'room-chain' && input.bot.id === 'research' ? '@third next' : 'finished',
        };
      }
      yield { type: 'run.done', durationMs: 1 };
    };
    await push(message('start chain'));
    if (mode === 'room-chain') {
      await expect.poll(() => chat.isBotActive('chief')).toBe(false);
      gate.release();
    }
    for (let count = 1; count <= (mode === 'room-chain' ? 2 : 1); count++) {
      await expect
        .poll(() => methods('sendMessage').filter((call) => !!call.body.reply_markup).length)
        .toBe(count);
      const request = events
        .filter((envelope) => envelope.event.type === 'approval.request')
        .at(-1)!;
      const root = db.runInfo(request.rootRunId!);
      expect(root.botId).toBe('chief');
      await expect.poll(() => settings.get().telegram.conversationId).toBe(root.conversationId);
      expect(request.runId).not.toBe(request.rootRunId);
      if (request.event.type !== 'approval.request') throw new Error('missing approval');
      await chat.approvals.respond(request.event.approvalId, 'approved');
      await expect.poll(() => methods('editMessageText').length).toBe(count);
    }
  },
);
it('caps a persistently rate-limited send at three retries', async () => {
  await connectedPair();
  const original = vi.mocked(fetch).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(fetch).mockImplementation(async (...args) => {
    const result = await original(...args);
    const body = JSON.parse(String(args[1]?.body));
    if (body.text === 'Yanıt') {
      attempts++;
      return new Response(
        JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 2 } }),
        { status: 429 },
      );
    }
    return result;
  });
  await push(message('rate limited'));
  await expect
    .poll(() => messages().some((text) => text.startsWith('İşlem tamamlanamadı')))
    .toBe(true);
  expect(attempts).toBe(4);
});
it('does not forward approvals from an unrelated application run', async () => {
  await connectedPair();
  const gate = hold();
  engineRun = async function* (input) {
    if (input.bot.id === 'chief') await gate.promise;
    else await input.requestApproval!({ title: 'App-only approval', details: '' });
    yield { type: 'run.done', durationMs: 1 };
  };
  await push(message('hold root'));
  await chat.send('research', 'app only');
  await expect
    .poll(() => events.some((envelope) => envelope.event.type === 'approval.request'))
    .toBe(true);
  expect(methods('sendMessage').filter((call) => !!call.body.reply_markup)).toHaveLength(0);
  const request = events
    .map((envelope) => envelope.event)
    .find((event) => event.type === 'approval.request')!;
  await chat.approvals.respond(request.approvalId, 'rejected');
  gate.release();
});
