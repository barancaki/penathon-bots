import { randomBytes, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { TelegramStatus } from '../shared/telegram';
import { telegramOptionsSchema, type TelegramOptions } from '../shared/settings';
import type { EventEnvelope } from '../shared/events';
import type { RoutineRun } from '../shared/routines';
import type { SettingsStore } from './settings';
import type { BotStore } from './bots/store';
import type { ChatService } from './chat';
import type { Repository } from './db';
import { redact } from './engines/common';

const chatSchema = z.object({
  id: z.number().int().safe(),
  type: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});
const messageSchema = z.object({
  message_id: z.number().int(),
  chat: chatSchema,
  text: z.string().max(100_000).optional(),
});
const updateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({ id: z.number().int().safe() }),
      data: z.string().max(64).optional(),
      message: messageSchema.optional(),
    })
    .optional(),
});
type Update = z.infer<typeof updateSchema>;
type Approval = {
  approvalId: string;
  chatId: number;
  text: string;
  controller: AbortController;
  message: Promise<number | undefined>;
};
class TelegramError extends Error {
  constructor(
    readonly code?: number,
    readonly retryAfter = 1,
  ) {
    super(
      code === 409
        ? 'telegram.conflict'
        : code === 401 || code === 404
          ? 'telegram.invalidToken'
          : 'errors.operationFailed',
    );
  }
}

/** Plain text, bounded in UTF-16 units without cutting an emoji's surrogate pair. */
export function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 4096, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}
const nameKey = (text: string) =>
  text
    .toLocaleLowerCase('tr')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\s_-]/g, '')
    .replace(/ı/g, 'i');

