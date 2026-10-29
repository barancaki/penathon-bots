import { app, BrowserWindow, dialog, nativeTheme, safeStorage } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { SettingsStore } from './settings';
import { ProjectStore } from './projects';
import type { Repository } from './db';
import { openRepository } from './openRepository';
import { BotStore, chiefBot } from './bots/store';
import { ClaudeEngine } from './engines/claude';
import { CodexEngine } from './engines/codex';
import { ChatService } from './chat';
import { TelegramBridge } from './telegram';
import { registerIpc } from './ipc';
import { channels } from '../shared/api';
import type { EngineId } from '../shared/bots';
import type { SettingsPatch } from '../shared/settings';
import { translate } from '../shared/i18n';
import { claimSingleInstance, Desktop, handleAppQuit } from './desktop';

const here = fileURLToPath(new URL('.', import.meta.url));
let window: BrowserWindow | undefined;
let bots: BotStore;
let db: Repository;
let chat: ChatService;
let telegram: TelegramBridge;
let closing = false;
let starting: Promise<void> | undefined;
let desktop: Desktop | undefined;
const emit = (channel: string, data?: unknown) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
};
// Window controls sit over the app's own header; their colours follow the theme.
function titleBarOverlay(dark: boolean) {
  return { color: '#00000000', symbolColor: dark ? '#c4c8cf' : '#3d424b', height: 56 };
}
nativeTheme.on('updated', () => {
  if (window && !window.isDestroyed() && process.platform !== 'darwin')
    window.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors));
});
function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors;
  window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    title: 'Penathon Bots',
    icon: join(app.getAppPath(), 'build/icon.png'),
    backgroundColor: dark ? '#17181b' : '#f6f7f9',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 14 } }
      : { titleBarOverlay: titleBarOverlay(dark) }),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  desktop?.attachWindow(window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => {
    window = undefined;
  });
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(here, '../renderer/index.html'));
}
async function start(): Promise<void> {
  if (closing) return;
  const userData = app.getPath('userData');
  const settings = new SettingsStore(userData, safeStorage);
  await settings.init();
  if (closing) return;
  const workdir = join(userData, 'workspace');
  await mkdir(workdir, { recursive: true });
  const secrets = () => settings.redactionSecrets();
  const createBots = async (dir: string, language: 'tr' | 'en') => {
    const store = new BotStore(
      dir,
      chiefBot(workdir, language),
      () => settings.get().knowledgeDir,
      secrets,
      () => settings.get().projects,
    );
    await store.init();
    store.on('changed', () => {
      emit(channels.botsChanged);
      if (chat) {
        chat.routines.refresh();
        desktop?.updateActivity(chat.activity());
        for (const bot of bots.list()) emit(channels.routinesChanged, bot.id);
      }
    });
    return store;
  };
  bots = await createBots(settings.get().botsDir, settings.get().language);
  if (closing) return;
  const opened = await openRepository(userData);
  db = opened.db;
  if (closing) return;
  const context = (engine: EngineId) => ({
    auth: async () => ({
      mode: settings.get().engines[engine].authMode,
      apiKey:
        settings.get().engines[engine].authMode === 'api-key'
          ? await settings.apiKey(engine)
          : undefined,
    }),
    knowledgeDir: () => settings.get().knowledgeDir,
    language: () => settings.get().language,
    profile: () => settings.get().profile,
    projects: () => settings.get().projects,
    getBot: (id: string) => bots.get(id),
    secrets,
    team: () => bots.list(),
    workdir: () => bots.get('chief').workdir,
  });
  const engines = {
    claude: new ClaudeEngine(context('claude')),
    codex: new CodexEngine(context('codex')),
  };
  void engines.claude.connections();
  const projects = new ProjectStore(settings, () => bots);
  projects.on('changed', () => emit(channels.projectsChanged));
  chat = new ChatService(
    () => bots,
    db,
    engines,
    secrets,
    (event) => {
      emit(channels.chatEvent, event);
      telegram?.onEvent(event);
      desktop?.onChat(event);
    },
    projects,
    () => settings.get().language,
  );
  telegram = new TelegramBridge(
    settings,
    () => bots,
    db,
    chat,
    (status) => emit(channels.telegramOnStatus, status),
  );
  await telegram.init();
  if (closing) return;
  db.on('reportsChanged', () => emit(channels.reportsChanged));
  chat.rooms.on('changed', () => emit(channels.roomsChanged));
  chat.rooms.on('message', (message) => {
    emit(channels.roomsMessage, message);
    desktop?.onRoom(message);
  });
  db.on('routineFinished', (run) => desktop?.onRoutine(run));
  chat.on('activity', (activity) => desktop?.updateActivity(activity));
  chat.rooms.on('activity', (activity) => emit(channels.roomsOnActivity, activity));
  db.on('routinesChanged', (botId: string) => emit(channels.routinesChanged, botId));
  chat.routines.on('changed', (botId: string) => emit(channels.routinesChanged, botId));
  let settingsQueue = Promise.resolve();
  const setSettings = (patch: SettingsPatch) => {
    const task = settingsQueue.then(async () => {
      if (
        patch.botsDir &&
        patch.botsDir !== settings.get().botsDir &&
        bots.list().some((bot) => chat.isBotActive(bot.id))
      )
        throw new Error('errors.botBusy');
      const replacement =
        patch.botsDir && patch.botsDir !== settings.get().botsDir
          ? await createBots(patch.botsDir, patch.language ?? settings.get().language)
          : undefined;
      try {
        const previousKnowledgeDir = settings.get().knowledgeDir;
        const saved = await settings.set(patch);
        const target = replacement ?? bots;
        target.setLanguage(saved.language);
        if (saved.knowledgeDir !== previousKnowledgeDir) await target.syncVaultRoutine();
        if (replacement) {
          const previous = bots;
          bots = replacement;
          await previous.close();
          emit(channels.botsChanged);
        }
        chat.routines.refresh();
        desktop?.settingsChanged();
        return saved;
      } catch (error) {
        await replacement?.close();
        throw error;
      }
    });
    settingsQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
  desktop = new Desktop({
    window: () => window,
    createWindow,
    settings: () => settings.get(),
    setSettings,
    emit,
    bots: () => bots,
    db,
  });
  registerIpc({
    app: { setView: (view) => desktop!.setView(view), quit: () => app.quit() },
    window: () => window,
    bots: () => bots,
    db,
    chat,
    engines,
    settings,
    projects,
    setSettings,
    telegram,
  });
  createWindow();
  const { backupDirectory } = opened;
  if (backupDirectory) {
    const message = translate(settings.get().language, 'notice.databaseRecovered').replace(
      '{folder}',
      () => backupDirectory,
    );
    window!.once('ready-to-show', () => {
      if (!closing && window && !window.isDestroyed())
        void dialog.showMessageBox(window, { type: 'warning', title: 'Penathon Bots', message });
    });
  }
  chat.routines.start();
  app.on('activate', () => {
    desktop?.show();
  });
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
handleAppQuit(async () => {
  closing = true;
  desktop?.close();
  await starting?.catch(() => {});
  await Promise.allSettled([telegram?.close(), chat?.close()]);
  try {
    await bots?.close();
  } finally {
    db?.close();
  }
});
if (claimSingleInstance(() => desktop?.show()))
  void app
    .whenReady()
    .then(() => (starting = start()))
    .catch(async (err: unknown) => {
      // Keep the cause: a generic dialog alone leaves nothing to debug from.
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(detail);
      await writeFile(join(app.getPath('userData'), 'startup-error.log'), detail).catch(() => {});
      dialog.showErrorBox(
        'Penathon Bots',
        `${translate('en', 'errors.startup')}\n\n${detail.split('\n')[0]}`,
      );
      app.exit(1);
    });
