import { useState, type ReactElement } from 'react';
import type { Bot } from '../../../shared/bots';
import { Avatar } from './Avatar';
import type { Room } from '../../../shared/rooms';
import { AvatarStack } from './Rooms';
import { FolderIcon, PlugIcon, PlusIcon, SearchIcon, SettingsIcon, UserIcon } from './icons';
import type { BotStatus } from './state';
import type { T } from './strings';

export type RosterEntry = { status?: BotStatus; live?: string };

export function Rail({
  bots,
  activeId,
  roster,
  t,
  onSelect,
  onNewBot,
  onSettings,
  onProfile,
  onProjects,
  onConnections,
  profileName,
  rooms,
  activeRoomId,
  onSelectRoom,
  onNewRoom,
}: {
  bots: Bot[];
  activeId: string;
  roster: Record<string, RosterEntry>;
  t: T;
  onSelect(id: string): void;
  onNewBot(): void;
  onSettings(): void;
  onProfile(): void;
  onProjects(): void;
  onConnections(): void;
  rooms: Room[];
  activeRoomId?: string;
  onSelectRoom(id: string): void;
  onNewRoom(): void;
  profileName: string;
}) {
  const [query, setQuery] = useState('');
  const match = (bot: Bot) =>
    bot.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const searching = !!query.trim();
  const visible = bots.filter(match);
  const ids = new Set(bots.map((b) => b.id));
  const children = (id: string) => bots.filter((b) => b.parent === id && !b.system);
  const chief = bots.filter((b) => b.system);
  // Bots without a living parent are the team's top level; sub-bots nest under their parent.
  // Chief's permanent bots form the team; its temporary helpers nest under it.
  const team = bots.filter(
    (b) => !b.system && (!b.parent || !ids.has(b.parent) || (b.parent === 'chief' && !b.temporary)),
  );
  const tree = (bot: Bot, depth: number, seen = new Set<string>()): ReactElement[] => {
    if (seen.has(bot.id)) return [];
    seen.add(bot.id);
    const kids = children(bot.id).filter((c) => !team.includes(c));
    return [row(bot, depth), ...kids.flatMap((c) => tree(c, depth + 1, seen))];
  };

  const row = (bot: Bot, depth = 0) => {
    const entry = roster[bot.id] ?? {};
    const secondary = entry.live ?? (bot.role || engineLine(bot, t));
    return (
      <button
        key={bot.id}
        className={`bot-row no-drag${depth ? ' nested' : ''}`}
        style={{
          ['--row-color' as string]: bot.avatar.color,
          ['--depth' as string]: depth,
        }}
        aria-current={bot.id === activeId}
        onClick={() => onSelect(bot.id)}
        title={entry.live}
      >
        <Avatar avatar={bot.avatar} size={depth ? 28 : 36} state={entry.status ?? 'idle'} />
        <span style={{ minWidth: 0 }}>
          <span className="name">
            <span className="name-text">{bot.name}</span>
            {bot.temporary && <span className="tag">{t('shell.temporaryTag')}</span>}
          </span>
          <span className={`line${entry.live ? ' live' : ''}`} style={{ display: 'block' }}>
            {secondary}
          </span>
        </span>
      </button>
    );
  };

  return (
    <aside className="rail" aria-label={t('bots.title')}>
      <div className="rail-top drag">
        <span className="wordmark">
          Penathon <span>Bots</span>
        </span>
      </div>
      <label className="search no-drag">
        <SearchIcon size={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('shell.search')}
          aria-label={t('shell.search')}
        />
      </label>
      <nav className="scroll" style={{ flex: 1, minHeight: 0, paddingBottom: 8 }}>
        {searching ? (
          visible.map((b) => row(b))
        ) : (
          <>
            {chief.flatMap((b) => tree(b, 0))}
            <div className="group-title">
              <span>{t('shell.team')}</span>
              <button
                onClick={onNewBot}
                title={t('shell.newBotHint')}
                aria-label={t('shell.newBot')}
              >
                <PlusIcon size={15} />
              </button>
            </div>
            {team.flatMap((b) => tree(b, 0))}
            {!team.length && <p className="rail-empty">{t('shell.teamEmpty')}</p>}
            <div className="group-title">
              <span>{t('rooms.title')}</span>
              <button onClick={onNewRoom} title={t('rooms.new')} aria-label={t('rooms.new')}>
                <PlusIcon size={15} />
              </button>
            </div>
            {rooms.map((room) => (
              <button
                key={room.id}
                className="bot-row room-row no-drag"
                aria-current={room.id === activeRoomId}
                onClick={() => onSelectRoom(room.id)}
              >
                <AvatarStack
                  bots={room.members
                    .map((id) => bots.find((b) => b.id === id))
                    .filter((b): b is Bot => !!b)}
                  size={20}
                />
                <span style={{ minWidth: 0 }}>
                  <span className="name">
                    <span className="name-text">{room.name}</span>
                  </span>
                  <span className="line">{t('rooms.count', { n: room.members.length })}</span>
                </span>
              </button>
            ))}
            {!rooms.length && <p className="rail-empty">{t('rooms.empty')}</p>}
          </>
        )}
        {query && !visible.length && (
          <p className="meta" style={{ padding: '12px 16px' }}>
            {t('shell.noMatch')}
          </p>
        )}
      </nav>
      <div className="rail-foot">
        <button className="foot-profile" onClick={onProfile} title={t('profile.title')}>
          <UserIcon size={16} />
          <span className="profile-name">{profileName || t('profile.title')}</span>
        </button>
        <button
          className="foot-icon"
          onClick={onProjects}
          title={t('projects.title')}
          aria-label={t('projects.title')}
        >
          <FolderIcon size={16} />
        </button>
        <button
          className="foot-icon"
          onClick={onConnections}
          title={t('connections.title')}
          aria-label={t('connections.title')}
        >
          <PlugIcon size={16} />
        </button>
        <button
          className="foot-icon"
          onClick={onSettings}
          title={t('shell.settings')}
          aria-label={t('shell.settings')}
        >
          <SettingsIcon size={16} />
        </button>
      </div>
    </aside>
  );
}

export function engineLine(bot: Bot, t: T) {
  const model = bot.model && bot.model !== 'default' ? bot.model : t('composer.defaultModel');
  return `${t(`engine.${bot.engine}`)}, ${model}`;
}
