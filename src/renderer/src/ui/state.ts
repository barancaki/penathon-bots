import type { BotEvent, EventEnvelope } from '../../../shared/events';
import type { ConversationDetail, Message } from '../../../shared/api';
import type { T } from './strings';

export type BotStatus = Extract<BotEvent, { type: 'status' }>['status'];
type ToolKind = Extract<BotEvent, { type: 'tool.start' }>['kind'];

export type ToolStep = {
  id: string;
  kind: ToolKind;
  title: string;
  args: string;
  result?: string;
  files?: string[];
  completed: boolean;
  failed: boolean;
  running: boolean;
};

export type TurnBlock =
  | { type: 'text'; key: string; text: string }
  | { type: 'steps'; key: string; steps: ToolStep[] }
  | { type: 'error'; key: string; code: string; message: string }
  | { type: 'notice'; key: string; text: string }
  | { type: 'card'; key: string; event: Extract<BotEvent, { type: 'card' }> }
  | {
      type: 'approval';
      key: string;
      event: Extract<BotEvent, { type: 'approval.request' }>;
      resolution?: ApprovalResolution;
    }
  | { type: 'meta'; key: string; event: Extract<BotEvent, { type: 'run.done' }> };

export type ApprovalResolution = Extract<BotEvent, { type: 'approval.resolved' }>['decision'];

export function approvalResolutions(events: EventEnvelope[]): Map<string, ApprovalResolution> {
  const map = new Map<string, ApprovalResolution>();
  for (const { event } of events)
    if (event.type === 'approval.resolved') map.set(event.approvalId, event.decision);
  return map;
}

export type Turn = { user?: Message; blocks: TurnBlock[]; running: boolean };

export function mergeEvents(...lists: EventEnvelope[][]): EventEnvelope[] {
  const map = new Map<string, EventEnvelope>();
  for (const list of lists) for (const e of list) map.set(`${e.runId}:${e.sequence}`, e);
  const runStarts = new Map<string, string>();
  const runOrder = new Map<string, number>();
  for (const e of map.values()) {
    if (!runOrder.has(e.runId)) runOrder.set(e.runId, runOrder.size);
    const first = runStarts.get(e.runId);
    if (!first || e.createdAt < first) runStarts.set(e.runId, e.createdAt);
  }
  return [...map.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      runStarts.get(a.runId)!.localeCompare(runStarts.get(b.runId)!) ||
      runOrder.get(a.runId)! - runOrder.get(b.runId)! ||
      a.sequence - b.sequence,
  );
}

/** Folds the raw event stream into readable blocks: text, grouped tool steps, errors. */
export function buildBlocks(
  events: EventEnvelope[],
  resolutions = approvalResolutions(events),
): { blocks: TurnBlock[]; running: boolean } {
  const blocks: TurnBlock[] = [];
  const texts = new Map<string, Extract<TurnBlock, { type: 'text' }>>();
  const steps = new Map<string, ToolStep>();
  let group: Extract<TurnBlock, { type: 'steps' }> | undefined;
  const finishedRuns = new Set(
    events
      .filter(({ event }) => event.type === 'run.done' || event.type === 'run.error')
      .map(({ runId }) => runId),
  );
  const runningRuns = new Set<string>();
  let errored = false;
  for (const { event, sequence, runId } of events) {
    const key = `${runId}:${sequence}`;
    switch (event.type) {
      case 'message.delta':
      case 'message.done': {
        let block = texts.get(event.messageId);
        if (!block) {
          block = { type: 'text', key, text: '' };
          texts.set(event.messageId, block);
          blocks.push(block);
          group = undefined;
        }
        block.text = event.type === 'message.done' ? event.text : block.text + event.text;
        break;
      }
      case 'tool.start': {
        const step: ToolStep = {
          id: event.toolId,
          kind: event.kind,
          title: event.title,
          args: event.argsSummary,
          files: event.files,
          completed: false,
          failed: false,
          running: !finishedRuns.has(runId),
        };
        steps.set(`${runId}:${event.toolId}`, step);
        if (step.running) runningRuns.add(runId);
        if (!group) {
          group = { type: 'steps', key, steps: [] };
          blocks.push(group);
        }
        group.steps.push(step);
        break;
      }
      case 'tool.end': {
        const step = steps.get(`${runId}:${event.toolId}`);
        if (step) {
          step.running = false;
          step.completed = true;
          step.failed = event.error;
          step.result = event.resultSummary;
        }
        break;
      }
      case 'status':
        if (!finishedRuns.has(runId) && !['done', 'error', 'idle'].includes(event.status))
          runningRuns.add(runId);
        else runningRuns.delete(runId);
        break;
      case 'run.error':
        runningRuns.delete(runId);
        // One terminal error per run is enough to explain what happened.
        if (!errored) blocks.push({ type: 'error', key, code: event.code, message: event.message });
        errored = true;
        break;
      case 'run.done':
        runningRuns.delete(runId);
        if (!event.cancelled) blocks.push({ type: 'meta', key, event });
        break;
      case 'card':
        blocks.push({ type: 'card', key, event });
        group = undefined;
        break;
      case 'approval.request': {
        // A request whose run already ended without an answer can no longer be approved.
        const resolution =
          resolutions.get(event.approvalId) ?? (finishedRuns.has(runId) ? 'expired' : undefined);
        blocks.push({ type: 'approval', key, event, resolution });
        group = undefined;
        break;
      }
      case 'approval.resolved':
        break;
      default: {
        const other = event as { type: string; message?: string };
        if (other.type === 'notice' && other.message)
          blocks.push({ type: 'notice', key, text: other.message });
      }
    }
  }
  return { blocks, running: runningRuns.size > 0 };
}

