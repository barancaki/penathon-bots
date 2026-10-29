import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { registerIpc } from '../src/main/ipc';
import type { RunInput } from '../src/main/engines/types';
import { Repository } from '../src/main/db';
import { translate } from '../src/shared/i18n';
import { removeTemporary, temporaryDirectory, testBot } from './helpers';

const native = vi.hoisted(() => ({
  app: {
    on: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    whenReady: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setAppUserModelId: vi.fn(),
    getPath: vi.fn(),
    getAppPath: () => '.',
  },
  showMessageBox: vi.fn(async () => ({})),
  showErrorBox: vi.fn(),
  windows: [] as EventEmitter[],
  services: undefined as Parameters<typeof registerIpc>[0] | undefined,
  exited: false,
  engineCancel: vi.fn(),
  engineClose: vi.fn(),
  telegramClose: vi.fn(),
}));
vi.mock('electron', () => ({
  app: native.app,
  dialog: { showMessageBox: native.showMessageBox, showErrorBox: native.showErrorBox },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
  safeStorage: {},
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    });
    loadFile = vi.fn();
    loadURL = vi.fn();
    isDestroyed = () => false;
    constructor() {
      super();
      native.windows.push(this);
    }
  },
}));
vi.mock('../src/main/desktop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/desktop')>()),
  Desktop: class {
    attachWindow() {}
    updateActivity() {}
    onChat() {}
    onRoom() {}
    onRoutine() {}
    close() {}
  },
}));
vi.mock('../src/main/ipc', () => ({
  registerIpc: (services: Parameters<typeof registerIpc>[0]) => {
    native.services = services;
  },
}));
vi.mock('../src/main/telegram', () => ({
  TelegramBridge: class {
    async init() {}
    close = native.telegramClose;
    onEvent() {}
  },
}));
vi.mock('../src/main/engines/claude', () => ({
  ClaudeEngine: class {
    connections = async () => [];
    cancel = native.engineCancel;
    close = native.engineClose;
    async *run(input: RunInput) {
      await new Promise<void>((resolve) => {
        input.signal.addEventListener('abort', () => resolve(), { once: true });
        if (input.signal.aborted) resolve();
      });
      yield { type: 'run.done', durationMs: 1, cancelled: true };
    }
  },
}));
vi.mock('../src/main/engines/codex', () => ({ CodexEngine: class {} }));

let directory: string;
function emitApp(name: string, ...args: unknown[]) {
  for (const [event, handler] of native.app.on.mock.calls) if (event === name) handler(...args);
}
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  native.windows.length = 0;
  native.services = undefined;
  native.exited = false;
  directory = await temporaryDirectory();
  native.app.getPath.mockReturnValue(directory);
  native.app.requestSingleInstanceLock.mockReturnValue(true);
  native.app.exit.mockImplementation(() => {
    native.exited = true;
  });
  native.app.whenReady.mockResolvedValue(undefined);
  native.app.quit.mockImplementation(() => {
    const event = { preventDefault: vi.fn() };
    emitApp('before-quit', event);
    if (!event.preventDefault.mock.calls.length) native.exited = true;
  });
});
afterEach(async () => {
  if (!native.exited) {
    native.app.quit();
    await expect.poll(() => native.exited).toBe(true);
  }
  await removeTemporary(directory);
  vi.unstubAllGlobals();
});
async function start(language: 'tr' | 'en') {
  await writeFile(
    join(directory, 'settings.json'),
    JSON.stringify({
      language,
      botsDir: join(directory, 'bots'),
      engines: { claude: {}, codex: {} },
    }),
  );
  await import('../src/main/index');
  await expect.poll(() => native.windows.length).toBe(1);
  expect(native.showErrorBox).not.toHaveBeenCalled();
}

it.each([true, false])('does not start anything for --quit (primary: %s)', async (primary) => {
  vi.stubGlobal('process', { ...process, argv: ['Penathon Bots.exe', '--quit'] });
  native.app.requestSingleInstanceLock.mockReturnValue(primary);
  await import('../src/main/index');
  expect(native.app.exit).toHaveBeenCalledWith(0);
  expect(native.app.whenReady).not.toHaveBeenCalled();
  expect(native.app.getPath).not.toHaveBeenCalled();
  expect(native.windows).toEqual([]);
  expect(await readdir(directory)).toEqual([]);
});

