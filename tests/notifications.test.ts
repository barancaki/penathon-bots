import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NotificationBatcher,
  notificationDecision,
  notificationText,
  type NotificationEvent,
} from '../src/main/notifications';
import { settingsSchema } from '../src/shared/settings';

const settings = () =>
  settingsSchema.parse({ botsDir: 'bots', engines: { claude: {}, codex: {} } });
const done: NotificationEvent = {
  id: 'run',
  type: 'run.done',
  botName: 'Şef',
  target: { botId: 'chief', conversationId: 'chat' },
  text: '# **Hazır**\n[Dosya](https://example.test) `tamam`.',
};
afterEach(() => vi.useRealTimers());

it.each(['en', 'tr'] as const)(
  'uses %s for notification titles, fallback text and batched notices',
  (language) => {
    vi.useFakeTimers();
    const config = { ...settings(), language };
    const event = { ...done, botName: 'Writer', text: '' };
    expect(notificationDecision(event, config, {}, false)?.body).toBe(
      language === 'en' ? 'Work completed.' : 'İş tamamlandı.',
    );
    expect(notificationDecision({ ...event, type: 'run.error' }, config, {}, false)?.title).toBe(
      language === 'en' ? 'Writer stopped with an error' : 'Writer bir hatayla durdu',
    );
    const show = vi.fn();
    const batch = new NotificationBatcher(
      (event) => notificationDecision(event, config, {}, false),
      show,
      () => config.language,
    );
    batch.add({ ...event, type: 'approval.request' });
    batch.add({ ...event, id: 'another', type: 'approval.request' });
    vi.advanceTimersByTime(2000);
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: language === 'en' ? '2 awaiting approval' : '2 onay bekliyor',
      }),
    );
    batch.close();
  },
);

it('cleans markdown, collapses whitespace and limits previews without splitting emoji', () => {
  expect(notificationText(done.text)).toBe('Hazır Dosya tamam.');
  expect(notificationText('```ts\nconst x = 1;\n```\n> Sonuç\n- tamam')).toBe(
    'const x = 1; Sonuç tamam',
  );
  expect(Array.from(notificationText('😀'.repeat(150)))).toHaveLength(140);
});
it('suppresses only the focused conversation, not another conversation or a bot-only view', () => {
  const decide = (view: { botId?: string; conversationId?: string }, focused: boolean) =>
    notificationDecision(done, settings(), view, focused);
  expect(decide({ conversationId: 'chat' }, true)).toBeUndefined();
  expect(decide({ conversationId: 'chat' }, false)?.title).toBe('Şef');
  expect(decide({ conversationId: 'other' }, true)?.body).toBe('Hazır Dosya tamam.');
  expect(decide({ botId: 'chief' }, true)).toBeDefined();
});
it('honors the master switch, per-event switches, cancellation and routine statuses', () => {
  const cases: [NotificationEvent, string, string][] = [
    [done, 'done', 'Şef'],
    [{ ...done, type: 'approval.request' }, 'approval', 'Onay bekliyor: Şef'],
    [{ ...done, type: 'run.error' }, 'error', 'Şef bir hatayla durdu'],
    [{ ...done, type: 'routine.finished', name: 'Sabah', status: 'done' }, 'routine', '⏰ Sabah'],
    [{ ...done, type: 'room.message', author: 'bot', target: { roomId: 'room' } }, 'rooms', 'Şef'],
  ];
  for (const [event, option, title] of cases) {
    const config = settings();
    config.notifications.rooms = true;
    expect(notificationDecision(event, config, {}, false)?.title).toBe(title);
    const disabled = { ...config, notifications: { ...config.notifications, [option]: false } };
    expect(notificationDecision(event, disabled, {}, false)).toBeUndefined();
    config.notifications.enabled = false;
    expect(notificationDecision(event, config, {}, false)).toBeUndefined();
  }
  expect(notificationDecision({ ...done, cancelled: true }, settings(), {}, false)).toBeUndefined();
  for (const status of ['skipped', 'cancelled', 'running'] as const)
    expect(
      notificationDecision(
        { ...done, type: 'routine.finished', name: 'Sabah', status },
        settings(),
        {},
        false,
      ),
    ).toBeUndefined();
  expect(
    notificationDecision(
      { ...done, type: 'routine.finished', name: 'Sabah', status: 'error' },
      settings(),
      {},
      false,
    )?.title,
  ).toBe('⏰ Sabah');
});
it('notifies about bot room messages only while unfocused and routes room approvals to the room', () => {
  const config = settings();
  config.notifications.rooms = true;
  const event: NotificationEvent = {
    ...done,
    type: 'room.message',
    author: 'bot',
    target: { roomId: 'room' },
  };
  expect(notificationDecision(event, config, {}, true)).toBeUndefined();
  expect(notificationDecision(event, config, { roomId: 'room' }, false)?.target).toEqual({
    roomId: 'room',
  });
  expect(notificationDecision({ ...event, author: 'user' }, config, {}, false)).toBeUndefined();
  expect(
    notificationDecision(
      { ...done, type: 'approval.request', target: { roomId: 'room' } },
      config,
      { roomId: 'room' },
      true,
    ),
  ).toBeUndefined();
});

