import { beforeEach, expect, it, vi } from 'vitest';
import { registerIpc } from '../src/main/ipc';
import { channels } from '../src/shared/api';
import { Rooms } from '../src/main/rooms';
import { Repository } from '../src/main/db';
import type { BotStore } from '../src/main/bots/store';
import type { ChatService } from '../src/main/chat';

const ipc = vi.hoisted(() => ({ handle: vi.fn(), pick: vi.fn(), focused: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: ipc,
  dialog: { showOpenDialog: ipc.pick },
  BrowserWindow: { getFocusedWindow: ipc.focused },
}));
beforeEach(() => vi.clearAllMocks());
it('validates and routes every room operation through the trusted renderer bridge', async () => {
  const webContents = { mainFrame: {} };
  const rooms = {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    messages: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
    activity: vi.fn(),
  };
  registerIpc({ window: () => ({ webContents }), chat: { rooms } } as unknown as Parameters<
    typeof registerIpc
  >[0]);
  const sender = { sender: webContents, senderFrame: webContents.mainFrame };
  const invoke = (channel: string, ...args: unknown[]) =>
    ipc.handle.mock.calls.find(([name]) => name === channel)![1](sender, ...args);
  const draft = { name: 'Launch', members: ['chief', 'worker'] };
  await invoke(channels.roomsList);
  await invoke(channels.roomsCreate, draft);
  await invoke(channels.roomsUpdate, 'room', { lead: 'worker' });
  await invoke(channels.roomsMessages, 'room', 30);
  await invoke(channels.roomsSend, 'room', '  Hello  ');
  await invoke(channels.roomsCancel, 'room');
  await invoke(channels.roomsActivity, 'room');
  await invoke(channels.roomsDelete, 'room');
  expect(rooms.list).toHaveBeenCalledWith();
  expect(rooms.create).toHaveBeenCalledWith(draft);
  expect(rooms.update).toHaveBeenCalledWith('room', { lead: 'worker' });
  expect(rooms.messages).toHaveBeenCalledWith('room', 30);
  expect(rooms.send).toHaveBeenCalledWith('room', 'Hello');
  expect(rooms.cancel).toHaveBeenCalledWith('room');
  expect(rooms.activity).toHaveBeenCalledWith('room');
  expect(rooms.delete).toHaveBeenCalledWith('room');
  await expect(invoke(channels.roomsCreate, { ...draft, members: [] })).rejects.toThrow(
    'errors.invalidInput',
  );
  await expect(invoke(channels.roomsCreate, { ...draft, admin: true })).rejects.toThrow(
    'errors.invalidInput',
  );
  await expect(invoke(channels.roomsMessages, 'room', -1)).rejects.toThrow('errors.invalidInput');
  await expect(invoke(channels.roomsSend, 'room', ' ')).rejects.toThrow('errors.invalidInput');
  await expect(invoke(channels.roomsUpdate, 'room', { members: ['../escape'] })).rejects.toThrow(
    'errors.invalidInput',
  );
  const handler = ipc.handle.mock.calls.find(([channel]) => channel === channels.roomsCreate)![1];
  await expect(handler({ ...sender, senderFrame: {} }, draft)).rejects.toThrow('errors.ipcDenied');
});
it('validates and routes routines, report filters and routine approval edits', async () => {
  const webContents = { mainFrame: {} };
  const routines = { list: vi.fn(), save: vi.fn(), delete: vi.fn(), runNow: vi.fn() };
  const db = { routineRuns: vi.fn(), reports: vi.fn() };
  const processReportNow = vi.fn();
  const respond = vi.fn();
  registerIpc({
    window: () => ({ webContents }),
    bots: () => ({ get: vi.fn() }),
    chat: { routines, processReportNow, approvals: { respond } },
    db,
  } as unknown as Parameters<typeof registerIpc>[0]);
  const sender = { sender: webContents, senderFrame: webContents.mainFrame };
  const invoke = (channel: string, ...args: unknown[]) =>
    ipc.handle.mock.calls.find(([name]) => name === channel)![1](sender, ...args);
  const draft = {
    name: 'Mail summary',
    schedule: { kind: 'daily', time: '09:00' },
    prompt: 'Summarize',
    enabled: true,
  };
  await invoke(channels.routinesList, 'chief');
  await invoke(channels.routinesSave, 'chief', draft);
  await invoke(channels.routinesRunNow, 'chief', 'vault-update');
  await invoke(channels.routinesDelete, 'worker', 'summary');
  await invoke(channels.routinesRuns, 'chief', 'vault-update', 12);
  await invoke(channels.reportsList, { pending: true, botId: 'worker', limit: 5 });
  await invoke(channels.reportsProcessNow, 'report');
  await invoke(channels.approvalsRespond, 'approval', 'approved', { enabled: false });
  expect(routines.list).toHaveBeenCalledWith('chief');
  expect(routines.save).toHaveBeenCalledWith('chief', draft);
  expect(routines.runNow).toHaveBeenCalledWith('chief', 'vault-update');
  expect(routines.delete).toHaveBeenCalledWith('worker', 'summary');
  expect(db.routineRuns).toHaveBeenCalledWith('chief', 'vault-update', 12);
  expect(db.reports).toHaveBeenCalledWith({ pending: true, botId: 'worker', limit: 5 });
  expect(processReportNow).toHaveBeenCalledWith('report');
  expect(respond).toHaveBeenCalledWith('approval', 'approved', { enabled: false });
  await expect(invoke(channels.routinesSave, 'chief', { ...draft, system: true })).rejects.toThrow(
    'errors.invalidInput',
  );
  await expect(
    invoke(channels.routinesSave, 'chief', {
      ...draft,
      schedule: { kind: 'interval', everyMinutes: 1 },
    }),
  ).rejects.toThrow('errors.invalidInput');
  await expect(invoke(channels.routinesRuns, 'chief', 'vault-update', 0)).rejects.toThrow(
    'errors.invalidInput',
  );
  await expect(invoke(channels.reportsList, { pending: 'yes' })).rejects.toThrow(
    'errors.invalidInput',
  );
});
it('validates conversation deletion arguments and sender, awaits deletion and preserves missing-ID errors', async () => {
  const webContents = { mainFrame: {} };
  const remove = vi.fn().mockResolvedValue(undefined);
  registerIpc({
    window: () => ({ webContents }),
    chat: { delete: remove },
  } as unknown as Parameters<typeof registerIpc>[0]);
  const handler = ipc.handle.mock.calls.find(
    ([channel]) => channel === channels.conversationsDelete,
  )![1];
  const sender = { sender: webContents, senderFrame: webContents.mainFrame };
  for (const args of [[], [''], [42], ['../escape'], ['a'.repeat(101)], ['valid', 'extra']])
    await expect(handler(sender, ...args)).rejects.toThrow('errors.invalidInput');
  await expect(handler({ ...sender, senderFrame: {} }, 'valid')).rejects.toThrow(
    'errors.ipcDenied',
  );
  expect(remove).not.toHaveBeenCalled();
  await expect(handler(sender, 'conversation-1')).resolves.toBeUndefined();
  expect(remove).toHaveBeenCalledWith('conversation-1');
  remove.mockRejectedValueOnce(new Error('errors.conversationMissing'));
  await expect(handler(sender, 'missing')).rejects.toThrow('errors.conversationMissing');
});

