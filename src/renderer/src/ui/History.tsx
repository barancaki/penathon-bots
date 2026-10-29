import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../../../shared/api';
import type { Language } from '../../../shared/i18n';
import { ChatIcon, TrashIcon } from './icons';
import type { T } from './strings';

/** Earlier chats for the selected bot, with two-step delete. */
export function History({
  items,
  currentId,
  language,
  t,
  onOpen,
  onDelete,
}: {
  items: Conversation[];
  currentId: string;
  language: Language;
  t: T;
  onOpen(id: string): void;
  onDelete(id: string): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState('');
  const [deleting, setDeleting] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!items.length) return null;
  const when = new Intl.DateTimeFormat(language, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="menu" ref={root}>
      <button
        type="button"
        className="icon-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('head.history')}
        aria-label={t('head.history')}
        onClick={() => {
          setConfirming('');
          setOpen((v) => !v);
        }}
      >
        <ChatIcon size={17} />
      </button>
      {open && (
        <div className="menu-pop down history-pop" role="dialog" aria-label={t('head.history')}>
          <div className="menu-title">{t('head.history')}</div>
          <ul className="history-list">
            {items.map((item) => (
              <li key={item.id} aria-current={item.id === currentId || undefined}>
                <button
                  type="button"
                  className="history-open"
                  onClick={() => {
                    onOpen(item.id);
                    setOpen(false);
                  }}
                >
                  <span className="history-title">{item.title}</span>
                  <span className="menu-hint">{when.format(new Date(item.createdAt))}</span>
                </button>
                {confirming === item.id ? (
                  <button
                    type="button"
                    className="history-confirm"
                    disabled={deleting === item.id}
                    onClick={async () => {
                      setDeleting(item.id);
                      try {
                        await onDelete(item.id);
                      } finally {
                        setDeleting('');
                        setConfirming('');
                      }
                    }}
                  >
                    {t('history.confirm')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="history-delete"
                    title={t('history.delete')}
                    aria-label={`${t('history.delete')}: ${item.title}`}
                    onClick={() => setConfirming(item.id)}
                  >
                    <TrashIcon size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