export class TelegramBridge {
  private token?: string;
  private botUsername?: string;
  private lastError?: string;
  private pairing?: { code: string; expires: number; attempts: number };
  private pairingTimer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private polling?: Promise<void>;
  private offset = 0;
  private closing = false;
  private changes = Promise.resolve();
  private queue = Promise.resolve();
  private queued = 0;
  private outgoing = Promise.resolve();
  private sentAt: number[] = [];
  private chatSentAt = new Map<number, number>();
  private accepted: number[] = [];
  // shortcut: retain root ids until polling stops; prune finished room chains for long-lived sessions.
  private runs = new Set<string>();
  private approvals = new Map<string, Approval>();
  private effects = new Set<Promise<unknown>>();
  private routineFinished = (run: RoutineRun) => {
    this.background(this.notifyRoutine(run));
  };
  constructor(
    private settings: SettingsStore,
    private bots: () => BotStore,
    private db: Repository,
    private chat: ChatService,
    private emit: (status: TelegramStatus) => void,
  ) {
    db.on('routineFinished', this.routineFinished);
  }
  async init(): Promise<void> {
    this.token = await this.settings.apiKey('telegram');
    this.start();
  }
  status(): TelegramStatus {
    const options = this.settings.get().telegram;
    return redact(
      {
        configured: options.hasToken,
        running: !!this.controller && !this.controller.signal.aborted,
        enabled: options.enabled,
        routeTo: options.routeTo,
        notifyRoutines: options.notifyRoutines,
        botUsername: this.botUsername,
        pairedChat: options.pairedChatId
          ? { id: options.pairedChatId, name: options.pairedName ?? String(options.pairedChatId) }
          : undefined,
        pairingCode:
          this.pairing && this.pairing.expires > Date.now() ? this.pairing.code : undefined,
        lastError: this.lastError,
      },
      this.token ? [this.token] : [],
    );
  }
  private publish(): void {
    this.emit(this.status());
  }
  private change(action: () => Promise<TelegramStatus>): Promise<TelegramStatus> {
    const task = this.changes.then(() => {
      if (this.closing) throw new Error('errors.operationFailed');
      return action();
    });
    this.changes = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  setToken(input: string | null): Promise<TelegramStatus> {
    return this.change(async () => {
      const token = input?.trim() ?? null;
      let username: string | undefined;
      if (token !== null) {
        try {
          if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || token.length > 8192)
            throw new TelegramError(401);
          username = await this.getMe(token);
        } catch (error) {
          this.lastError =
            error instanceof TelegramError ? error.message : 'errors.operationFailed';
          this.publish();
          return this.status();
        }
      }
      await this.settings.setTelegramToken(token);
      await this.stop();
      this.token = token ?? undefined;
      this.botUsername = username;
      this.lastError = undefined;
      this.offset = 0;
      this.clearPairing();
      this.approvals.clear();
      this.accepted = [];
      await this.settings.setTelegram({
        enabled: !!token,
        pairedChatId: undefined,
        pairedName: undefined,
        conversationId: undefined,
      });
      this.start();
      this.publish();
      return this.status();
    });
  }
  startPairing(): Promise<TelegramStatus> {
    return this.change(async () => {
      if (!this.token || this.settings.get().telegram.pairedChatId) return this.status();
      this.clearPairing();
      this.pairing = {
        code: String(randomInt(100_000, 1_000_000)),
        expires: Date.now() + 600_000,
        attempts: 0,
      };
      this.pairingTimer = setTimeout(() => {
        this.clearPairing();
        this.publish();
      }, 600_000);
      await this.settings.setTelegram({ enabled: true });
      this.lastError = undefined;
      this.start();
      this.publish();
      return this.status();
    });
  }
  unpair(): Promise<TelegramStatus> {
    return this.change(async () => {
      await this.stop();
      this.clearPairing();
      this.approvals.clear();
      this.accepted = [];
      await this.settings.setTelegram({
        pairedChatId: undefined,
        pairedName: undefined,
        conversationId: undefined,
      });
      this.start();
      this.publish();
      return this.status();
    });
  }
  setOptions(input: TelegramOptions): Promise<TelegramStatus> {
    return this.change(async () => {
      const options = telegramOptionsSchema.parse(input);
      if (options.routeTo !== undefined) this.bots().get(options.routeTo);
      await this.settings.setTelegram(options);
      if (options.enabled === false) {
        await this.stop();
        this.clearPairing();
        this.approvals.clear();
      } else this.start();
      this.publish();
      return this.status();
    });
  }
  private clearPairing(): void {
    clearTimeout(this.pairingTimer);
    this.pairing = undefined;
  }
  private async request(
    token: string,
    method: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(method === 'getUpdates' ? 40_000 : 10_000),
          ...(signal ? [signal] : []),
        ]),
      });
      const result = z
        .object({
          ok: z.boolean(),
          error_code: z.number().optional(),
          result: z.unknown().optional(),
          parameters: z
            .object({ retry_after: z.number().int().nonnegative().optional() })
            .optional(),
        })
        .safeParse(await response.json().catch(() => undefined));
      if (!response.ok || !result.success || !result.data.ok)
        throw new TelegramError(
          response.ok && result.success ? result.data.error_code : response.status,
          result.success ? result.data.parameters?.retry_after : undefined,
        );
      return result.data.result;
    } catch (error) {
      // Fetch errors include the token-bearing URL; never propagate their text or cause.
      throw error instanceof TelegramError ? error : new TelegramError();
    }
  }
  private async getMe(token: string, signal?: AbortSignal): Promise<string> {
    const result = await this.request(token, 'getMe', {}, signal);
    const bot = z
      .object({ is_bot: z.literal(true), username: z.string().min(1).max(64) })
      .safeParse(result);
    if (!bot.success) throw new TelegramError(401);
    return bot.data.username;
  }
  private start(): void {
    if (
      this.closing ||
      !this.token ||
      !this.settings.get().telegram.enabled ||
      (this.controller && !this.controller.signal.aborted)
    )
      return;
    const controller = new AbortController();
    this.controller = controller;
    this.polling = this.poll(this.token, controller);
  }
  private async stop(): Promise<void> {
    this.controller?.abort();
    await this.polling;
    await this.queue;
    await this.outgoing;
    this.runs.clear();
    this.controller = undefined;
    this.publish();
  }
  private async poll(token: string, controller: AbortController): Promise<void> {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        if (!this.botUsername) {
          this.botUsername = await this.getMe(token, controller.signal);
          this.publish();
        }
        const result = await this.request(
          token,
          'getUpdates',
          { offset: this.offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
          controller.signal,
        );
        const updates = z.array(z.unknown()).parse(result);
        if (controller.signal.aborted) break;
        for (const value of updates) {
          const parsed = updateSchema.safeParse(value);
          if (!parsed.success) {
            const id = z.object({ update_id: z.number().int().nonnegative() }).safeParse(value);
            if (id.success) this.offset = Math.max(this.offset, id.data.update_id + 1);
            continue;
          }
          if (parsed.data.update_id < this.offset) continue;
          await this.receive(parsed.data, controller);
          this.offset = parsed.data.update_id + 1;
          if (controller.signal.aborted) break;
        }
        failures = 0;
        if (this.lastError && this.lastError !== 'telegram.pairingLocked') {
          this.lastError = undefined;
          this.publish();
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        this.lastError = error instanceof TelegramError ? error.message : 'errors.operationFailed';
        if (error instanceof TelegramError && [401, 404, 409].includes(error.code ?? 0))
          controller.abort();
        this.publish();
        if (!controller.signal.aborted)
          await delay(Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6)), undefined, {
            signal: controller.signal,
          }).catch(() => undefined);
      }
    }
  }
  private usable(controller: AbortController, chatId: number): boolean {
    const options = this.settings.get().telegram;
    return (
      !this.closing &&
      !controller.signal.aborted &&
      options.enabled &&
      options.pairedChatId === chatId
    );
  }
  private call(
    method: string,
    body: { chat_id?: number; [key: string]: unknown },
    controller: AbortController,
  ): Promise<unknown> {
    const task = this.outgoing.then(async () => {
      for (let attempt = 0; ; attempt++) {
        if (!this.token || controller.signal.aborted) return undefined;
        for (;;) {
          this.sentAt = this.sentAt.filter((at) => at > Date.now() - 1000);
          const wait = Math.max(
            0,
            body.chat_id === undefined
              ? 0
              : (this.chatSentAt.get(body.chat_id) ?? -Infinity) + 1000 - Date.now(),
            this.sentAt.length < 25 ? 0 : this.sentAt[this.sentAt.length - 25] + 1000 - Date.now(),
          );
          if (!wait) break;
          await delay(wait, undefined, { signal: controller.signal });
          if (controller.signal.aborted) return undefined;
        }
        if (controller.signal.aborted) return undefined;
        try {
          return await this.request(this.token, method, body, controller.signal).finally(() => {
            const now = Date.now();
            this.sentAt.push(now);
            if (body.chat_id !== undefined) this.chatSentAt.set(body.chat_id, now);
          });
        } catch (error) {
          if (!(error instanceof TelegramError) || error.code !== 429 || attempt >= 3) throw error;
          await delay(error.retryAfter * 1000, undefined, { signal: controller.signal });
        }
      }
    });
    this.outgoing = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  private async send(
    text: string,
    controller: AbortController,
    chatId = this.settings.get().telegram.pairedChatId,
  ): Promise<void> {
    if (!chatId) return;
    for (const chunk of splitTelegramText(redact(text, this.token ? [this.token] : []))) {
      if (!this.usable(controller, chatId)) return;
      await this.call('sendMessage', { chat_id: chatId, text: chunk }, controller);
    }
  }
  private background(task: Promise<unknown>): void {
    const effect = task.catch(() => {
      if (!this.closing && !this.controller?.signal.aborted) {
        this.lastError = 'errors.operationFailed';
        this.publish();
      }
    });
    this.effects.add(effect);
    void effect.finally(() => this.effects.delete(effect));
  }
  private async receive(update: Update, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) return;
    const options = this.settings.get().telegram;
    if (update.callback_query) {
      const query = update.callback_query;
      if (
        !options.pairedChatId ||
        query.message?.chat.type !== 'private' ||
        query.message.chat.id !== options.pairedChatId ||
        query.from.id !== options.pairedChatId
      )
        return;
      this.background(this.callback(query, controller));
      return;
    }
    const message = update.message;
    if (!message || message.chat.type !== 'private' || message.chat.id <= 0) return;
    if (!options.pairedChatId) {
      const code = message.text?.trim().replace(/^\/start\s+/, '');
      if (!this.pairing || this.pairing.expires <= Date.now() || !code) return;
      if (code !== this.pairing.code) {
        if (++this.pairing.attempts >= 5) {
          this.clearPairing();
          this.lastError = 'telegram.pairingLocked';
          this.publish();
        }
        return;
      }
      const name =
        [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') ||
        message.chat.username ||
        String(message.chat.id);
      await this.settings.setTelegram({
        pairedChatId: message.chat.id,
        pairedName: redact(name.slice(0, 200), this.token ? [this.token] : []),
      });
      this.clearPairing();
      this.publish();
      this.background(this.send('Eşleşme tamamlandı.', controller, message.chat.id));
      return;
    }
    if (message.chat.id !== options.pairedChatId) return;
    this.accepted = this.accepted.filter((at) => at > Date.now() - 60_000);
    if (this.accepted.length >= 20) {
      this.background(this.send('Yavaşla; dakikada en fazla 20 mesaj.', controller));
      return;
    }
    this.accepted.push(Date.now());
    if (!message.text?.trim()) {
      this.background(this.send('Dosya ve fotoğraflar henüz desteklenmiyor.', controller));
      return;
    }
    const text = message.text.trim();
    let botId: string;
    try {
      botId = this.route(text).botId;
    } catch {
      this.background(this.send('Bot bulunamadı. /bot Ad mesaj biçimini kullan.', controller));
      return;
    }
    if (this.queued || this.chat.isBotActive(botId))
      this.background(this.send('Bot meşgul, sıraya aldım.', controller));
    this.queued++;
    this.queue = this.queue
      .then(async () => {
        if (!this.usable(controller, message.chat.id)) return;
        try {
          await this.routeMessage(text, controller, message.chat.id);
        } catch {
          await this.send(
            'İşlem tamamlanamadı. Uygulamayı kontrol et.',
            controller,
            message.chat.id,
          ).catch(() => undefined);
        }
      })
      .finally(() => {
        this.queued--;
      });
  }
  private route(text: string): { botId: string; prompt: string } {
    const routeTo = this.settings.get().telegram.routeTo;
    const fallback = {
      botId: this.bots()
        .list()
        .some((bot) => bot.id === routeTo)
        ? routeTo
        : 'chief',
      prompt: text,
    };
    if (!/^\/bot\s/.test(text)) return fallback;
    const words =
      text
        .slice(5)
        .trim()
        .match(/"[^"]+"|\S+/g) ?? [];
    const bots = this.bots().list();
    for (let count = words.length - 1; count >= 1; count--) {
      const key = nameKey(words.slice(0, count).join(' ').replace(/^"|"$/g, ''));
      const bot = bots.find((bot) => nameKey(bot.name) === key || nameKey(bot.id) === key);
      if (bot) return { botId: bot.id, prompt: words.slice(count).join(' ') };
    }
    const key = nameKey(words[0]?.replace(/^"|"$/g, '') ?? '');
    const matches = bots.filter(
      (bot) => key && (nameKey(bot.name).includes(key) || nameKey(bot.id).includes(key)),
    );
    if (matches.length !== 1 || words.length < 2) throw new Error('Bot missing or ambiguous');
    return { botId: matches[0].id, prompt: words.slice(1).join(' ') };
  }
  private async routeMessage(
    text: string,
    controller: AbortController,
    chatId: number,
  ): Promise<void> {
    if (/^\/(?:yeni|new)$/.test(text)) {
      await this.settings.setTelegram({ conversationId: undefined });
      await this.send('Yeni sohbet hazır.', controller, chatId);
      return;
    }
    const { botId, prompt } = this.route(text);
    await this.chat.waitForBot(botId, controller.signal);
    let conversationId = this.settings.get().telegram.conversationId;
    if (conversationId) {
      try {
        if (this.db.get(conversationId).conversation.botId !== botId) conversationId = undefined;
      } catch {
        conversationId = undefined;
      }
    }
    let run: Awaited<ReturnType<ChatService['send']>>;
    for (;;) {
      if (!this.usable(controller, chatId)) return;
      try {
        run = await this.chat.send(botId, prompt, conversationId, undefined, {
          title: 'Telegram',
          signal: controller.signal,
        });
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'errors.botBusy') throw error;
        await this.chat.waitForBot(botId, controller.signal);
      }
    }
    this.runs.add(run.runId);
    const typing = () =>
      this.background(
        this.call('sendChatAction', { chat_id: chatId, action: 'typing' }, controller),
      );
    typing();
    const timer = setInterval(typing, 5000);
    try {
      await this.settings.setTelegram({ conversationId: run.conversationId });
      await this.chat.waitForRun(run.conversationId, { signal: controller.signal });
      const events = this.db
        .get(run.conversationId)
        .events.filter((event) => event.runId === run.runId)
        .map((event) => event.event);
      const failed = events.some(
        (event) => event.type === 'run.error' || (event.type === 'run.done' && event.cancelled),
      );
      const answer =
        events.filter((event) => event.type === 'message.done').at(-1)?.text ??
        events
          .filter((event) => event.type === 'message.delta')
          .map((event) => event.text)
          .join('');
      await this.send(
        failed ? 'Koşu tamamlanamadı. Uygulamayı kontrol et.' : answer || 'Tamamlandı.',
        controller,
        chatId,
      );
    } finally {
      clearInterval(timer);
    }
  }
  onEvent(envelope: EventEnvelope): void {
    const controller = this.controller;
    const chatId = this.settings.get().telegram.pairedChatId;
    if (!controller || !chatId || !this.usable(controller, chatId)) return;
    const event = envelope.event;
    if (event.type === 'approval.request' && this.runs.has(envelope.rootRunId ?? envelope.runId)) {
      const key = randomBytes(8).toString('hex');
      const bot =
        event.kind === 'bot.create'
          ? event.data?.bot
          : event.kind === 'bot.update'
            ? {
                ...this.bots()
                  .list()
                  .find((bot) => bot.id === event.data?.botId),
                ...(event.data?.after as object),
              }
            : undefined;
      const fields = bot && typeof bot === 'object' ? (bot as Record<string, unknown>) : undefined;
      const details = fields
        ? ['name', 'role', 'engine']
            .map((key) => fields[key])
            .filter((value) => typeof value === 'string')
            .join(' · ')
        : '';
      const text = redact(
        `${event.title}\n${details}\n${event.details.slice(0, 600)}`.slice(0, 3500),
        this.token ? [this.token] : [],
      );
      const approval: Approval = {
        approvalId: event.approvalId,
        chatId,
        text,
        controller,
        message: this.call(
          'sendMessage',
          {
            chat_id: chatId,
            text,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Onayla', callback_data: `a:${key}` },
                  { text: 'Vazgeç', callback_data: `r:${key}` },
                ],
              ],
            },
          },
          controller,
        ).then((result) => z.object({ message_id: z.number().int() }).parse(result).message_id),
      };
      this.approvals.set(key, approval);
      this.background(approval.message);
    }
    if (event.type === 'approval.resolved') {
      for (const [key, approval] of this.approvals) {
        if (approval.approvalId !== event.approvalId) continue;
        this.approvals.delete(key);
        this.background(
          approval.message.then(async (messageId) => {
            if (messageId === undefined || !this.usable(approval.controller, approval.chatId))
              return;
            const result =
              event.decision === 'approved' || event.decision === 'edited'
                ? 'Onaylandı'
                : 'Vazgeçildi';
            await this.call(
              'editMessageText',
              {
                chat_id: approval.chatId,
                message_id: messageId,
                text: `${approval.text}\n\n${result}`,
                reply_markup: { inline_keyboard: [] },
              },
              approval.controller,
            );
          }),
        );
      }
    }
  }
  private async callback(
    query: NonNullable<Update['callback_query']>,
    controller: AbortController,
  ): Promise<void> {
    const match = /^([ar]):([a-f0-9]{16})$/.exec(query.data ?? '');
    const approval = match ? this.approvals.get(match[2]) : undefined;
    let text = 'Bu onay artık geçerli değil.';
    if (
      approval &&
      approval.chatId === query.message?.chat.id &&
      (await approval.message) === query.message.message_id
    ) {
      try {
        await this.chat.approvals.respond(
          approval.approvalId,
          match![1] === 'a' ? 'approved' : 'rejected',
        );
        text = 'Yanıt kaydedildi.';
      } catch {
        text = 'Onay işlenemedi; uygulamayı kontrol et.';
      }
    }
    await this.call('answerCallbackQuery', { callback_query_id: query.id, text }, controller);
  }
  private async notifyRoutine(run: RoutineRun): Promise<void> {
    const options = this.settings.get().telegram;
    const controller = this.controller;
    if (!options.notifyRoutines || !controller || !['done', 'error'].includes(run.status)) return;
    const bot = this.bots()
      .list()
      .find((bot) => bot.id === run.botId);
    const name =
      bot?.routines.find((routine) => routine.id === run.routineId)?.name ?? run.routineId;
    let summary = run.summary ?? '';
    if (run.conversationId) {
      const events = this.db
        .get(run.conversationId)
        .events.filter((event) => event.runId === run.id)
        .map((event) => event.event);
      summary =
        run.status === 'error'
          ? (events.find((event) => event.type === 'run.error')?.message ?? summary)
          : (events.filter((event) => event.type === 'message.done').at(-1)?.text ??
            (events
              .filter((event) => event.type === 'message.delta')
              .map((event) => event.text)
              .join('') ||
              summary));
    }

    await this.send(`⏰ ${name}: ${summary.slice(0, 600)}`, controller);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.controller?.abort();
    this.clearPairing();
    this.db.removeListener('routineFinished', this.routineFinished);
    await this.changes;
    await this.stop();
    await Promise.allSettled(this.effects);
    this.approvals.clear();
  }
}