it('validates and routes bot creation, updates, memory, approvals and connection refresh', async () => {
  const webContents = { mainFrame: {} };
  const bots = {
    create: vi.fn(),
    update: vi.fn(),
    setMemory: vi.fn(),
    getMemory: vi.fn().mockResolvedValue('Notes'),
  };
  const respond = vi.fn();
  const claudeConnection = { name: 'mail', source: 'user', status: 'connected' };
  const codexConnection = { name: 'filesystem', source: 'codex', status: 'unknown' };
  const connections = vi.fn().mockResolvedValue([claudeConnection]);
  const codexConnections = vi.fn().mockResolvedValue([codexConnection]);
  registerIpc({
    window: () => ({ webContents }),
    bots: () => bots,
    chat: { approvals: { respond } },
    engines: { claude: { connections }, codex: { connections: codexConnections } },
  } as unknown as Parameters<typeof registerIpc>[0]);
  const sender = { sender: webContents, senderFrame: webContents.mainFrame };
  const invoke = (channel: string, ...args: unknown[]) =>
    ipc.handle.mock.calls.find(([name]) => name === channel)![1](sender, ...args);
  const draft = { name: 'Writer', engine: 'claude', instructions: 'Write' };
  await invoke(channels.botsCreate, draft);
  expect(bots.create).toHaveBeenCalledWith(draft);
  await invoke(channels.botsUpdate, 'chief', { name: 'Atlas' });
  expect(bots.update).toHaveBeenCalledWith('chief', { name: 'Atlas' });
  await invoke(channels.botsMakePermanent, 'child');
  expect(bots.update).toHaveBeenCalledWith('child', { temporary: false });
  await invoke(channels.botsMemorySet, 'chief', 'Notes');
  expect(bots.setMemory).toHaveBeenCalledWith('chief', 'Notes');
  expect(await invoke(channels.botsMemoryGet, 'chief')).toBe('Notes');
  await invoke(channels.approvalsRespond, 'approval', 'approved', { name: 'Edited' });
  expect(respond).toHaveBeenCalledWith('approval', 'approved', { name: 'Edited' });
  expect(await invoke(channels.connectionsList, true)).toEqual([claudeConnection, codexConnection]);
  expect(codexConnections).toHaveBeenCalledWith(true);
  expect(connections).toHaveBeenCalledWith(true);
  await expect(invoke(channels.connectionsList, 'yes')).rejects.toThrow('errors.invalidInput');
  await expect(invoke(channels.botsUpdate, 'chief', { system: false })).rejects.toThrow(
    'errors.invalidInput',
  );
  await expect(invoke(channels.botsMemorySet, 'chief', 42)).rejects.toThrow('errors.invalidInput');
  await expect(invoke(channels.approvalsRespond, 'approval', 'expired')).rejects.toThrow(
    'errors.invalidInput',
  );
});
it('checks every descendant for activity before deleting a bot tree', async () => {
  const webContents = { mainFrame: {} };
  const remove = vi.fn();
  const active = vi.fn((id: string) => id === 'child');
  registerIpc({
    window: () => ({ webContents }),
    bots: () => ({ descendants: () => [{ id: 'child' }], delete: remove }),
    chat: { isBotActive: active },
  } as unknown as Parameters<typeof registerIpc>[0]);
  const handler = ipc.handle.mock.calls.find(([channel]) => channel === channels.botsDelete)![1];
  await expect(
    handler({ sender: webContents, senderFrame: webContents.mainFrame }, 'parent'),
  ).rejects.toThrow('errors.botBusy');
  expect(remove).not.toHaveBeenCalled();
});

