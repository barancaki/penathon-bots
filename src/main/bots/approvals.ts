import { randomUUID } from 'node:crypto';
import type { ApprovalDecision } from '../../shared/api';
import type { BotEvent } from '../../shared/events';

type Request = Omit<Extract<BotEvent, { type: 'approval.request' }>, 'type' | 'approvalId'>;
type Pending = {
  runId: string;
  accepting: boolean;
  applying?: Promise<void>;
  expire(): void;
  respond(decision: ApprovalDecision, edited?: unknown): Promise<void>;
};
export class Approvals {
  private pending = new Map<string, Pending>();
  get size(): number {
    return this.pending.size;
  }
  request<T>(
    runId: string,
    request: Request,
    signal: AbortSignal,
    emit: (event: BotEvent) => void,
    apply: (edited?: unknown) => Promise<T>,
  ): Promise<T | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    const approvalId = randomUUID();
    return new Promise((resolve) => {
      const finish = (decision: 'approved' | 'edited' | 'rejected' | 'expired', result?: T) => {
        this.pending.delete(approvalId);
        signal.removeEventListener('abort', expire);
        emit({
          type: 'approval.resolved',
          approvalId,
          decision,
          ...(result &&
          typeof result === 'object' &&
          'id' in result &&
          typeof result.id === 'string' &&
          'engine' in result
            ? { botId: result.id }
            : {}),
        });
        resolve(result);
      };
      const expire = () => {
        if (!entry.accepting) finish('expired');
      };
      const entry: Pending = {
        runId,
        accepting: false,
        expire,
        respond: async (decision, edited) => {
          if (entry.accepting) throw new Error('Onay zaten işleniyor.');
          if (decision === 'rejected') {
            finish('rejected');
            return;
          }
          entry.accepting = true;
          try {
            const bot = await apply(edited);
            finish(edited === undefined ? 'approved' : 'edited', bot);
          } catch (error) {
            entry.accepting = false;
            if (signal.aborted) expire();
            throw error;
          }
        },
      };
      this.pending.set(approvalId, entry);
      signal.addEventListener('abort', expire, { once: true });
      emit({ type: 'approval.request', approvalId, ...request });
    });
  }
  async respond(id: string, decision: ApprovalDecision, edited?: unknown): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) throw new Error('Onay bulunamadı veya süresi dolmuş.');
    if (entry.accepting) throw new Error('Onay zaten işleniyor.');
    const applying = entry.respond(decision, edited);
    entry.applying = applying;
    try {
      await applying;
    } finally {
      entry.applying = undefined;
    }
  }
  async settleRun(runId: string): Promise<void> {
    await Promise.allSettled(
      [...this.pending.values()]
        .filter((entry) => entry.runId === runId && entry.applying)
        .map((entry) => entry.applying),
    );
    this.expireRun(runId);
  }
  expireRun(runId: string): void {
    for (const pending of this.pending.values()) if (pending.runId === runId) pending.expire();
  }
}
