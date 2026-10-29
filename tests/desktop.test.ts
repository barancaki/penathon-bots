import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, Notification, Tray, MenuItemConstructorOptions } from 'electron';
import { Desktop, claimSingleInstance, handleAppQuit } from '../src/main/desktop';
import { channels } from '../src/shared/api';
import { settingsSchema, type SettingsPatch } from '../src/shared/settings';
import type { EventEnvelope } from '../src/shared/events';
import type { RoutineRun } from '../src/shared/routines';

const native = vi.hoisted(() => ({
  app: {
    requestSingleInstanceLock: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    setAppUserModelId: vi.fn(),
    on: vi.fn(),
    getAppPath: vi.fn(() => '.'),
  },
  trays: [] as unknown[],
  notices: [] as unknown[],
  menu: vi.fn((items) => items),
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: native.app,
    Menu: { buildFromTemplate: native.menu },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    Tray: class extends EventEmitter {
      setToolTip = vi.fn();
      setContextMenu = vi.fn();
      destroy = vi.fn();
      constructor() {
        super();
        native.trays.push(this);
      }
    },
    Notification: class extends EventEmitter {
      static isSupported() {
        return true;
      }
      show = vi.fn();
      close = vi.fn();
      constructor(public options: { title: string; body: string; silent?: boolean }) {
        super();
        native.notices.push(this);
      }
    },
  };
});
let desktop: Desktop;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  native.trays.length = 0;
  native.notices.length = 0;
});
afterEach(() => {
  desktop?.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  const config = settingsSchema.parse({ botsDir: 'bots', engines: { claude: {}, codex: {} } });
  const window = Object.assign(new EventEmitter(), {
    isFocused: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
    flashFrame: vi.fn(),
    setTitle: vi.fn(),
    setProgressBar: vi.fn(),
  });
  let current: BrowserWindow | undefined = window as unknown as BrowserWindow;
  const createWindow = vi.fn(() => {
    current = window as unknown as BrowserWindow;
    desktop.attachWindow(current);
  });
  const emit = vi.fn();
  const runInfo = vi.fn(() => ({ botId: 'chief', conversationId: 'chat', status: 'done' }));
  const get = vi.fn(() => ({
    events: [envelope({ type: 'message.done', messageId: 'a', text: '**Son cevap**' })],
  }));
  const setSettings = vi.fn(async (patch: SettingsPatch) => {
    Object.assign(config.notifications, patch.notifications);
    desktop.settingsChanged();
    return config;
  });
  desktop = new Desktop({
    window: () => current,
    createWindow,
    settings: () => config,
    setSettings,
    emit,
    bots: () => ({ get: () => ({ name: 'Şef', routines: [{ id: 'morning', name: 'Sabah' }] }) }),
    db: { runInfo, get },
  } as unknown as ConstructorParameters<typeof Desktop>[0]);
  desktop.attachWindow(current);
  return {
    config,
    window,
    createWindow,
    emit,
    runInfo,
    get,
    setSettings,
    clearWindow: () => {
      current = undefined;
    },
  };
}
function envelope(event: EventEnvelope['event'], runId = 'run'): EventEnvelope {
  return { runId, conversationId: 'chat', sequence: 1, createdAt: '', event };
}
function menu(): MenuItemConstructorOptions[] {
  return native.menu.mock.calls.at(-1)![0];
}
function click(label: string) {
  menu().find((item) => item.label === label)!.click!(
    undefined as never,
    undefined as never,
    undefined as never,
  );
}
function notices() {
  return native.notices as (Notification & {
    options: { title: string; body: string; silent?: boolean };
  })[];
}

it('refreshes tray labels, activity and the background notice when the interface language changes', () => {
  const { config, window } = setup();
  config.language = 'en';
  desktop.settingsChanged();
  expect(
    menu()
      .map((item) => item.label)
      .filter(Boolean),
  ).toEqual(['Open', 'Pause notifications', 'Quit']);
  const tray = native.trays[0] as Tray;
  expect(tray.setToolTip).toHaveBeenLastCalledWith('Penathon Bots — idle');
  desktop.updateActivity({
    running: [{ botId: 'chief', name: 'Chief', conversationId: 'chat' }],
    pendingApprovals: 2,
  });
  expect(window.setTitle).toHaveBeenLastCalledWith(
    'Penathon Bots — 1 running · 2 awaiting approval',
  );
  expect(tray.setToolTip).toHaveBeenLastCalledWith(
    'Penathon Bots — Running bots: 1 / 2 awaiting approval',
  );
  window.emit('close', { preventDefault: vi.fn() });
  expect(notices()[0].options.body).toBe(
    'Penathon Bots is running in the background; open it from the tray.',
  );
  config.language = 'tr';
  desktop.settingsChanged();
  expect(menu().some((item) => item.label === 'Aç')).toBe(true);
  expect(tray.setToolTip).toHaveBeenLastCalledWith(
    'Penathon Bots — 1 bot çalışıyor / 2 onay bekliyor',
  );
});

it('claims a single instance, restores the first instance and uses the builder app id on Windows', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  native.app.requestSingleInstanceLock.mockReturnValue(false);
  expect(claimSingleInstance(vi.fn())).toBe(false);
  expect(native.app.exit).toHaveBeenCalledWith(0);
  expect(native.app.on).not.toHaveBeenCalled();
  native.app.requestSingleInstanceLock.mockReturnValue(true);
  const show = vi.fn();
  expect(claimSingleInstance(show)).toBe(true);
  expect(native.app.setAppUserModelId).toHaveBeenCalledWith(
    readFileSync('electron-builder.yml', 'utf8')
      .match(/^appId: (.+)$/m)![1]
      .trim(),
  );
  native.app.on.mock.calls.find(([event]) => event === 'second-instance')![1]({}, ['app.exe']);
  expect(show).toHaveBeenCalledOnce();
});
it.each([true, false])('exits immediately for --quit (single instance lock: %s)', (primary) => {
  native.app.requestSingleInstanceLock.mockReturnValue(primary);
  const show = vi.fn();
  expect(claimSingleInstance(show, ['app.exe', '--quit'])).toBe(false);
  expect(native.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
  expect(native.app.exit).toHaveBeenCalledWith(0);
  expect(native.app.on).not.toHaveBeenCalled();
  expect(show).not.toHaveBeenCalled();
});
it('routes second-instance --quit through cleanup without showing the window', async () => {
  native.app.requestSingleInstanceLock.mockReturnValue(true);
  const show = vi.fn();
  claimSingleInstance(show);
  const cleanup = vi.fn(async () => {});
  handleAppQuit(cleanup);
  const beforeQuit = native.app.on.mock.calls.find(([event]) => event === 'before-quit')![1];
  native.app.quit.mockImplementationOnce(() => beforeQuit({ preventDefault: vi.fn() }));
  native.app.on.mock.calls.find(([event]) => event === 'second-instance')![1]({}, [
    'app.exe',
    '--quit',
  ]);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(show).not.toHaveBeenCalled();
  await Promise.resolve();
  await Promise.resolve();
  expect(native.app.quit).toHaveBeenCalledTimes(2);
});
it('hides on close by default, explains background once and allows closing during real quit', () => {
  const { window } = setup();
  const event = { preventDefault: vi.fn() };
  window.emit('close', event);
  window.emit('close', event);
  expect(window.hide).toHaveBeenCalledTimes(2);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(notices()).toHaveLength(1);
  expect(notices()[0].options.body).toBe(
    'Penathon Bots arka planda çalışıyor; tepsiden açabilirsin.',
  );
  expect(notices()[0].options).not.toHaveProperty('silent');
  desktop.close();
  window.emit('close', event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
});
it.each(['win32', 'darwin'])(
  'quits through cleanup when background is disabled on %s',
  async (platform) => {
    vi.stubGlobal('process', { ...process, platform });
    const { config, window } = setup();
    config.runInBackground = false;
    const cleanup = vi.fn(async () => {
      desktop.close();
    });
    handleAppQuit(cleanup);
    const beforeQuit = native.app.on.mock.calls.find(([event]) => event === 'before-quit')![1];
    native.app.quit.mockImplementationOnce(() => beforeQuit({ preventDefault: vi.fn() }));
    const event = { preventDefault: vi.fn() };
    window.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(window.hide).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(native.app.quit).toHaveBeenCalledTimes(2);
  },
);
it('updates title/progress/tooltip/activity and routes tray actions', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const { window, emit, config, setSettings } = setup();
  const activity = {
    running: [{ botId: 'chief', name: 'Şef', conversationId: 'chat' }],
    pendingApprovals: 2,
  };
  desktop.updateActivity(activity);
  expect(window.setTitle).toHaveBeenLastCalledWith('Penathon Bots — 1 çalışıyor · 2 onay bekliyor');
  expect(window.setProgressBar).toHaveBeenLastCalledWith(2);
  expect(emit).toHaveBeenCalledWith(channels.appOnActivity, activity);
  const tray = native.trays[0] as Tray;
  expect(tray.setToolTip).toHaveBeenLastCalledWith(
    'Penathon Bots — 1 bot çalışıyor / 2 onay bekliyor',
  );
  desktop.setView({});
  click('Şef');
  expect(emit).toHaveBeenCalledWith(channels.appNavigate, {
    botId: 'chief',
    conversationId: 'chat',
  });
  expect(window.restore).toHaveBeenCalled();
  tray.emit('click');
  expect(window.focus).toHaveBeenCalled();
  click('Bildirimleri duraklat');
  await Promise.resolve();
  expect(setSettings).toHaveBeenCalledWith({ notifications: { enabled: false } });
  expect(config.notifications.enabled).toBe(false);
  expect(menu().some((item) => item.label === 'Bildirimleri aç')).toBe(true);
  click('Çıkış');
  expect(native.app.quit).toHaveBeenCalledOnce();
  desktop.updateActivity({ running: [], pendingApprovals: 0 });
  expect(window.setTitle).toHaveBeenLastCalledWith('Penathon Bots');
  expect(window.setProgressBar).toHaveBeenLastCalledWith(-1);
});
it('queues navigation until the recreated renderer reports its view', () => {
  const { clearWindow, createWindow, emit } = setup();
  clearWindow();
  desktop.show({ roomId: 'room' });
  expect(createWindow).toHaveBeenCalledOnce();
  expect(emit.mock.calls.some(([channel]) => channel === channels.appNavigate)).toBe(false);
  desktop.setView({});
  expect(emit).toHaveBeenCalledWith(channels.appNavigate, { roomId: 'room' });
});
it('notifies completions (including Telegram runs), flashes approvals and opens their conversation', () => {
  const { window, emit } = setup();
  desktop.setView({});
  desktop.onChat(envelope({ type: 'run.done', durationMs: 1 }));
  vi.advanceTimersByTime(2000);
  expect(notices()[0].options).toMatchObject({ title: 'Şef', body: 'Son cevap' });
  notices()[0].emit('click');
  expect(window.show).toHaveBeenCalled();
  expect(window.focus).toHaveBeenCalled();
  expect(emit).toHaveBeenCalledWith(channels.appNavigate, {
    botId: 'chief',
    conversationId: 'chat',
  });
  desktop.onChat(
    envelope(
      { type: 'approval.request', approvalId: 'approval', title: 'Dosyayı yaz', details: '' },
      'approval-run',
    ),
  );
  expect(window.flashFrame).toHaveBeenLastCalledWith(true);
  window.emit('focus');
  expect(window.flashFrame).toHaveBeenLastCalledWith(false);
  vi.advanceTimersByTime(2000);
  expect(notices()[1].options.title).toBe('Onay bekliyor: Şef');
});
it('deduplicates routine/chat terminal events, skips cancellations and routes room messages', () => {
  const { runInfo, config, emit } = setup();
  desktop.setView({});
  runInfo.mockReturnValue({
    botId: 'chief',
    conversationId: 'chat',
    status: 'done',
    routineId: 'morning',
  } as never);
  desktop.onRoutine({
    id: 'run',
    botId: 'chief',
    conversationId: 'chat',
    routineId: 'morning',
    startedAt: '',
    status: 'done',
    summary: 'Özet',
  });
  desktop.onChat(envelope({ type: 'run.done', durationMs: 1 }));
  vi.advanceTimersByTime(2000);
  expect(notices()).toHaveLength(1);
  expect(notices()[0].options.title).toBe('⏰ Sabah');
  for (const status of ['skipped', 'cancelled'] as const)
    desktop.onRoutine({
      id: status,
      botId: 'chief',
      routineId: 'morning',
      conversationId: 'chat',
      startedAt: '',
      status,
    });
  config.notifications.rooms = true;
  runInfo.mockReturnValue({
    botId: 'chief',
    conversationId: 'chat',
    status: 'done',
    roomId: 'room',
  } as never);
  desktop.onChat(envelope({ type: 'run.done', durationMs: 1 }, 'room-run'));
  desktop.onRoom({
    id: 'msg',
    roomId: 'room',
    runId: 'room-run',
    author: { kind: 'bot', botId: 'chief' },
    text: 'Oda cevabı',
    createdAt: '',
  });
  vi.advanceTimersByTime(2000);
  expect(notices()).toHaveLength(2);
  notices()[1].emit('click');
  expect(emit).toHaveBeenCalledWith(channels.appNavigate, { roomId: 'room' });
  desktop.onRoutine({
    id: 'launch-error',
    botId: 'chief',
    routineId: 'morning',
    conversationId: '',
    status: 'error',
    summary: 'errors.engine',
  } as RoutineRun);
  vi.advanceTimersByTime(2000);
  expect(notices()[2].options.body).not.toContain('errors.engine');
});
it('dismisses resolved approvals and does not notify while focused on that conversation', () => {
  const { window } = setup();
  desktop.onChat(
    envelope({ type: 'approval.request', approvalId: 'approval', title: 'Onay', details: '' }),
  );
  desktop.onChat(
    envelope({ type: 'approval.resolved', approvalId: 'approval', decision: 'approved' }),
  );
  vi.advanceTimersByTime(2000);
  expect(notices()).toHaveLength(0);
  window.isFocused.mockReturnValue(true);
  desktop.setView({ botId: 'chief', conversationId: 'chat' });
  desktop.onChat(envelope({ type: 'run.error', code: 'test', message: 'Failure' }));
  vi.advanceTimersByTime(2000);
  expect(notices()).toHaveLength(0);
});

it('holds repeated quit requests until cleanup finishes and still quits if cleanup fails', async () => {
  let finish!: () => void;
  const cleanup = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  handleAppQuit(cleanup);
  const handler = native.app.on.mock.calls.find(([event]) => event === 'before-quit')![1];
  const event = { preventDefault: vi.fn() };
  handler(event);
  handler(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(native.app.quit).not.toHaveBeenCalled();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(native.app.quit).toHaveBeenCalledOnce();
  handler(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  handleAppQuit(async () => {
    throw new Error('cleanup failed');
  });
  native.app.on.mock.calls.at(-1)![1](event);
  await Promise.resolve();
  await Promise.resolve();
  expect(native.app.quit).toHaveBeenCalledTimes(2);
  warn.mockRestore();
});
it('ignores late activity and events after disposing the tray during shutdown', () => {
  const { runInfo } = setup();
  desktop.close();
  const tray = native.trays[0] as Tray;
  vi.mocked(tray.setToolTip).mockClear();
  desktop.updateActivity({ running: [], pendingApprovals: 0 });
  desktop.onChat(envelope({ type: 'run.done', durationMs: 1 }));
  expect(tray.setToolTip).not.toHaveBeenCalled();
  expect(runInfo).not.toHaveBeenCalled();
  desktop.close();
  expect(tray.destroy).toHaveBeenCalledOnce();
});