it('removes deleted bots and descendants from rooms, replaces leads and emits room changes', async () => {
  const webContents = { mainFrame: {} };
  const remaining = new Set(['parent', 'child', 'grandchild', 'chief', 'first', 'other']);
  const bots = {
    get: (id: string) => {
      if (!remaining.has(id)) throw new Error('errors.botMissing');
      return { id };
    },
    descendants: () => [{ id: 'child' }, { id: 'grandchild' }],
    delete: vi.fn(async () => {
      for (const id of ['parent', 'child', 'grandchild']) remaining.delete(id);
    }),
  };
  const db = new Repository(':memory:');
  const rooms = new Rooms(
    () => bots as unknown as BotStore,
    db,
    {} as ChatService,
    () => [],
  );
  const withChief = rooms.create({
    name: 'Chief fallback',
    members: ['first', 'parent', 'chief'],
    lead: 'parent',
  });
  const withFirst = rooms.create({
    name: 'First fallback',
    members: ['grandchild', 'first', 'other'],
    lead: 'grandchild',
  });
  const empty = rooms.create({ name: 'Empty', members: ['parent', 'child', 'grandchild'] });
  const keepLead = rooms.create({ name: 'Keep lead', members: ['child', 'first'], lead: 'first' });
  const untouched = rooms.create({ name: 'Untouched', members: ['other'] });
  const changed = vi.fn();
  rooms.on('changed', changed);
  registerIpc({
    window: () => ({ webContents }),
    bots: () => bots,
    chat: { rooms, isBotActive: () => false },
  } as unknown as Parameters<typeof registerIpc>[0]);
  const handler = ipc.handle.mock.calls.find(([channel]) => channel === channels.botsDelete)![1];
  try {
    await handler({ sender: webContents, senderFrame: webContents.mainFrame }, 'parent');
    expect(bots.delete).toHaveBeenCalledExactlyOnceWith('parent');
    expect(db.room(withChief.id)).toMatchObject({ members: ['first', 'chief'], lead: 'chief' });
    expect(db.room(withFirst.id)).toMatchObject({ members: ['first', 'other'], lead: 'first' });
    expect(db.room(keepLead.id)).toMatchObject({ members: ['first'], lead: 'first' });
    expect(db.room(untouched.id)).toEqual(untouched);
    expect(() => db.room(empty.id)).toThrow('errors.roomMissing');
    expect(changed).toHaveBeenCalledTimes(4);
    bots.delete.mockRejectedValueOnce(new Error('errors.chiefProtected'));
    await expect(
      handler({ sender: webContents, senderFrame: webContents.mainFrame }, 'chief'),
    ).rejects.toThrow('errors.chiefProtected');
    expect(changed).toHaveBeenCalledTimes(4);
  } finally {
    db.close();
  }
});

