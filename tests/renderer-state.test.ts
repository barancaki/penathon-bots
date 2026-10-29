import { describe, expect, it } from 'vitest';
import type { BotEvent, EventEnvelope } from '../src/shared/events';
import type { ConversationDetail } from '../src/shared/api';
import {
  allSteps,
  buildBlocks,
  buildRoster,
  clearSentDraft,
  detailForSelection,
  lastStatus,
  mergeEvents,
  sendResultUpdates,
} from '../src/renderer/src/ui/state';
import { makeT } from '../src/renderer/src/ui/strings';

function envelope(
  runId: string,
  sequence: number,
  event: BotEvent,
  second = sequence,
): EventEnvelope {
  return {
    conversationId: 'conversation',
    runId,
    sequence,
    createdAt: new Date(Date.UTC(2026, 9, 28, 0, 0, second)).toISOString(),
    event,
  };
}

const toolStart: BotEvent = {
  type: 'tool.start',
  toolId: 'shared-tool-id',
  kind: 'command',
  title: 'Command',
  argsSummary: 'npm test',
};
const t = makeT('en');

// 1. Cancellation must leave the bot idle.
describe('lastStatus', () => {
  it.each([
    [{ type: 'run.done', durationMs: 1, cancelled: true }, 'idle'],
    [{ type: 'run.done', durationMs: 1, cancelled: false }, 'done'],
    [{ type: 'run.done', durationMs: 1 }, 'done'],
    [{ type: 'run.error', code: 'failed', message: 'Failed' }, 'error'],
  ] satisfies [BotEvent, string][])('uses terminal status for %j', (event, expected) => {
    expect(
      lastStatus([
        envelope('a', 1, { type: 'status', status: 'working' }),
        envelope('a', 2, event),
      ]),
    ).toBe(expected);
  });

  it('uses the next run status after cancellation', () => {
    expect(
      lastStatus([
        envelope('a', 1, { type: 'run.done', durationMs: 1, cancelled: true }),
        envelope('b', 1, { type: 'status', status: 'thinking' }),
      ]),
    ).toBe('thinking');
    expect(lastStatus([])).toBeUndefined();
  });
});

// 2. Tool lifetime belongs to a run, including reused tool IDs.
describe('buildBlocks', () => {
  it.each([
    { type: 'run.done', durationMs: 1, cancelled: true },
    { type: 'run.done', durationMs: 1 },
    { type: 'run.error', code: 'failed', message: 'Failed' },
  ] satisfies BotEvent[])('closes unfinished tools on %j before the next run', (terminal) => {
    const finished = [
      envelope('a', 1, { type: 'status', status: 'working' }),
      envelope('a', 2, toolStart),
      envelope('a', 3, terminal),
    ];
    expect(buildBlocks(finished).running).toBe(false);
    expect(allSteps(finished).map((step) => step.running)).toEqual([false]);

    const restarted = [
      ...finished,
      envelope('b', 1, { type: 'status', status: 'working' }, 4),
      envelope('b', 2, toolStart, 5),
    ];
    expect(buildBlocks(restarted).running).toBe(true);
    expect(allSteps(restarted).map((step) => step.running)).toEqual([false, true]);
  });

  it('keeps a different run active when a run terminates', () => {
    const events = [
      envelope('a', 1, { type: 'status', status: 'working' }),
      envelope('a', 2, toolStart),
      envelope('b', 1, toolStart, 3),
      envelope('b', 2, { type: 'run.done', durationMs: 1 }, 4),
    ];
    expect(buildBlocks(events).running).toBe(true);
    expect(allSteps(events).map((step) => step.running)).toEqual([true, false]);
  });

  it('matches tool.end within its run when tool IDs are reused', () => {
    const steps = allSteps([
      envelope('a', 1, toolStart),
      envelope('b', 1, toolStart, 2),
      envelope(
        'a',
        2,
        {
          type: 'tool.end',
          toolId: toolStart.toolId,
          resultSummary: 'Complete',
          error: true,
        },
        3,
      ),
    ]);
    expect(steps.map(({ running, failed, result }) => ({ running, failed, result }))).toEqual([
      { running: false, failed: true, result: 'Complete' },
      { running: true, failed: false, result: undefined },
    ]);
  });
});

// 3. Draft cleanup is independent of selection; late replies belong to one selection.
describe('successful send updates', () => {
  const sentSelection = { botId: 'chief', conversationId: 'original-conversation' };

  it('opens the sent conversation while the original selection is still active', () => {
    const updates = sendResultUpdates('chief', sentSelection, sentSelection, 'sent-conversation');
    expect(updates.convoBot).toEqual({ 'sent-conversation': 'chief' });
    expect(updates.selection).toEqual({ conversationId: 'sent-conversation' });
  });

  it.each([
    ['another bot', { botId: 'helper', conversationId: '' }],
    ['history on the same bot', { botId: 'chief', conversationId: 'history-conversation' }],
    ['a new chat on the same bot', { botId: 'chief', conversationId: '' }],
    ['the original chat after leaving and returning', { ...sentSelection }],
  ])(
    'preserves selection after choosing %s, but records ownership and clears sent text',
    (_, current) => {
      const updates = sendResultUpdates('chief', sentSelection, current, 'sent-conversation');
      const drafts = { chief: 'Sent text', helper: 'Keep this draft' };
      expect({ existing: 'helper', ...updates.convoBot }).toEqual({
        existing: 'helper',
        'sent-conversation': 'chief',
      });
      expect(updates.selection).toBeUndefined();
      expect(clearSentDraft(drafts, 'chief', 'Sent text')).toEqual({
        chief: '',
        helper: 'Keep this draft',
      });
      expect(drafts.chief).toBe('Sent text');
    },
  );

  it('clears an unchanged draft while the bot remains selected', () => {
    expect(
      clearSentDraft({ chief: 'Sent text', helper: 'Keep this draft' }, 'chief', 'Sent text'),
    ).toEqual({ chief: '', helper: 'Keep this draft' });
  });

  it.each(['Edited while sending', 'Sent text ', '', undefined])(
    'preserves a draft changed while sending: %s',
    (text) => {
      const drafts: Record<string, string> = { helper: 'Keep this draft' };
      if (text !== undefined) drafts.chief = text;
      expect(clearSentDraft(drafts, 'chief', 'Sent text')).toBe(drafts);
    },
  );
});