it('keeps the startup log and error detail dialog for unrelated startup failures', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await writeFile(join(directory, 'settings.json'), 'invalid JSON');
    await import('../src/main/index');
    await expect.poll(() => native.showErrorBox.mock.calls.length).toBe(1);
    const detail = await readFile(join(directory, 'startup-error.log'), 'utf8');
    expect(detail).toContain('errors.settingsInvalid');
    expect(native.showErrorBox).toHaveBeenCalledWith(
      'Penathon Bots',
      `${translate('en', 'errors.startup')}\n\n${detail.split('\n')[0]}`,
    );
    expect(native.app.exit).toHaveBeenCalledWith(1);
    expect(native.showMessageBox).not.toHaveBeenCalled();
    expect(native.windows).toEqual([]);
    expect((await readdir(directory)).some((name) => name.startsWith('db-corrupt-'))).toBe(false);
  } finally {
    log.mockRestore();
  }
});

it.each(['tr', 'en'] as const)(
  'moves corrupt database files, opens a new database and warns once in %s after showing the window',
  async (language) => {
    const bytes = randomBytes(4096);
    const files = ['penathon.sqlite', 'penathon.sqlite-wal', 'penathon.sqlite-shm'];
    for (const file of files) await writeFile(join(directory, file), bytes);
    await writeFile(join(directory, 'memories.md'), 'Keep memory');
    await start(language);
    const backups = (await readdir(directory)).filter((name) => name.startsWith('db-corrupt-'));
    expect(backups).toHaveLength(1);
    const backupDirectory = join(directory, backups[0]);
    expect((await readdir(backupDirectory)).sort()).toEqual(files.sort());
    for (const file of files)
      expect((await readFile(join(backupDirectory, file))).equals(bytes)).toBe(true);
    expect(await readFile(join(directory, 'memories.md'), 'utf8')).toBe('Keep memory');
    expect(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).language).toBe(
      language,
    );
    const db = native.services!.db;
    expect(db.list('chief')).toEqual([]);
    const run = db.start(testBot(directory), 'New history works');
    expect(db.get(run.conversationId).messages[0].text).toBe('New history works');
    expect(native.showMessageBox).not.toHaveBeenCalled();
    native.windows[0].emit('ready-to-show');
    native.windows[0].emit('ready-to-show');
    expect(native.showMessageBox).toHaveBeenCalledExactlyOnceWith(native.windows[0], {
      type: 'warning',
      title: 'Penathon Bots',
      message: translate(language, 'notice.databaseRecovered').replace('{folder}', backupDirectory),
    });
  },
);

it('keeps a healthy database and persists active run cancellation before quitting', async () => {
  const path = join(directory, 'penathon.sqlite');
  const previous = new Repository(path);
  previous.start(testBot(directory), 'Keep history');
  previous.close();
  await start('en');
  native.windows[0].emit('ready-to-show');
  expect((await readdir(directory)).some((name) => name.startsWith('db-corrupt-'))).toBe(false);
  expect(native.showMessageBox).not.toHaveBeenCalled();
  const { chat, db } = native.services!;
  expect(db.list('helper')).toHaveLength(1);
  const run = await chat.send('chief', 'Cancel on quit');
  expect(chat.activity().running).toHaveLength(1);
  const stopRoutines = vi.spyOn(chat.routines, 'stop');
  emitApp('second-instance', {}, ['Penathon Bots.exe', '--quit']);
  await expect.poll(() => native.exited).toBe(true);
  expect(native.engineCancel).toHaveBeenCalledWith(run.conversationId);
  expect(native.engineClose).toHaveBeenCalledOnce();
  expect(native.telegramClose).toHaveBeenCalledOnce();
  expect(stopRoutines).toHaveBeenCalledOnce();
  expect(() => db.list('chief')).toThrow();
  const reopened = new Repository(path);
  try {
    expect(reopened.runInfo(run.runId).status).toBe('cancelled');
    expect(reopened.get(run.conversationId).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'run.done',
            cancelled: true,
          }),
        }),
      ]),
    );
  } finally {
    reopened.close();
  }
});
