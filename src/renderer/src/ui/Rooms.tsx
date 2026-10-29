import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bot } from '../../../shared/bots';
import type { EventEnvelope } from '../../../shared/events';
import type { Language } from '../../../shared/i18n';
import type { Room, RoomActivity, RoomMessage } from '../../../shared/rooms';
import { Avatar } from './Avatar';
import { ApprovalCard } from './Cards';
import { CloseIcon, SendIcon, SettingsIcon, StopIcon, TrashIcon } from './icons';
import { Markdown } from './Markdown';
import { approvalResolutions } from './state';
import type { T } from './strings';

/** Overlapping faces for a room row or header. */
export function AvatarStack({
  bots,
  size = 22,
  max = 3,
}: {
  bots: Bot[];
  size?: number;
  max?: number;
}) {
  return (
    <span className="avatar-stack" style={{ ['--s' as string]: `${size}px` }}>
      {bots.slice(0, max).map((b) => (
        <span key={b.id} className="stack-face">
          <Avatar avatar={b.avatar} size={size} />
        </span>
      ))}
      {bots.length > max && <span className="stack-more">+{bots.length - max}</span>}
    </span>
  );
}

/** Mention text the backend understands: plain for one-word names, quoted otherwise. */
export function mentionFor(bot: Bot) {
  return /\s/.test(bot.name) ? `@"${bot.name}"` : `@${bot.name}`;
}

