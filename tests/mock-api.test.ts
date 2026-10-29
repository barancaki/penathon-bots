import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockApi } from '../src/renderer/src/dev/mock-api';
import type { BotEvent } from '../src/shared/events';
let events: BotEvent[];
let unsubscribe: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  events = [];
  unsubscribe = mockApi.chat.onEvent((envelope) => events.push(envelope.event));
});
afterEach(() => {
  unsubscribe();
  vi.useRealTimers();
});
it('provides a sample room, routes mentions and lead replies, publishes activity and cleans up hidden room chats', async () => {
  const sample = (await mockApi.rooms.list())[0];
  expect(sample.members).toEqual(['chief', 'leads', 'content']);
  expect((await mockApi.rooms.messages(sample.id)).length).toBeGreaterThan(2);
  const room = await mockApi.rooms.create({
    name: 'Mock launch',
    members: ['content', 'chief', 'leads'],
  });
  expect(room.lead).toBe('chief');
  const changed = vi.fn();
  const message = vi.fn();
  const activity = vi.fn();
  const off = [
    mockApi.rooms.onChanged(changed),
    mockApi.rooms.onMessage(message),
    mockApi.rooms.onActivity(activity),
  ];
  await mockApi.rooms.send(room.id, '@Lead_Takibi @"İçerik Stüdyosu"');
  expect(message.mock.calls[0][0].author).toEqual({ kind: 'user' });
  expect(await mockApi.rooms.activity(room.id)).toMatchObject({
    active: 'leads',
    queue: ['content'],
  });
  await vi.advanceTimersByTimeAsync(1500);
  let replies = (await mockApi.rooms.messages(room.id)).filter(
    (message) => message.author.kind === 'bot',
  );
  expect(replies.map((message) => message.author)).toEqual([
    { kind: 'bot', botId: 'leads' },
    { kind: 'bot', botId: 'content' },
  ]);
  for (const reply of replies) {
    expect(
      (await mockApi.conversations.get(reply.conversationId!)).events.some(
        (event) => event.runId === reply.runId,
      ),
    ).toBe(true);
    expect(
      (await mockApi.conversations.list('leads')).some(
        (conversation) => conversation.id === reply.conversationId,
      ),
    ).toBe(false);
  }
  await mockApi.rooms.send(room.id, 'No mention');
  await vi.advanceTimersByTimeAsync(750);
  replies = (await mockApi.rooms.messages(room.id)).filter(
    (message) => message.author.kind === 'bot',
  );
  expect(replies.at(-1)?.author).toEqual({ kind: 'bot', botId: 'chief' });
  await mockApi.rooms.send(room.id, '@LeadTakibi @Chief');
  await mockApi.rooms.cancel(room.id);
  await vi.advanceTimersByTimeAsync(1500);
  expect(
    (await mockApi.rooms.messages(room.id)).filter((message) => message.author.kind === 'bot'),
  ).toHaveLength(3);
  expect(await mockApi.rooms.activity(room.id)).toEqual({
    roomId: room.id,
    active: undefined,
    queue: [],
  });
  await mockApi.rooms.update(room.id, { members: ['content'] });
  expect((await mockApi.rooms.list()).find((value) => value.id === room.id)?.lead).toBe('content');
  await mockApi.rooms.delete(room.id);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(activity).toHaveBeenCalled();
  expect((await mockApi.rooms.list()).some((value) => value.id === room.id)).toBe(false);
  for (const reply of replies)
    expect((await mockApi.conversations.get(reply.conversationId!)).conversation).toBeUndefined();
  off.forEach((unsubscribe) => unsubscribe());
});
it('provides sample routines, histories and reports, with routine approval and working subscriptions', async () => {
  const bots = await mockApi.bots.list();
  for (const bot of bots) {
    const states = await mockApi.routines.list(bot.id);
    expect(states.length).toBeGreaterThan(0);
    expect(
      (await mockApi.routines.runs(bot.id, states[0].routine.id)).map((run) => run.status),
    ).toEqual(['done', 'skipped', 'error']);
  }
  expect((await mockApi.routines.list('chief'))[0].routine).toMatchObject({
    id: 'vault-update',
    system: true,
    model: 'haiku',
  });
  await expect(mockApi.routines.delete('chief', 'vault-update')).rejects.toThrow();
  const changed = vi.fn();
  const off = mockApi.routines.onChanged(changed);
  const conversation = await mockApi.chat.send('brief', 'Her sabah bir rutin kur');
  await vi.advanceTimersByTimeAsync(500);
  const request = events.find((event) => event.type === 'approval.request');
  if (request?.type !== 'approval.request') throw new Error('Missing routine approval');
  expect(request.kind).toBe('routine.create');
  await mockApi.approvals.respond(request.approvalId, 'approved');
  expect(changed).toHaveBeenCalledWith('brief');
  const state = (await mockApi.routines.list('brief')).find(
    (state) => state.routine.name === 'Sabah mail özeti',
  )!;
  const run = await mockApi.routines.runNow('brief', state.routine.id);
  expect(run.conversationId).not.toBe(conversation.conversationId);
  await vi.advanceTimersByTimeAsync(1500);
  expect((await mockApi.routines.runs('brief', state.routine.id))[0].status).toBe('done');
  off();
  await mockApi.routines.delete('brief', state.routine.id);
  const pending = await mockApi.reports.list({ pending: true });
  expect(pending).toHaveLength(3);
  const reportChanged = vi.fn();
  const offReports = mockApi.reports.onChanged(reportChanged);
  const processed = await mockApi.reports.processNow(pending[0].id);
  expect((await mockApi.conversations.get(processed.conversationId)).conversation).toMatchObject({
    botId: 'chief',
    title: 'routines.reportProcessing',
  });
  await vi.advanceTimersByTimeAsync(1500);
  expect(await mockApi.reports.list({ pending: true })).toHaveLength(2);
  expect(reportChanged).toHaveBeenCalledTimes(1);
  offReports();
  await mockApi.settings.set({ knowledgeDir: 'C:/vault' });
  expect((await mockApi.routines.list('chief'))[0].routine.enabled).toBe(true);
  await mockApi.settings.set({ knowledgeDir: null });
  expect((await mockApi.routines.list('chief'))[0].routine.enabled).toBe(false);
});
it('mocks creation approval with edits, memory, persistence and connections', async () => {
  const run = await mockApi.chat.send('chief', 'Bir bot kur');
  await vi.advanceTimersByTimeAsync(500);
  const request = events.find((event) => event.type === 'approval.request');
  expect(request?.type).toBe('approval.request');
  if (request?.type !== 'approval.request') throw Error('missing approval');
  const before = (await mockApi.bots.list()).length;
  expect(events.some((event) => event.type === 'run.done')).toBe(false);
  await mockApi.approvals.respond(request.approvalId, 'approved', {
    name: 'Edited mock bot',
    engine: 'claude',
    instructions: 'Help',
  });
  expect((await mockApi.bots.list()).length).toBe(before + 1);
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'approval.resolved', decision: 'edited' }),
  );
  const bot = (await mockApi.bots.list()).find((bot) => bot.name === 'Edited mock bot')!;
  await mockApi.bots.update(bot.id, { role: 'Research' });
  await mockApi.bots.memory.set(bot.id, 'Tea');
  expect(await mockApi.bots.memory.get(bot.id)).toBe('Tea');
  expect((await mockApi.conversations.get(run.conversationId)).messages.at(-1)?.text).toContain(
    'Edited mock bot',
  );
  expect(await mockApi.connections.list()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'team', source: 'app' }),
      expect.objectContaining({ name: 'penathon', source: 'user' }),
    ]),
  );
  expect((await mockApi.bots.list()).some((bot) => bot.temporary && bot.parent)).toBe(true);
  await mockApi.bots.delete(bot.id);
});
it('expires a mock approval on cancellation and rejects later responses', async () => {
  const run = await mockApi.chat.send('chief', 'bot oluştur');
  await vi.advanceTimersByTimeAsync(500);
  const request = events.find((event) => event.type === 'approval.request');
  if (request?.type !== 'approval.request') throw Error('missing approval');
  await mockApi.chat.cancel(run.conversationId);
  expect(events).toContainEqual({
    type: 'approval.resolved',
    approvalId: request.approvalId,
    decision: 'expired',
  });
  await expect(mockApi.approvals.respond(request.approvalId, 'approved')).rejects.toThrow();
});