it('validates project IPC, routes updates and binds folder picking to the focused window', async () => {
  const webContents = { mainFrame: {} };
  const focused = { id: 'focused' };
  ipc.focused.mockReturnValue(focused);
  const projects = { list: vi.fn().mockReturnValue([]), save: vi.fn(), delete: vi.fn() };
  const bots = { update: vi.fn() };
  registerIpc({
    window: () => ({ webContents }),
    projects,
    bots: () => bots,
  } as unknown as Parameters<typeof registerIpc>[0]);
  const sender = { sender: webContents, senderFrame: webContents.mainFrame };
  const invoke = (channel: string, ...args: unknown[]) =>
    ipc.handle.mock.calls.find(([name]) => name === channel)![1](sender, ...args);
  expect(await invoke(channels.projectsList)).toEqual([]);
  const draft = { name: 'Project', folders: ['C:/work'] };
  await invoke(channels.projectsSave, draft);
  expect(projects.save).toHaveBeenCalledWith(draft);
  await invoke(channels.projectsDelete, 'project');
  expect(projects.delete).toHaveBeenCalledWith('project');
  await invoke(channels.botsUpdate, 'chief', { projects: [{ project: 'project', level: 'read' }] });
  expect(bots.update).toHaveBeenCalledWith('chief', {
    projects: [{ project: 'project', level: 'read' }],
  });
  await expect(invoke(channels.projectsSave, { name: 'bad', folders: [] })).rejects.toThrow(
    'errors.invalidInput',
  );
  ipc.pick.mockResolvedValue({ canceled: false, filePaths: ['C:/picked'] });
  expect(await invoke(channels.projectsPickFolder)).toBe('C:/picked');
  expect(ipc.pick).toHaveBeenCalledWith(focused, {
    properties: ['openDirectory', 'createDirectory'],
  });
  ipc.pick.mockResolvedValue({ canceled: true, filePaths: [] });
  expect(await invoke(channels.projectsPickFolder)).toBeNull();
});
it('validates Telegram operations and never accepts managed settings or untrusted IPC', async () => {
  const webContents = { mainFrame: {} };
  const telegram = {
    status: vi.fn(),
    setToken: vi.fn(),
    startPairing: vi.fn(),
    unpair: vi.fn(),
    setOptions: vi.fn(),
  };
  registerIpc({ window: () => ({ webContents }), telegram } as unknown as Parameters<
    typeof registerIpc
  >[0]);
  const sender = { sender: webContents, senderFrame: webContents.mainFrame };
  const invoke = (channel: string, ...args: unknown[]) =>
    ipc.handle.mock.calls.find(([name]) => name === channel)![1](sender, ...args);
  await invoke(channels.telegramStatus);
  await invoke(channels.telegramSetToken, ' 123:fake ');
  await invoke(channels.telegramSetToken, null);
  await invoke(channels.telegramStartPairing);
  await invoke(channels.telegramUnpair);
  await invoke(channels.telegramSetOptions, {
    enabled: false,
    routeTo: 'chief',
    notifyRoutines: true,
  });
  expect(telegram.status).toHaveBeenCalledWith();
  expect(telegram.setToken.mock.calls).toEqual([['123:fake'], [null]]);
  expect(telegram.startPairing).toHaveBeenCalledWith();
  expect(telegram.unpair).toHaveBeenCalledWith();
  expect(telegram.setOptions).toHaveBeenCalledWith({
    enabled: false,
    routeTo: 'chief',
    notifyRoutines: true,
  });
  for (const bad of ['', 123, {}, 'x'.repeat(8193)])
    await expect(invoke(channels.telegramSetToken, bad)).rejects.toThrow('errors.invalidInput');
  for (const bad of [
    { token: 'never' },
    { pairedChatId: 123 },
    { enabled: 'true' },
    { routeTo: '../escape' },
  ])
    await expect(invoke(channels.telegramSetOptions, bad)).rejects.toThrow('errors.invalidInput');
  await expect(invoke(channels.settingsSet, { telegram: { pairedChatId: 123 } })).rejects.toThrow(
    'errors.invalidInput',
  );
  const handler = ipc.handle.mock.calls.find(
    ([channel]) => channel === channels.telegramSetToken,
  )![1];
  await expect(handler({ ...sender, senderFrame: {} }, '123:fake')).rejects.toThrow(
    'errors.ipcDenied',
  );
});

