import { app, Menu, nativeImage, Notification, Tray, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { channels, type AppActivity, type AppView } from '../shared/api';
import type { Settings, SettingsPatch } from '../shared/settings';
import type { EventEnvelope } from '../shared/events';
import type { RoutineRun } from '../shared/routines';
import type { RoomMessage } from '../shared/rooms';
import type { BotStore } from './bots/store';
import type { Repository } from './db';
import { translate } from '../shared/i18n';
import {
  NotificationBatcher,
  notificationDecision,
  type Notice,
  type NotificationEvent,
} from './notifications';

export function claimSingleInstance(show: () => void, argv = process.argv): boolean {
  const primary = app.requestSingleInstanceLock();
  if (!primary || argv.includes('--quit')) {
    app.exit(0);
    return false;
  }
  if (process.platform === 'win32') app.setAppUserModelId('co.penathon.bots');
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quit')) app.quit();
    else show();
  });
  return true;
}

export function handleAppQuit(cleanup: () => Promise<void>): void {
  let quitting = false;
  let cleanedUp = false;
  app.on('before-quit', (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void cleanup()
      .catch(() => console.warn('App shutdown failed'))
      .finally(() => {
        cleanedUp = true;
        app.quit();
      });
  });
}

export class Desktop {
  private tray: Tray;
  private view: AppView = {};
  private ready = false;
  private pendingTarget?: AppView;
  private quitting = false;
  private explainedBackground = false;
  private activity: AppActivity = { running: [], pendingApprovals: 0 };
  private notifications = new Set<Notification>();
  private batch: NotificationBatcher;
  private icon = join(app.getAppPath(), 'build/icon.png');
  constructor(
    private services: {
      window(): BrowserWindow | undefined;
      createWindow(): void;
      settings(): Settings;
      setSettings(patch: SettingsPatch): Promise<Settings>;
      emit(channel: string, data: unknown): void;
      bots(): BotStore;
      db: Repository;
    },
  ) {
    this.batch = new NotificationBatcher(
      (event) => this.decide(event),
      (notice) => this.notify(notice),
    );
    this.tray = new Tray(nativeImage.createFromPath(this.icon).resize({ width: 16, height: 16 }));
    this.tray.on('click', () => this.show());
    this.updateActivity(this.activity);
  }
  private decide(event: NotificationEvent): Notice | undefined {
    return notificationDecision(
      event,
      this.services.settings(),
      this.view,
      this.services.window()?.isFocused() ?? false,
    );
  }
  attachWindow(window: BrowserWindow): void {
    this.ready = false;
    this.view = {};
    window.on('close', (event) => {
      if (this.quitting) return;
      if (this.services.settings().runInBackground) {
        event.preventDefault();
        window.hide();
        if (!this.explainedBackground) {
          this.explainedBackground = true;
          if (this.services.settings().notifications.enabled)
            this.notify({
              title: 'Penathon Bots',
              body: 'Penathon Bots arka planda çalışıyor; tepsiden açabilirsin.',
              target: {},
            });
        }
      } else {
        event.preventDefault();
        app.quit();
      }
    });
    window.on('focus', () => window.flashFrame(false));
    window.on('page-title-updated', (event) => event.preventDefault());
    this.updateActivity(this.activity);
  }
  setView(view: AppView): void {
    this.view = view;
    this.ready = true;
    if (this.pendingTarget) {
      const target = this.pendingTarget;
      this.pendingTarget = undefined;
      this.services.emit(channels.appNavigate, target);
    }
  }
  show(target?: AppView): void {
    if (this.quitting) return;
    if (!this.services.window()) this.services.createWindow();
    const window = this.services.window();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (target) {
      if (this.ready) this.services.emit(channels.appNavigate, target);
      else this.pendingTarget = target;
    }
  }
  settingsChanged(): void {
    this.updateActivity(this.activity);
  }
  updateActivity(activity: AppActivity): void {
    if (this.quitting) return;
    this.activity = activity;
    const count = activity.running.length;
    const approvals = activity.pendingApprovals;
    const window = this.services.window();
    if (window && !window.isDestroyed()) {
      window.setTitle(
        'Penathon Bots' +
          (count ? ` — ${count} çalışıyor` : '') +
          (approvals ? ` · ${approvals} onay bekliyor` : ''),
      );
      if (process.platform === 'win32') window.setProgressBar(count ? 2 : -1);
    }
    this.services.emit(channels.appOnActivity, activity);
    this.tray.setToolTip(
      'Penathon Bots — ' +
        (count ? `${count} bot çalışıyor` : 'boşta') +
        (approvals ? ` / ${approvals} onay bekliyor` : ''),
    );
    const enabled = this.services.settings().notifications.enabled;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Aç', click: () => this.show() },
        { type: 'separator' },
        ...activity.running.map((run) => ({
          label: run.name,
          click: () => this.show({ botId: run.botId, conversationId: run.conversationId }),
        })),
        ...(count ? [{ type: 'separator' as const }] : []),
        {
          label: enabled ? 'Bildirimleri duraklat' : 'Bildirimleri aç',
          click: () => {
            void this.services.setSettings({ notifications: { enabled: !enabled } }).catch(() => {
              console.warn('Notification settings could not be saved');
            });
          },
        },
        { label: 'Çıkış', click: () => app.quit() },
      ]),
    );
  }
  private notify(notice: Notice): void {
    if (this.quitting || !Notification.isSupported()) return;
    try {
      const notification = new Notification({
        title: notice.title,
        body: notice.body,
        icon: this.icon,
      });
      this.notifications.add(notification);
      notification.on('click', () => this.show(notice.target));
      notification.on('close', () => this.notifications.delete(notification));
      notification.on('failed', () => this.notifications.delete(notification));
      notification.show();
    } catch {
      console.warn('Desktop notification could not be shown');
    }
  }
  private enqueue(event: NotificationEvent): void {
    if (this.quitting) return;
    if (
      event.type === 'approval.request' &&
      this.decide(event) &&
      !this.services.window()?.isFocused()
    )
      this.services.window()?.flashFrame(true);
    this.batch.add(event);
  }
  onChat(envelope: EventEnvelope): void {
    if (this.quitting) return;
    const event = envelope.event;
    if (event.type === 'approval.resolved') {
      this.batch.dismiss(envelope.runId);
      return;
    }
    if (!['run.done', 'run.error', 'approval.request'].includes(event.type)) return;
    const run = this.services.db.runInfo(envelope.runId);
    const bot = this.services.bots().get(run.botId);
    const target = run.roomId
      ? { roomId: run.roomId }
      : { botId: run.botId, conversationId: envelope.conversationId };
    if (event.type === 'approval.request') {
      this.enqueue({
        id: envelope.runId,
        type: event.type,
        botName: bot.name,
        target,
        text: event.title,
      });
    } else if (event.type === 'run.error' && !run.routineId) {
      this.enqueue({
        id: envelope.runId,
        type: event.type,
        botName: bot.name,
        target,
        text: this.errorText(event.message),
      });
    } else if (event.type === 'run.done' && !run.routineId && !run.roomId) {
      const events = this.services.db.get(envelope.conversationId).events;
      const last = events.findLast(
        (value) => value.runId === envelope.runId && value.event.type === 'message.done',
      )?.event;
      this.enqueue({
        id: envelope.runId,
        type: event.type,
        botName: bot.name,
        target,
        text: last?.type === 'message.done' ? last.text : '',
        cancelled: event.cancelled,
      });
    }
  }
  private errorText(text: string): string {
    return text.startsWith('errors.') ? translate(this.services.settings().language, text) : text;
  }
  onRoutine(run: RoutineRun): void {
    if (this.quitting) return;
    const bot = this.services.bots().get(run.botId);
    this.enqueue({
      id: run.id,
      type: 'routine.finished',
      botName: bot.name,
      name: bot.routines.find((routine) => routine.id === run.routineId)?.name ?? run.routineId,
      status: run.status,
      target: {
        botId: run.botId,
        ...(run.conversationId ? { conversationId: run.conversationId } : {}),
      },
      text: this.errorText(run.summary ?? ''),
    });
  }
  onRoom(message: RoomMessage): void {
    if (this.quitting || message.author.kind !== 'bot') return;
    this.enqueue({
      id: message.runId ?? message.id,
      type: 'room.message',
      author: message.author.kind,
      botName: this.services.bots().get(message.author.botId).name,
      target: { roomId: message.roomId },
      text: message.text,
    });
  }
  close(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.batch.close();
    this.tray.destroy();
    for (const notification of this.notifications) notification.close();
    this.notifications.clear();
  }
}
