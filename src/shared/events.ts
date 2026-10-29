export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
};
export type BotEvent =
  | { type: 'message.delta'; messageId: string; text: string }
  | { type: 'message.done'; messageId: string; text: string }
  | {
      type: 'tool.start';
      toolId: string;
      kind: 'file_read' | 'file_write' | 'command' | 'search' | 'mcp' | 'other';
      title: string;
      argsSummary: string;
      /** Full file paths, kept separately from truncated tool arguments. */
      files?: string[];
    }
  | { type: 'tool.end'; toolId: string; resultSummary: string; error: boolean }
  | { type: 'notice'; level: 'info' | 'warning'; message: string }
  | { type: 'diff'; file: string; unifiedDiff: string }
  /**
   * Informational cards:
   * - `bot.spawned`: data = { botId: string; name: string; task: string; temporary: boolean }
   * - `bot.delegated`: data = { botId: string; name: string; task: string; result?: string; error?: string }
   * - `memory`: data = { action: 'remember' | 'forget'; text: string }
   */
  | { type: 'card'; cardId: string; kind: string; data: Record<string, unknown> }
  | {
      type: 'approval.request';
      approvalId: string;
      title: string;
      details: string;
      /**
       * Structured approvals render as rich cards:
       * - `bot.create`: data = { bot: Bot } (full preview, id/avatar already assigned)
       * - `bot.update`: data = { botId: string; before: BotPatch; after: BotPatch } (changed fields only)
       * - `file.delete`: data = { command: string; paths: string[] } (a Writer-level bot wants to delete)
       * - `project.grant`: data = { botId: string; project: Project; level: AccessLevel | null; before?: AccessLevel | null }
       */
      // Routine approvals: data = { botId, routine, before? }.
      kind?:
        | 'bot.create'
        | 'bot.update'
        | 'file.delete'
        | 'project.grant'
        | 'routine.create'
        | 'routine.update';
      data?: Record<string, unknown>;
    }
  | {
      type: 'approval.resolved';
      approvalId: string;
      /** `edited` = approved with the user's changes; `expired` = run ended before an answer. */
      decision: 'approved' | 'edited' | 'rejected' | 'expired';
      botId?: string;
    }
  | {
      type: 'status';
      status: 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done' | 'error';
    }
  | {
      type: 'run.done';
      resumeToken?: string;
      usage?: Usage;
      durationMs: number;
      cancelled?: boolean;
    }
  | { type: 'run.error'; code: string; message: string };

export type EventEnvelope = {
  rootRunId?: string;
  conversationId: string;
  runId: string;
  sequence: number;
  createdAt: string;
  event: BotEvent;
};
