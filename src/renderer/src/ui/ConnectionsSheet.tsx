import { useEffect, useState } from 'react';
import type { ConnectionInfo } from '../../../shared/api';
import type { Bot } from '../../../shared/bots';
import { Avatar } from './Avatar';
import { connectionLabel } from './BotEditor';
import { ChevronIcon, CloseIcon, PlugIcon, SpinnerIcon } from './icons';
import { AvatarStack } from './Rooms';
import type { T } from './strings';

const hasAccess = (bot: Bot, name: string) =>
  bot.connections.includes('*') || bot.connections.includes(name);

/**
 * Every connector the Claude engine can see (claude.ai account connectors,
 * the user's own MCP servers) and which bots may use each one. Access is
 * granted per bot; this sheet is the overview and a quick way to change it.
 */
export function ConnectionsSheet({
  bots,
  t,
  onClose,
  onError,
}: {
  bots: Bot[];
  t: T;
  onClose(): void;
  onError(err: unknown): void;
}) {
  const [items, setItems] = useState<ConnectionInfo[]>();
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<string>();
  const claudeBots = bots.filter((b) => b.engine === 'claude' && !b.temporary);
  const codexBots = bots.filter((b) => b.engine === 'codex' && !b.temporary);

  const load = async (refresh: boolean) => {
    setRefreshing(true);
    try {
      setItems((await window.api.connections.list(refresh)).filter((c) => c.source !== 'app'));
    } catch (err) {
      setItems([]);
      onError(err);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void window.api.connections
      .list(false)
      .then((list) => setItems(list.filter((c) => c.source !== 'app')))
      .catch(() => setItems([]));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (bot: Bot, name: string, on: boolean) => {
    const all = items?.map((c) => c.name) ?? [];
    // Turning one off from "all" keeps every other connector explicitly.
    const base = bot.connections.includes('*') ? all : bot.connections;
    const next = on ? [...new Set([...base, name])] : base.filter((c) => c !== name);
    try {
      await window.api.bots.update(bot.id, { connections: next });
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sheet connections-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('connections.title')}
      >
        <div className="editor-head">
          <span className="profile-mark">
            <PlugIcon size={18} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2>{t('connections.title')}</h2>
            <div className="sub">{t('connections.hint')}</div>
          </div>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            {refreshing && <SpinnerIcon size={14} />}
            {t('connections.refresh')}
          </button>
          <button className="icon-btn" aria-label={t('settings.close')} onClick={onClose}>
            <CloseIcon size={17} />
          </button>
        </div>

        <div className="editor-body scroll">
          {!items && <p className="meta">{t('editor.loading')}</p>}
          {items?.length === 0 && <p className="editor-hint">{t('editor.connectionsEmpty')}</p>}
          <ul className="conn-overview">
            {items?.map((c) => {
              const users = claudeBots.filter((b) => hasAccess(b, c.name));
              const expanded = open === c.name;
              return (
                <li key={c.name} className={expanded ? 'open' : undefined}>
                  <button
                    type="button"
                    className="conn-head"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? undefined : c.name)}
                  >
                    <span className="conn-mark" aria-hidden="true">
                      {connectionLabel(c.name).slice(0, 1).toUpperCase()}
                    </span>
                    <span className="conn-text">
                      <span className="conn-title">{connectionLabel(c.name)}</span>
                      <span className="meta">
                        {t(`connections.source.${c.source}`)}
                        {c.toolCount !== undefined &&
                          ` · ${t('connections.tools', { n: c.toolCount })}`}
                      </span>
                    </span>
                    <span className={`conn-status s-${c.status}`}>{t(`conn.${c.status}`)}</span>
                    {users.length > 0 ? (
                      <AvatarStack bots={users} size={20} />
                    ) : (
                      <span className="meta">{t('connections.noBots')}</span>
                    )}
                    <ChevronIcon size={13} className="chev" />
                  </button>
                  {expanded && (
                    <div className="conn-bots">
                      {claudeBots.map((b) => (
                        <label key={b.id} className="conn-bot">
                          <input
                            type="checkbox"
                            checked={hasAccess(b, c.name)}
                            onChange={(e) => void toggle(b, c.name, e.target.checked)}
                          />
                          <Avatar avatar={b.avatar} size={22} />
                          <span>{b.name}</span>
                          {b.connections.includes('*') && (
                            <span className="meta">{t('connections.viaAll')}</span>
                          )}
                        </label>
                      ))}
                      {codexBots.length > 0 && (
                        <p className="meta">
                          {t('connections.codexNote', {
                            names: codexBots.map((b) => b.name).join(', '),
                          })}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="conn-help">
            <div className="field-label">{t('connections.addTitle')}</div>
            <p className="editor-hint">{t('connections.addClaudeAi')}</p>
            <p className="editor-hint">
              {t('connections.addMcp')} <code className="mono">claude mcp add</code>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