describe('notification batching', () => {
  it('combines a two-second burst, deduplicates runs and links to the latest conversation', () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const batch = new NotificationBatcher(
      (event) => notificationDecision(event, settings(), {}, false),
      show,
      () => settings().language,
    );
    batch.add(done);
    batch.add(done);
    vi.advanceTimersByTime(1500);
    batch.add({ ...done, id: 'two', botName: 'İçerik', target: { conversationId: 'two' } });
    batch.add({ ...done, id: 'three', botName: 'Lead', target: { conversationId: 'three' } });
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(show).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: '3 bot işini bitirdi',
        target: { conversationId: 'three' },
      }),
    );
    batch.add(done);
    vi.advanceTimersByTime(2000);
    expect(show).toHaveBeenCalledTimes(1);
    batch.close();
  });
  it('rechecks settings and focus before delivery, dismisses resolved approvals and cancels on shutdown', () => {
    vi.useFakeTimers();
    let config = settings();
    let focused = false;
    const show = vi.fn();
    const batch = new NotificationBatcher(
      (event) => notificationDecision(event, config, { conversationId: 'chat' }, focused),
      show,
      () => settings().language,
    );
    batch.add(done);
    focused = true;
    vi.advanceTimersByTime(2000);
    expect(show).not.toHaveBeenCalled();
    focused = false;
    batch.add(done);
    config.notifications.enabled = false;
    vi.advanceTimersByTime(2000);
    expect(show).not.toHaveBeenCalled();
    config = settings();
    batch.add({ ...done, type: 'approval.request' });
    batch.dismiss(done.id);
    vi.advanceTimersByTime(2000);
    expect(show).not.toHaveBeenCalled();
    batch.add(done);
    batch.close();
    vi.advanceTimersByTime(2000);
    expect(show).not.toHaveBeenCalled();
  });
  it('delivers once per run, including a completion after an already delivered approval', () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const batch = new NotificationBatcher(
      (event) => notificationDecision(event, settings(), {}, false),
      show,
      () => settings().language,
    );
    batch.add({ ...done, type: 'approval.request' });
    vi.advanceTimersByTime(2000);
    batch.add(done);
    vi.advanceTimersByTime(2000);
    expect(show).toHaveBeenCalledTimes(1);
    batch.close();
  });
});

it('combines mixed notifications and prioritizes an approval destination', () => {
  vi.useFakeTimers();
  const show = vi.fn();
  const batch = new NotificationBatcher(
    (event) => notificationDecision(event, settings(), {}, false),
    show,
    () => settings().language,
  );
  batch.add({
    ...done,
    id: 'approval',
    type: 'approval.request',
    target: { conversationId: 'needs-approval' },
  });
  batch.add(done);
  vi.advanceTimersByTime(2000);
  expect(show).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      title: 'Penathon Bots — 2 bildirim',
      target: { conversationId: 'needs-approval' },
    }),
  );
  batch.close();
});