export function RoomView({
  room,
  bots,
  streams,
  t,
  language,
  onEdit,
  onError,
}: {
  room: Room;
  bots: Bot[];
  streams: Record<string, EventEnvelope[]>;
  t: T;
  language: Language;
  onEdit(): void;
  onError(err: unknown): void;
}) {
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [activity, setActivity] = useState<RoomActivity>({ roomId: room.id, queue: [] });
  const [text, setText] = useState('');
  const [mention, setMention] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const members = room.members
    .map((id) => bots.find((b) => b.id === id))
    .filter((b): b is Bot => !!b);
  const byId = (id: string) => bots.find((b) => b.id === id);
  const lead = byId(room.lead);

  useEffect(() => {
    let live = true;
    void window.api.rooms
      .messages(room.id, 200)
      .then((m) => live && setMessages(m))
      .catch(onError);
    void window.api.rooms
      .activity(room.id)
      .then((a) => live && setActivity(a))
      .catch(() => undefined);
    const offMsg = window.api.rooms.onMessage((m) => {
      if (m.roomId !== room.id) return;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    });
    const offAct = window.api.rooms.onActivity((a) => a.roomId === room.id && setActivity(a));
    return () => {
      live = false;
      offMsg();
      offAct();
    };
  }, [room.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, activity.active]);

  // Approvals raised by members while answering in this room's hidden conversations.
  const pending = useMemo(() => {
    const all = Object.values(streams).flat();
    const resolved = approvalResolutions(all);
    const finished = new Set(
      all
        .filter((e) => e.event.type === 'run.done' || e.event.type === 'run.error')
        .map((e) => e.runId),
    );
    const roomConversations = new Set(
      [...messages.map((m) => m.conversationId), activity.activeConversationId].filter(Boolean),
    );
    return all.filter(
      (e) =>
        e.event.type === 'approval.request' &&
        !resolved.has(e.event.approvalId) &&
        !finished.has(e.runId) &&
        roomConversations.has(e.conversationId),
    );
  }, [streams, messages, activity.activeConversationId]);

  const busy = !!activity.active || activity.queue.length > 0;
  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    setMention(undefined);
    try {
      await window.api.rooms.send(room.id, value);
    } catch (err) {
      setText(value);
      onError(err);
    }
  };

  const onType = (value: string) => {
    setText(value);
    const caret = input.current?.selectionStart ?? value.length;
    const m = /(^|\s)@([^\s@"]*)$/.exec(value.slice(0, caret));
    setMention(m ? m[2] : undefined);
  };
  const suggestions =
    mention === undefined
      ? []
      : members.filter((b) =>
          b.name.toLocaleLowerCase(language).startsWith(mention.toLocaleLowerCase(language)),
        );
  const pick = (bot: Bot) => {
    const el = input.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([^\s@"]*)$/, `${mentionFor(bot)} `);
    const next = before + text.slice(caret);
    setText(next);
    setMention(undefined);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };

  return (
    <main className="convo room" aria-label={room.name}>
      <header className="convo-head drag">
        <button type="button" className="bot-id no-drag" onClick={onEdit} title={t('rooms.edit')}>
          <AvatarStack bots={members} size={26} />
          <span style={{ minWidth: 0 }}>
            <span className="title">{room.name}</span>
            <span className="sub">
              {busy && activity.active
                ? t('rooms.answering', { name: byId(activity.active)?.name ?? '' })
                : t('rooms.members', { n: members.length, lead: lead?.name ?? '' })}
            </span>
          </span>
        </button>
        <div className="head-actions no-drag">
          <button
            className="icon-btn"
            title={t('rooms.edit')}
            aria-label={t('rooms.edit')}
            onClick={onEdit}
          >
            <SettingsIcon size={17} />
          </button>
        </div>
      </header>

      <div ref={scroll} className="transcript scroll" aria-live="polite">
        {messages.length === 0 ? (
          <div className="hello">
            <AvatarStack bots={members} size={48} max={5} />
            <h2>{room.name}</h2>
            <p>{t('rooms.hello', { lead: lead?.name ?? '' })}</p>
          </div>
        ) : (
          <div className="transcript-inner">
            {messages.map((m) => {
              if (m.author.kind === 'user')
                return (
                  <pre key={m.id} className="msg-user">
                    {m.text}
                  </pre>
                );
              const bot = byId(m.author.botId);
              return (
                <div
                  key={m.id}
                  className="turn"
                  style={bot ? { ['--bot' as string]: bot.avatar.color } : undefined}
                >
                  {bot && <Avatar avatar={bot.avatar} size={28} />}
                  <div className="turn-body">
                    <div className="turn-name">
                      {bot?.name ?? m.author.botId}
                      <span className="meta"> · {time(m.createdAt)}</span>
                    </div>
                    <Markdown text={m.text} />
                  </div>
                </div>
              );
            })}
            {pending.map((e) =>
              e.event.type === 'approval.request' ? (
                <div key={`${e.runId}:${e.sequence}`} className="turn">
                  <span style={{ width: 28 }} />
                  <div className="turn-body">
                    <ApprovalCard event={e.event} t={t} />
                  </div>
                </div>
              ) : null,
            )}
            {activity.active && (
              <div className="typing-row">
                {byId(activity.active) && (
                  <Avatar avatar={byId(activity.active)!.avatar} size={22} state="thinking" />
                )}
                <span>{t('rooms.typing', { name: byId(activity.active)?.name ?? '' })}</span>
                {activity.queue.length > 0 && (
                  <span className="meta">
                    {t('rooms.queue', {
                      names: activity.queue.map((id) => byId(id)?.name ?? id).join(', '),
                    })}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="composer-wrap">
        {suggestions.length > 0 && (
          <div className="mention-pop" role="listbox" aria-label={t('rooms.mention')}>
            {suggestions.map((b) => (
              <button
                key={b.id}
                type="button"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(b);
                }}
              >
                <Avatar avatar={b.avatar} size={20} />
                <span>{b.name}</span>
                {b.id === room.lead && <span className="tag">{t('rooms.lead')}</span>}
              </button>
            ))}
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={input}
            rows={1}
            value={text}
            placeholder={t('rooms.placeholder', { lead: lead?.name ?? '' })}
            aria-label={t('chat.prompt')}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => {
              if (suggestions.length && (e.key === 'Tab' || e.key === 'Enter')) {
                e.preventDefault();
                pick(suggestions[0]);
                return;
              }
              if (e.key === 'Escape') setMention(undefined);
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-bar">
            <div className="member-chips">
              {members.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="member-chip"
                  title={t('rooms.call', { name: b.name })}
                  onClick={() => {
                    setText((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}${mentionFor(b)} `);
                    input.current?.focus();
                  }}
                >
                  <Avatar avatar={b.avatar} size={18} />
                  {b.name}
                </button>
              ))}
            </div>
            {busy ? (
              <button
                type="button"
                className="send stop"
                onClick={() => void window.api.rooms.cancel(room.id).catch(onError)}
                aria-label={t('chat.cancel')}
              >
                <StopIcon size={16} />
              </button>
            ) : (
              <button
                type="submit"
                className="send"
                disabled={!text.trim()}
                aria-label={t('chat.send')}
              >
                <SendIcon size={17} />
              </button>
            )}
          </div>
        </form>
        <p className="hint">{t('rooms.hint')}</p>
      </div>
    </main>
  );
}

export function RoomSheet({
  room,
  bots,
  t,
  onClose,
  onSaved,
  onDeleted,
  onError,
}: {
  room?: Room;
  bots: Bot[];
  t: T;
  onClose(): void;
  onSaved(room: Room): void;
  onDeleted(): void;
  onError(err: unknown): void;
}) {
  const chief = bots.find((b) => b.system);
  const [name, setName] = useState(room?.name ?? '');
  const [members, setMembers] = useState<string[]>(room?.members ?? (chief ? [chief.id] : []));
  const [lead, setLead] = useState(room?.lead ?? chief?.id ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const effectiveLead = members.includes(lead) ? lead : members[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (!name.trim() || !members.length) return;
    setSaving(true);
    try {
      const saved = room
        ? await window.api.rooms.update(room.id, {
            name: name.trim(),
            members,
            lead: effectiveLead,
          })
        : await window.api.rooms.create({ name: name.trim(), members, lead: effectiveLead });
      onSaved(saved);
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sheet room-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={room ? t('rooms.edit') : t('rooms.new')}
      >
        <div className="sheet-head">
          <h2>{room ? t('rooms.edit') : t('rooms.new')}</h2>
          <button
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            aria-label={t('settings.close')}
            onClick={onClose}
          >
            <CloseIcon size={17} />
          </button>
        </div>
        <div className="editor-body">
          <p className="editor-hint">{t('rooms.sheetHint')}</p>
          <label className="field">
            <span className="field-label">{t('rooms.name')}</span>
            <input
              value={name}
              maxLength={100}
              autoFocus
              placeholder={t('rooms.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="field">
            <span className="field-label">{t('rooms.pickMembers')}</span>
            <ul className="member-pick">
              {bots
                .filter((b) => !b.temporary)
                .map((b) => {
                  const on = members.includes(b.id);
                  return (
                    <li key={b.id} style={{ ['--bot' as string]: b.avatar.color }}>
                      <label className="member-pick-row">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            setMembers(
                              e.target.checked
                                ? [...members, b.id]
                                : members.filter((id) => id !== b.id),
                            )
                          }
                        />
                        <Avatar avatar={b.avatar} size={24} />
                        <span className="member-pick-name">
                          {b.name}
                          {b.role && <span className="meta">{b.role}</span>}
                        </span>
                      </label>
                      {on && (
                        <button
                          type="button"
                          className={`lead-btn${effectiveLead === b.id ? ' on' : ''}`}
                          aria-pressed={effectiveLead === b.id}
                          onClick={() => setLead(b.id)}
                          title={t('rooms.leadHint')}
                        >
                          {t('rooms.lead')}
                        </button>
                      )}
                    </li>
                  );
                })}
            </ul>
          </div>
        </div>
        <div className="editor-foot">
          {room && (
            <button
              type="button"
              className={`btn btn-quiet danger${confirmDelete ? ' armed' : ''}`}
              onBlur={() => setConfirmDelete(false)}
              onClick={async () => {
                if (!confirmDelete) return setConfirmDelete(true);
                try {
                  await window.api.rooms.delete(room.id);
                  onDeleted();
                } catch (err) {
                  onError(err);
                }
              }}
            >
              <TrashIcon size={15} />
              {confirmDelete ? t('rooms.deleteConfirm') : t('rooms.delete')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            {t('editor.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !name.trim() || !members.length}
            onClick={() => void save()}
          >
            {room ? t('editor.save') : t('rooms.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function time(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