it.each([
  ['sil', 'file.delete'],
  ['projeye erişim ver', 'project.grant'],
])('mocks approval cards for %s', async (text, kind) => {
  const before = (await mockApi.bots.list()).length;
  await mockApi.chat.send('chief', text);
  await vi.advanceTimersByTimeAsync(500);
  const request = events.find((event) => event.type === 'approval.request');
  if (request?.type !== 'approval.request') throw Error('missing approval');
  expect(request.kind).toBe(kind);
  expect(events.some((event) => event.type === 'run.done')).toBe(false);
  await mockApi.approvals.respond(request.approvalId, 'approved');
  expect((await mockApi.bots.list()).length).toBe(before);
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'approval.resolved', decision: 'approved' }),
  );
});
it('mocks sample project groups, edits, subscriptions and grant cleanup', async () => {
  const initial = await mockApi.projects.list();
  expect(initial.find((project) => project.name === 'Acme')?.folders).toHaveLength(2);
  expect(initial.find((project) => project.name === 'Penathon Web')?.folders).toHaveLength(1);
  const changed = vi.fn();
  const off = mockApi.projects.onChanged(changed);
  const project = await mockApi.projects.save({ name: 'Mock Project', folders: ['C:/work/mock'] });
  const duplicate = await mockApi.projects.save({
    name: 'Mock Project',
    folders: ['C:/work/mock'],
  });
  expect(duplicate.id).toBe(project.id + '-2');
  await mockApi.bots.update('brief', { projects: [{ project: project.id, level: 'read' }] });
  await mockApi.projects.delete(project.id);
  expect((await mockApi.bots.get('brief')).projects).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(3);
  off();
  await mockApi.projects.delete(duplicate.id);
  expect(changed).toHaveBeenCalledTimes(3);
  expect(await mockApi.projects.pickFolder()).toBeTruthy();
});
it('mocks Telegram configuration, delayed pairing, options and subscriber cleanup without retaining tokens', async () => {
  const statuses = vi.fn();
  const off = mockApi.telegram.onStatus(statuses);
  const secret = '123:secret_mock_token';
  await mockApi.telegram.setToken(secret);
  expect(await mockApi.telegram.status()).toMatchObject({
    configured: true,
    running: true,
    enabled: true,
  });
  expect((await mockApi.telegram.startPairing()).pairingCode).toMatch(/^\d{6}$/);
  await vi.advanceTimersByTimeAsync(2999);
  expect((await mockApi.telegram.status()).pairedChat).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect((await mockApi.telegram.status()).pairedChat?.name).toBe('Alex');
  expect((await mockApi.telegram.status()).pairingCode).toBeUndefined();
  await mockApi.telegram.setOptions({ routeTo: 'content', notifyRoutines: false, enabled: false });
  expect(await mockApi.telegram.status()).toMatchObject({
    running: false,
    routeTo: 'content',
    notifyRoutines: false,
  });
  await mockApi.telegram.unpair();
  expect((await mockApi.telegram.status()).pairedChat).toBeUndefined();
  await mockApi.telegram.startPairing();
  await mockApi.telegram.setToken(null);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await mockApi.telegram.status()).toMatchObject({ configured: false, running: false });
  expect((await mockApi.telegram.status()).pairedChat).toBeUndefined();
  expect(JSON.stringify(statuses.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(await mockApi.settings.get())).not.toContain(secret);
  const count = statuses.mock.calls.length;
  off();
  await mockApi.telegram.setOptions({ routeTo: 'chief', notifyRoutines: true });
  expect(statuses).toHaveBeenCalledTimes(count);
});

