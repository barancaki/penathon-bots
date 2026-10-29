import { expect, it } from 'vitest';
import { Approvals } from '../src/main/bots/approvals';
import type { BotEvent } from '../src/shared/events';
import { testBot } from './helpers';
it('settles an already accepted save before the run ends, even when cancellation races it', async () => {
  const approvals = new Approvals();
  const controller = new AbortController();
  const events: BotEvent[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = approvals.request(
    'run',
    { title: 'Create', details: '' },
    controller.signal,
    (event) => events.push(event),
    async () => {
      await hold;
      return testBot();
    },
  );
  const request = events[0];
  if (request.type !== 'approval.request') throw Error('Missing request');
  const responding = approvals.respond(request.approvalId, 'approved');
  controller.abort();
  let settled = false;
  const settling = approvals.settleRun('run').then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await Promise.all([responding, settling]);
  expect(await result).toEqual(testBot());
  expect(events.filter((event) => event.type === 'approval.resolved')).toEqual([
    {
      type: 'approval.resolved',
      approvalId: request.approvalId,
      decision: 'approved',
      botId: 'helper',
    },
  ]);
});