/** Splits a conversation into turns, one per user message. */
export function buildTurns(messages: Message[], events: EventEnvelope[]): Turn[] {
  const users = messages.filter((m) => m.role === 'user');
  const resolutions = approvalResolutions(events);
  if (!users.length) {
    const { blocks, running } = buildBlocks(events, resolutions);
    return blocks.length ? [{ blocks, running }] : [];
  }
  return users.map((user, i) => {
    const next = users[i + 1];
    const slice = events.filter(
      (e) => e.createdAt >= user.createdAt && (!next || e.createdAt < next.createdAt),
    );
    return { user, ...buildBlocks(slice, resolutions) };
  });
}

export function lastStatus(events: EventEnvelope[]): BotStatus | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event;
    if (e.type === 'status') return e.status;
    if (e.type === 'run.error') return 'error';
    if (e.type === 'run.done') return e.cancelled ? 'idle' : 'done';
  }
  return undefined;
}

export function allSteps(events: EventEnvelope[]): ToolStep[] {
  return buildBlocks(events).blocks.flatMap((b) => (b.type === 'steps' ? b.steps : []));
}

export function nowDoing(events: EventEnvelope[], t: T): string | undefined {
  const status = lastStatus(events);
  if (!status || ['done', 'error', 'idle'].includes(status)) return undefined;
  const running = allSteps(events)
    .filter((s) => s.running)
    .pop();
  if (!running) return t(`status.${status}`);
  const what = running.args || running.title;
  const key = {
    file_read: 'now.reading',
    file_write: 'now.writing',
    command: 'now.command',
    search: 'now.search',
    mcp: 'now.tool',
    other: 'now.tool',
  }[running.kind];
  return t(key, { what: shorten(what, 48) });
}

export function shorten(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatDuration(ms: number, language: 'tr' | 'en') {
  const seconds = ms / 1000;
  const fmt = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  if (seconds < 60) return `${fmt.format(seconds)} ${language === 'tr' ? 'sn' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} ${language === 'tr' ? 'dk' : 'min'} ${Math.round(seconds % 60)} ${language === 'tr' ? 'sn' : 's'}`;
}

export type ChatSelection = { botId: string; conversationId: string };

export function clearSentDraft(
  drafts: Record<string, string>,
  sentBotId: string,
  sentText: string,
) {
  return drafts[sentBotId] === sentText ? { ...drafts, [sentBotId]: '' } : drafts;
}

export function sendResultUpdates(
  sentBotId: string,
  sentSelection: ChatSelection,
  currentSelection: ChatSelection,
  conversationId: string,
) {
  return {
    convoBot: { [conversationId]: sentBotId },
    selection: sentSelection === currentSelection ? { conversationId } : undefined,
  };
}

export function detailForSelection(
  detail: ConversationDetail,
  requestedSelection: ChatSelection,
  currentSelection: ChatSelection,
) {
  return requestedSelection === currentSelection &&
    detail.conversation.botId === currentSelection.botId &&
    detail.conversation.id === currentSelection.conversationId
    ? detail
    : undefined;
}

export function buildRoster(
  streams: Record<string, EventEnvelope[]>,
  convoBot: Record<string, string>,
  t: T,
): Record<string, { status?: BotStatus; live?: string }> {
  const selected = new Map<string, { events: EventEnvelope[]; running: boolean }>();
  for (const [cid, stream] of Object.entries(streams)) {
    const owner = convoBot[cid];
    if (!owner || !stream.length) continue;
    const events = mergeEvents(stream);
    const status = lastStatus(events);
    const running = !!status && !['done', 'error', 'idle'].includes(status);
    const current = selected.get(owner);
    if (
      !current ||
      (running && !current.running) ||
      (running === current.running && events.at(-1)!.createdAt > current.events.at(-1)!.createdAt)
    )
      selected.set(owner, { events, running });
  }
  return Object.fromEntries(
    [...selected].map(([owner, { events }]) => [
      owner,
      { status: lastStatus(events), live: nowDoing(events, t) },
    ]),
  );
}

export function touchedFiles(steps: ToolStep[]) {
  const map = new Map<string, { path: string; write: boolean; failed: boolean }>();
  for (const step of steps) {
    if (step.kind !== 'file_read' && step.kind !== 'file_write') continue;
    if (step.kind === 'file_write' && (!step.completed || step.failed)) continue;
    for (const path of step.files?.length ? step.files : [step.args || step.title]) {
      const prev = map.get(path);
      map.set(path, {
        path,
        write: (prev?.write ?? false) || step.kind === 'file_write',
        failed: step.failed,
      });
    }
  }
  return [...map.values()];
}