it('implements the desktop app bridge and merges notification patches in browser previews', async () => {
  expect(await mockApi.app.activity()).toEqual({ running: [], pendingApprovals: 0 });
  mockApi.app.setView({ botId: 'chief', conversationId: 'c1' });
  const off = mockApi.app.onNavigate(vi.fn());
  const offActivity = mockApi.app.onActivity(vi.fn());
  off();
  offActivity();
  const before = structuredClone(await mockApi.settings.get());
  try {
    const saved = await mockApi.settings.set({
      runInBackground: false,
      notifications: { enabled: false },
    });
    expect(saved.runInBackground).toBe(false);
    expect(saved.notifications).toEqual({ ...before.notifications, enabled: false });
    await mockApi.app.quit();
  } finally {
    await mockApi.settings.set({
      runInBackground: before.runInBackground,
      notifications: before.notifications,
    });
  }
});

it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)(
  'uses the same safe sandbox default in the mock API under %s',
  async (sandbox) => {
    const parent = await mockApi.bots.create({
      name: 'Sandbox parent',
      engine: 'codex',
      instructions: '',
      sandbox,
    });
    const child = await mockApi.bots.create({
      name: 'Sandbox child',
      engine: 'codex',
      instructions: '',
      parent: parent.id,
    });
    expect(child.sandbox).toBe(sandbox === 'read-only' ? 'read-only' : 'workspace-write');
    expect(child.network).toBe(false);
    await mockApi.bots.delete(parent.id);
  },
);