describe('detailForSelection', () => {
  const requested = { botId: 'chief', conversationId: 'original-conversation' };
  const detail: ConversationDetail = {
    conversation: {
      id: requested.conversationId,
      botId: requested.botId,
      title: 'Original',
      createdAt: '',
    },
    messages: [],
    events: [],
  };

  it('accepts detail only for the requested conversation while still selected', () => {
    expect(detailForSelection(detail, requested, requested)).toBe(detail);
  });

  it.each([
    ['history on the same bot', { botId: 'chief', conversationId: 'history-conversation' }],
    ['a new chat on the same bot', { botId: 'chief', conversationId: '' }],
    ['another bot', { botId: 'helper', conversationId: requested.conversationId }],
    ['the same conversation after leaving and returning', { ...requested }],
  ])('rejects a pending detail reply after choosing %s', (_, current) => {
    expect(detailForSelection(detail, requested, current)).toBeUndefined();
  });

  it.each([
    { ...detail.conversation, id: 'different-conversation' },
    { ...detail.conversation, botId: 'helper' },
  ])('rejects a response for a different conversation or owner: %j', (conversation) => {
    expect(detailForSelection({ ...detail, conversation }, requested, requested)).toBeUndefined();
  });
});

// 4. Latest event time wins unless another conversation is still active.
describe('buildRoster', () => {
  const owners = { first: 'chief', second: 'chief', other: 'helper', empty: 'chief' };

  it.each([false, true])(
    'uses latest activity regardless of insertion order (reverse=%s)',
    (reverse) => {
      const first = [
        envelope('a', 1, { type: 'status', status: 'working' }, 1),
        envelope('a', 2, { type: 'run.done', durationMs: 1 }, 2),
        envelope('a', 3, { type: 'notice', level: 'info', message: 'Latest activity' }, 9),
      ];
      const second = [
        envelope('b', 1, { type: 'run.error', code: 'failed', message: 'Failed' }, 5),
      ];
      const streams = reverse ? { second, first } : { first, second };
      expect(buildRoster(streams, owners, t).chief).toEqual({ status: 'done', live: undefined });
    },
  );

  it.each(['thinking', 'working', 'waiting', 'blocked'] as const)(
    'prioritizes an older %s conversation over a newer completed conversation',
    (status) => {
      const first = [envelope('a', 1, { type: 'status', status }, 1)];
      const second = [envelope('b', 1, { type: 'run.done', durationMs: 1 }, 9)];
      for (const streams of [
        { first, second },
        { second, first },
      ]) {
        expect(buildRoster(streams, owners, t).chief).toEqual({
          status,
          live: t('status.' + status),
        });
      }
    },
  );

  it('uses the latest active conversation and keeps bot states separate', () => {
    const roster = buildRoster(
      {
        first: [envelope('a', 1, { type: 'status', status: 'thinking' }, 3)],
        second: [
          envelope('b', 2, toolStart, 8),
          envelope('b', 1, { type: 'status', status: 'working' }, 5),
        ],
        other: [envelope('c', 1, { type: 'run.done', durationMs: 1, cancelled: true }, 9)],
        unknown: [envelope('d', 1, { type: 'status', status: 'working' }, 10)],
        empty: [],
      },
      owners,
      t,
    );
    expect(roster).toEqual({
      chief: { status: 'working', live: t('now.command', { what: 'npm test' }) },
      helper: { status: 'idle', live: undefined },
    });
    expect(buildRoster({}, {}, t)).toEqual({});
  });
});

// 5. Sequence numbers only order events within a run at a shared timestamp.
describe('mergeEvents', () => {
  it('sorts by event time, earliest run time, then sequence, and deduplicates', () => {
    const b = envelope('b', 1, { type: 'status', status: 'thinking' }, 4);
    const aEnd = envelope('a', 99, { type: 'run.done', durationMs: 1 }, 4);
    const aStart = envelope('a', 98, { type: 'status', status: 'working' }, 1);
    const updated = { ...b, event: { type: 'status', status: 'working' } as const };
    const original = [b, aEnd, aStart];
    expect(mergeEvents(original, [updated])).toEqual([aStart, aEnd, updated]);
    expect(original).toEqual([b, aEnd, aStart]);
  });

  it('uses first appearance to break equal run start times before comparing sequence', () => {
    const b2 = envelope('b', 2, { type: 'run.done', durationMs: 1 }, 1);
    const a1 = envelope('a', 1, { type: 'status', status: 'thinking' }, 1);
    const b1 = envelope('b', 1, { type: 'status', status: 'working' }, 1);
    expect(mergeEvents([b2, a1], [b1])).toEqual([b1, b2, a1]);
    expect(mergeEvents([])).toEqual([]);
  });
});
