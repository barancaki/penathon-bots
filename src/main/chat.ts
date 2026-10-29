import { stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { AppActivity } from '../shared/api';
import type { BotStore } from './bots/store';
import type { Repository } from './db';
import type { EngineAdapter } from './engines/types';
import type { EngineId } from '../shared/bots';
import type { BotEvent, EventEnvelope } from '../shared/events';
import { redact } from './engines/common';
import { Approvals } from './bots/approvals';
import { BotTools, type Execution } from './bots/tools';
import type { ProjectStore } from './projects';
import { Routines, vaultRoutine } from './routines';
import type { WorkReport } from '../shared/routines';
import { Rooms } from './rooms';

export class ChatService extends EventEmitter {
  private closing = false;
  readonly approvals = new Approvals();
  readonly routines: Routines;
  readonly rooms: Rooms;
  private active = new Map<
    string,
    {
      botId: string;
      engine: EngineAdapter;
      controller: AbortController;
      task: Promise<void>;
      deleted: boolean;
    }
  >();
  constructor(
    private bots: () => BotStore,
    private db: Repository,
    private engines: Record<EngineId, EngineAdapter>,
    private secrets: () => string[],
    private publishEvent: (event: EventEnvelope) => void,
    private projects?: ProjectStore,
  ) {
    super();
    this.routines = new Routines(bots, db, this);
    this.rooms = new Rooms(bots, db, this, secrets);
  }
  async send(
    botId: string,
    prompt: string,
    conversationId?: string,
    parent?: Execution,
    options?: {
      title?: string;
      model?: string;
      routineId?: string;
      reportId?: string;
      signal?: AbortSignal;
      room?: NonNullable<Execution['room']>;
      rootRunId?: string;
    },
  ) {
    if (this.closing) throw new Error('App closing');
    if (parent?.signal.aborted || options?.signal?.aborted) throw new Error('Koşu iptal edildi.');
    if (parent && parent.depth >= 3)
      throw new Error('Delegasyon/alt bot derinliği en fazla 3 olabilir.');
    const bot = this.bots().forRun(botId);
    const engine = this.engines[bot.engine];
    let incompatibleModel = false;
    if (options?.model) {
      const claudeModel = /^(?:haiku|sonnet|opus|claude-.+)$/.test(options.model);
      const compatible =
        options.model === 'default' ||
        (bot.engine === 'claude'
          ? claudeModel
          : !claudeModel &&
            (await engine.models().catch(() => [])).some((model) => model.id === options.model));
      bot.model = compatible ? options.model : 'default';
      incompatibleModel = !compatible;
    }
    if (!(await stat(bot.workdir)).isDirectory()) throw new Error('errors.workdir');
    const memory = (await this.bots().getMemory(botId)).slice(0, 8000);
    const runSecrets = new Set<string>();
    const secrets = () =>
      [...new Set([...this.secrets(), ...runSecrets])]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    if (this.closing || parent?.signal.aborted || options?.signal?.aborted)
      throw new Error('Run cancelled');
    if (options?.reportId && this.db.report(options.reportId).processedAt)
      throw new Error('Report already processed');
    if (this.isBotActive(botId)) throw new Error('errors.botBusy');
    const run = this.db.start(
      bot,
      redact(prompt, secrets()),
      conversationId,
      options
        ? redact(
            { title: options.title, routineId: options.routineId, roomId: options.room?.roomId },
            secrets(),
          )
        : undefined,
    );
    const controller = new AbortController();
    const abort = () => this.cancel(run.conversationId);
    parent?.signal.addEventListener('abort', abort, { once: true });
    options?.signal?.addEventListener('abort', abort, { once: true });
    const rootRunId = parent?.rootRunId ?? options?.rootRunId ?? run.runId;
    const execution: Execution = {
      rootRunId,
      depth: parent ? parent.depth + 1 : 0,
      budget: parent?.budget ?? { spawned: 0 },
      signal: controller.signal,
      reportId: options?.reportId,
      room: options?.room ?? parent?.room,
    };
    const state = { deleted: false };
    const task = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
      let terminal = false;
      const publish = (event: BotEvent) => {
        if (terminal || state.deleted) return;
        const envelope = this.db.append(run.runId, redact(event, secrets()));
        terminal ||= event.type === 'run.done' || event.type === 'run.error';
        if (envelope) this.publishEvent({ ...envelope, rootRunId });
        if (event.type === 'approval.request' || event.type === 'approval.resolved')
          this.emit('activity', this.activity());
      };
      const pending = new Map<string, string>();
      const flush = (messageId: string, final = false) => {
        const text = pending.get(messageId) ?? '';
        const currentSecrets = secrets();
        const tailLength = Math.max(0, (currentSecrets[0]?.length ?? 0) - 1);
        const limit = final ? text.length : text.length - tailLength;
        let offset = 0;
        let output = '';
        // Keep enough lookahead to consume a secret in full, including one spanning the cutoff.
        while (offset < limit) {
          const secret = currentSecrets.find(
            (secret) =>
              text.startsWith(secret, offset) ||
              // Only cancellation may hide an incomplete key prefix, with at least eight characters.
              (final &&
                controller.signal.aborted &&
                text.length - offset >= 8 &&
                secret.startsWith(text.slice(offset))),
          );
          if (secret) {
            output += '[REDACTED]';
            offset += secret.length;
          } else output += text[offset++];
        }
        if (final) pending.delete(messageId);
        else pending.set(messageId, text.slice(offset));
        if (output) publish({ type: 'message.delta', messageId, text: output });
      };
      const flushAll = () => {
        for (const messageId of pending.keys()) flush(messageId, true);
      };
      const append = (event: BotEvent) => {
        if (terminal) return;
        // Derive the final status from the first terminal event, including fallback errors.
        if (event.type === 'status' && ['done', 'error', 'idle'].includes(event.status)) return;
        if (event.type === 'message.delta') {
          pending.set(event.messageId, (pending.get(event.messageId) ?? '') + event.text);
          flush(event.messageId);
          return;
        }
        if (event.type === 'message.done') flush(event.messageId, true);
        if (event.type === 'run.done' || event.type === 'run.error') {
          this.approvals.expireRun(run.runId);
          flushAll();
          publish({
            type: 'status',
            status: event.type === 'run.error' ? 'error' : event.cancelled ? 'idle' : 'done',
          });
        }
        publish(event);
      };
      controller.signal.addEventListener('abort', flushAll, { once: true });
      try {
        if (incompatibleModel)
          append({
            type: 'notice',
            level: 'warning',
            message: `${options!.model} modeli ${bot.engine} motoruyla uyumlu değil; varsayılan model kullanılıyor.`,
          });
        const tools = new BotTools(
          this.bots(),
          this.db,
          this,
          this.approvals,
          botId,
          run.runId,
          execution,
          append,
          this.projects,
        );
        for await (const event of engine.run({
          bot,
          prompt,
          ...run,
          memory,
          addRedactionSecret: (secret) => {
            if (secret) runSecrets.add(secret);
          },
          callTool: (name, args) => tools.call(name, redact(args, secrets())),
          requestApproval: async (request) =>
            !!(await this.approvals.request(
              run.runId,
              request,
              controller.signal,
              append,
              async (edited) => {
                if (edited !== undefined) throw new Error('Bu onay düzenlenemez.');
                return true;
              },
            )),
          signal: controller.signal,
        })) {
          if (state.deleted) break;
          if (controller.signal.aborted && event.type !== 'run.done' && event.type !== 'run.error')
            continue;
          if (event.type === 'run.done' || event.type === 'run.error')
            await this.approvals.settleRun(run.runId);
          append(event);
          if (terminal) break;
        }
        if (!terminal) {
          await this.approvals.settleRun(run.runId);
          append({ type: 'run.error', code: 'stream', message: 'errors.streamEnded' });
        }
      } catch {
        if (!terminal) {
          await this.approvals.settleRun(run.runId);
          append({ type: 'run.error', code: 'engine', message: 'errors.engine' });
        }
      } finally {
        this.approvals.expireRun(run.runId);
        controller.abort();
        parent?.signal.removeEventListener('abort', abort);
        options?.signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', flushAll);
        this.active.delete(run.conversationId);
        this.emit('activity', this.activity());
      }
    });
    this.active.set(run.conversationId, Object.assign(state, { botId, engine, controller, task }));
    this.emit('activity', this.activity());
    if (options?.routineId) this.db.emit('routinesChanged', botId);
    if (parent?.signal.aborted) this.cancel(run.conversationId);
    return { conversationId: run.conversationId, runId: run.runId };
  }
  async delegate(botId: string, task: string, parent: Execution): Promise<string> {
    const run = await this.send(botId, task, undefined, parent);
    await this.waitForRun(run.conversationId, parent);
    const detail = this.db.get(run.conversationId);
    const failure = detail.events.find(
      ({ event }) => event.type === 'run.error' || (event.type === 'run.done' && event.cancelled),
    );
    if (failure)
      throw new Error(
        failure.event.type === 'run.error' ? failure.event.message : 'Alt bot koşusu iptal edildi.',
      );
    return detail.messages.filter((message) => message.role === 'assistant').at(-1)?.text ?? '';
  }
  async waitForBot(botId: string, signal: AbortSignal): Promise<void> {
    let active: [string, unknown] | undefined;
    while ((active = [...this.active.entries()].find(([, run]) => run.botId === botId)))
      await this.waitForRun(active[0], { signal });
    if (signal.aborted) throw new Error('Run cancelled');
  }
  async waitForRun(conversationId: string, parent: Pick<Execution, 'signal'>): Promise<void> {
    const active = this.active.get(conversationId);
    if (!active) return;
    let abort!: () => void;
    try {
      await Promise.race([
        active.task,
        new Promise<never>((_, reject) => {
          abort = () => reject(new Error('Alt bot koşusu iptal edildi.'));
          parent.signal.addEventListener('abort', abort, { once: true });
          if (parent.signal.aborted) abort();
        }),
      ]);
    } finally {
      parent.signal.removeEventListener('abort', abort);
    }
  }
  async stopConversation(id: string): Promise<void> {
    this.db.get(id);
    const run = this.active.get(id);
    if (run) {
      this.cancel(id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          run.task,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (run) {
      run.deleted = true;
      this.active.delete(id);
      this.emit('activity', this.activity());
    }
  }
  async delete(id: string): Promise<void> {
    await this.stopConversation(id);
    this.db.delete(id);
  }
  cancel(id: string): void {
    const run = this.active.get(id);
    run?.controller.abort();
    run?.engine.cancel(id);
  }
  isBotActive(id: string): boolean {
    return [...this.active.values()].some((run) => run.botId === id);
  }
  activity(): AppActivity {
    return {
      running: [...this.active].map(([conversationId, run]) => ({
        botId: run.botId,
        name: this.bots().get(run.botId).name,
        conversationId,
      })),
      pendingApprovals: this.approvals.size,
    };
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.rooms.close();
    await this.routines.stop();
    const runs = [...this.active.entries()];
    for (const [id] of runs) this.cancel(id);
    await Promise.allSettled(runs.map(([, run]) => run.task));
    await Promise.allSettled(Object.values(this.engines).map((engine) => engine.close?.()));
  }
  async reportToChief(
    botId: string,
    runId: string,
    input: Pick<WorkReport, 'summary' | 'decisions' | 'files' | 'open'>,
  ): Promise<WorkReport> {
    const safe = redact(input, await this.secrets());
    const run = this.db.runInfo(runId);
    if (botId === 'chief' || run.botId !== botId || run.status !== 'running')
      throw new Error('Report permission denied');
    return this.db.addReport({
      ...safe,
      botId,
      runId,
      conversationId: run.conversationId,
      source: 'bot',
    });
  }
  async processReportNow(id: string): Promise<{ conversationId: string }> {
    const report = this.db.report(id);
    if (report.processedAt) throw new Error('Report already processed');
    if (!this.bots().hasReportDestination()) throw new Error('Knowledge folder missing');
    const run = await this.send(
      'chief',
      vaultRoutine.prompt +
        '\n\nYalnız şu raporu işle; diğer raporlara dokunma: ' +
        JSON.stringify(report),
      undefined,
      undefined,
      {
        title: 'Vault güncelleme',
        model: this.bots().get('chief').engine === 'claude' ? 'haiku' : undefined,
        reportId: id,
      },
    );
    return { conversationId: run.conversationId };
  }
  async markReportsProcessed(ids: string[], into: string): Promise<void> {
    this.db.markReportsProcessed(ids, redact(into, await this.secrets()));
  }
}