it('routes app activity, view and quit only from the trusted main frame and validates view fields', async () => {
  const webContents = { mainFrame: {} };
  const app = { setView: vi.fn(), quit: vi.fn() };
  const activity = vi.fn(() => ({ running: [], pendingApprovals: 0 }));
  registerIpc({ window: () => ({ webContents }), app, chat: { activity } } as unknown as Parameters<
    typeof registerIpc
  >[0]);
  const sender = { sender: webContents, senderFrame: webContents.mainFrame };
  const invoke = (channel: string, ...args: unknown[]) =>
    ipc.handle.mock.calls.find(([name]) => name === channel)![1](sender, ...args);
  await invoke(channels.appSetView, { botId: 'chief', conversationId: 'chat' });
  expect(app.setView).toHaveBeenCalledWith({ botId: 'chief', conversationId: 'chat' });
  await invoke(channels.appSetView, { roomId: 'room' });
  await invoke(channels.appSetView, {});
  for (const view of [{ botId: '../x' }, { conversationId: 3 }, { roomId: '' }, { unknown: true }])
    await expect(invoke(channels.appSetView, view)).rejects.toThrow('errors.invalidInput');
  expect(await invoke(channels.appActivity)).toEqual({ running: [], pendingApprovals: 0 });
  const quit = ipc.handle.mock.calls.find(([name]) => name === channels.appQuit)![1];
  await expect(quit({ ...sender, senderFrame: {} })).rejects.toThrow('errors.ipcDenied');
  expect(app.quit).not.toHaveBeenCalled();
  await invoke(channels.appQuit);
  expect(app.quit).toHaveBeenCalledTimes(1);
});
