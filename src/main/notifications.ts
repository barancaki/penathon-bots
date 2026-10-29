import type { AppView } from '../shared/api';
import type { Settings } from '../shared/settings';
import type { RoutineRun } from '../shared/routines';

export type NotificationEvent = {
  id: string;
  botName: string;
  target: AppView;
  text: string;
} & (
  | { type: 'run.done'; cancelled?: boolean }
  | { type: 'run.error' }
  | { type: 'approval.request' }
  | { type: 'routine.finished'; name: string; status: RoutineRun['status'] }
  | { type: 'room.message'; author: 'bot' | 'user' }
);
export type Notice = { title: string; body: string; target: AppView };

export function notificationText(text: string): string {
  return Array.from(
    text
      .replace(/^\s*```[^\n]*$/gm, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/^\s{0,3}(?:#{1,6}\s|>\s?|[-+*]\s|\d+\.\s)/gm, '')
      .replace(/[*_~`]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, 140)
    .join('');
}

export function notificationDecision(
  event: NotificationEvent,
  settings: Pick<Settings, 'notifications'>,
  view: AppView,
  focused: boolean,
): Notice | undefined {
  const options = settings.notifications;
  const sameView = event.target.roomId
    ? event.target.roomId === view.roomId
    : !!event.target.conversationId && event.target.conversationId === view.conversationId;
  if (!options.enabled || (focused && sameView)) return;
  let title: string;
  switch (event.type) {
    case 'run.done':
      if (!options.done || event.cancelled) return;
      title = event.botName;
      break;
    case 'approval.request':
      if (!options.approval) return;
      title = `Onay bekliyor: ${event.botName}`;
      break;
    case 'run.error':
      if (!options.error) return;
      title = `${event.botName} bir hatayla durdu`;
      break;
    case 'routine.finished':
      if (!options.routine || !['done', 'error'].includes(event.status)) return;
      title = `⏰ ${event.name}`;
      break;
    case 'room.message':
      if (!options.rooms || focused || event.author !== 'bot') return;
      title = event.botName;
      break;
  }
  return { title, body: notificationText(event.text) || 'İş tamamlandı.', target: event.target };
}

/** A bounded two-second window avoids starving notifications during continuous traffic. */
export class NotificationBatcher {
  private pending = new Map<string, NotificationEvent>();
  private delivered = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private decide: (event: NotificationEvent) => Notice | undefined,
    private show: (notice: Notice) => void,
  ) {}
  add(event: NotificationEvent): void {
    if (this.delivered.has(event.id) || !this.decide(event)) return;
    this.pending.set(event.id, event);
    this.timer ??= setTimeout(() => this.flush(), 2000);
  }
  dismiss(id: string): void {
    this.pending.delete(id);
  }
  private flush(): void {
    this.timer = undefined;
    const notices: { event: NotificationEvent; notice: Notice }[] = [];
    for (const event of this.pending.values()) {
      const notice = this.decide(event);
      if (notice) {
        notices.push({ event, notice });
        this.delivered.add(event.id);
      }
    }
    this.pending.clear();
    if (!notices.length) return;
    if (notices.length === 1) {
      this.show(notices[0].notice);
      return;
    }
    const count = notices.length;
    const type = notices[0].event.type;
    const sameType = notices.every(({ event }) => event.type === type);
    const title = !sameType
      ? `Penathon Bots — ${count} bildirim`
      : type === 'run.done'
        ? `${count} bot işini bitirdi`
        : type === 'approval.request'
          ? `${count} onay bekliyor`
          : type === 'run.error'
            ? `${count} bot bir hatayla durdu`
            : type === 'routine.finished'
              ? `⏰ ${count} rutin tamamlandı`
              : `${count} yeni oda mesajı`;
    const target =
      notices.findLast(({ event }) => event.type === 'approval.request')?.notice.target ??
      notices.at(-1)!.notice.target;
    this.show({
      title,
      body: notices
        .map(({ notice }) => `${notice.title}: ${notice.body}`)
        .join('\n')
        .slice(0, 500),
      target,
    });
  }
  close(): void {
    clearTimeout(this.timer);
    this.pending.clear();
    this.delivered.clear();
  }
}
