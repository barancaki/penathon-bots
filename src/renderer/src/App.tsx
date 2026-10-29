import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bot, BotDraft, EngineId } from '../../shared/bots';
import type { Conversation, ConversationDetail, EngineModel } from '../../shared/api';
import type { EventEnvelope } from '../../shared/events';
import type { Settings } from '../../shared/settings';
import { SettingsForm } from './SettingsForm';
import { Avatar } from './ui/Avatar';
import { BotEditor } from './ui/BotEditor';
import { CardActionsContext, type CardActions } from './ui/Cards';
import { ProfileSheet } from './ui/ProfileSheet';
import { ProjectsSheet } from './ui/ProjectsSheet';
import { ConnectionsSheet } from './ui/ConnectionsSheet';
import { RoomSheet, RoomView } from './ui/Rooms';
import type { Room } from '../../shared/rooms';
import type { Project } from '../../shared/projects';
import { Composer } from './ui/Composer';
import { History } from './ui/History';
import { CloseIcon, PanelIcon, PlusIcon } from './ui/icons';
import { engineLine, Rail } from './ui/Rail';
import {
  buildRoster,
  buildTurns,
  clearSentDraft,
  detailForSelection,
  lastStatus,
  mergeEvents,
  nowDoing,
  sendResultUpdates,
} from './ui/state';
import { makeT } from './ui/strings';
import { Transcript } from './ui/Transcript';
import { WorkPanel } from './ui/WorkPanel';

const PANEL_KEY = 'pb.panelOpen';
const LAST_CHATS_KEY = 'pb.lastChats';
const readLastChats = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(LAST_CHATS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};
const writeLastChat = (botId: string, conversationId: string) => {
  try {
    localStorage.setItem(
      LAST_CHATS_KEY,
      JSON.stringify({ ...readLastChats(), [botId]: conversationId }),
    );
  } catch {
    /* per-viewer convenience only */
  }
};
const readPanel = () => {
  try {
    return localStorage.getItem(PANEL_KEY) !== '0';
  } catch {
    return true;
  }
};

export function App() {
  const [settings, setSettings] = useState<Settings>();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState('chief');
  const [models, setModels] = useState<EngineModel[]>([]);
  const [history, setHistory] = useState<Conversation[]>([]);
  const [conversationId, updateConversationId] = useState('');
  // New objects invalidate pending replies even when the user leaves and returns to a chat.
  const selectionRef = useRef({ botId, conversationId });
  const [detail, setDetail] = useState<ConversationDetail>();
  const [streams, setStreams] = useState<Record<string, EventEnvelope[]>>({});
  const [convoBot, setConvoBot] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [panelOpen, setPanelOpen] = useState(readPanel);
  const [editor, setEditor] = useState<
    { mode: 'edit'; bot: Bot } | { mode: 'draft'; approvalId: string; bot: Bot }
  >();
  const [showProfile, setShowProfile] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomId, setRoomId] = useState<string>();
  const [roomSheet, setRoomSheet] = useState<{ room?: Room } | false>(false);
  const [projectsOpen, setProjectsOpen] = useState<string | 'new' | false>(false);
  // Runs started by other bots (sub-bots, delegation) arrive without a known owner.
  const askedOwner = useRef(new Set<string>());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const language = settings?.language ?? 'tr';
  const t = useMemo(() => makeT(language), [language]);
  const bot = bots.find((b) => b.id === botId) ?? bots[0];
  const prompt = drafts[botId] ?? '';
  const setPrompt = (text: string) => setDrafts((d) => ({ ...d, [botId]: text }));
  const setConversationId = (id: string) => {
    selectionRef.current = { ...selectionRef.current, conversationId: id };
    updateConversationId(id);
  };

  const fail = (err: unknown) =>
    setError(
      err instanceof Error
        ? (err.message.match(/errors\.[a-zA-Z]+/)?.[0] ?? 'errors.operationFailed')
        : 'errors.operationFailed',
    );

  useEffect(() => {
    document.documentElement.dataset.platform = navigator.userAgent.includes('Mac')
      ? 'darwin'
      : 'other';
    const loadBots = () =>
      window.api.bots
        .list()
        .then((list) => setBots(sortBots(list)))
        .catch(fail);
    void loadBots();
    void window.api.settings.get().then(setSettings).catch(fail);
    const offBots = window.api.bots.onChanged(() => void loadBots());
    const loadProjects = () => void window.api.projects.list().then(setProjects).catch(fail);
    loadProjects();
    const offProjects = window.api.projects.onChanged(loadProjects);
    const loadRooms = () => void window.api.rooms.list().then(setRooms).catch(fail);
    loadRooms();
    const offRooms = window.api.rooms.onChanged(loadRooms);
    const offEvents = window.api.chat.onEvent((event) => {
      const cid = event.conversationId;
      if (!askedOwner.current.has(cid)) {
        askedOwner.current.add(cid);
        void window.api.conversations
          .get(cid)
          .then((d) => setConvoBot((m) => (m[cid] ? m : { ...m, [cid]: d.conversation.botId })))
          .catch(() => undefined);
      }
      setStreams((prev) => ({
        ...prev,
        [event.conversationId]: [...(prev[event.conversationId] ?? []), event],
      }));
    });
    return () => {
      offBots();
      offProjects();
      offRooms();
      offEvents();
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.lang = settings.language;
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    void window.api.conversations
      .list(botId)
      .then((value) => !disposed && setHistory(value))
      .catch(fail);
    return () => {
      disposed = true;
    };
  }, [botId, conversationId]);

  const engineId = bot?.engine;
  useEffect(() => {
    if (!engineId) return;
    let disposed = false;
    void window.api.engines
      .models(engineId)
      .then((value) => !disposed && setModels(value))
      .catch(fail);
    return () => {
      disposed = true;
    };
  }, [engineId]);

  useEffect(() => {
    if (!conversationId) return;
    const selection = selectionRef.current;
    let disposed = false;
    void window.api.conversations
      .get(conversationId)
      .then((value) => {
        const currentDetail = detailForSelection(value, selection, selectionRef.current);
        if (!disposed && currentDetail) setDetail(currentDetail);
      })
      .catch(fail);
    return () => {
      disposed = true;
    };
  }, [conversationId]);

  const events = useMemo(
    () =>
      conversationId
        ? mergeEvents(
            detail?.conversation.id === conversationId ? detail.events : [],
            streams[conversationId] ?? [],
          )
        : [],
    [conversationId, detail, streams],
  );
  const messages = useMemo(
    () => (detail?.conversation.id === conversationId ? detail.messages : []),
    [detail, conversationId],
  );
  const turns = useMemo(() => buildTurns(messages, events), [messages, events]);
  const status = lastStatus(events);
  const busy = !!conversationId && !!status && !['done', 'error', 'idle'].includes(status);

  const roster = useMemo(() => buildRoster(streams, convoBot, t), [streams, convoBot, t]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, events.length]);

  const togglePanel = () =>
    setPanelOpen((open) => {
      try {
        localStorage.setItem(PANEL_KEY, open ? '0' : '1');
      } catch {
        /* per-viewer convenience only */
      }
      return !open;
    });

  /** Empty chat with the bot; only the "+" button and "design a new bot" start one. */
  const newChat = (id: string) => {
    setRoomId(undefined);
    selectionRef.current = { botId: id, conversationId: '' };
    setBotId(id);
    setConversationId('');
    setDetail(undefined);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /** Switching bots returns to where the user left that bot: its last open chat, else its newest. */
  const selectBot = (id: string) => {
    if (id === botId && !roomId) return;
    const remembered = readLastChats()[id];
    newChat(id);
    // Any later click (another bot, "+", a notification) replaces this object and wins.
    const selection = selectionRef.current;
    void window.api.conversations
      .list(id)
      .then((list) => {
        if (selectionRef.current !== selection) return;
        const target = list.find((c) => c.id === remembered) ?? list[0];
        if (target) openConversation(id, target.id);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (conversationId) writeLastChat(botId, conversationId);
  }, [botId, conversationId]);

  useEffect(() => {
    window.api.app.setView(
      roomId ? { roomId } : { botId, conversationId: conversationId || undefined },
    );
  }, [botId, conversationId, roomId]);

  const saveBot = async (patch: Partial<Bot>) => {
    if (!bot) return;
    try {
      const saved = await window.api.bots.save({ ...bot, ...patch });
      setBots((prev) => prev.map((b) => (b.id === saved.id ? saved : b)));
    } catch (err) {
      fail(err);
    }
  };

  const send = async (text = prompt) => {
    if (!bot || !text.trim() || sending) return;
    const sentSelection = selectionRef.current;
    setSending(true);
    setError('');
    try {
      const run = await window.api.chat.send(bot.id, text, conversationId || undefined);
      const updates = sendResultUpdates(
        bot.id,
        sentSelection,
        selectionRef.current,
        run.conversationId,
      );
      setConvoBot((m) => ({ ...m, ...updates.convoBot }));
      setDrafts((d) => clearSentDraft(d, bot.id, text));
      if (updates.selection) {
        const { conversationId } = updates.selection;
        setConversationId(conversationId);
        const selection = selectionRef.current;
        const value = await window.api.conversations.get(conversationId);
        const currentDetail = detailForSelection(value, selection, selectionRef.current);
        if (currentDetail) setDetail(currentDetail);
      }
    } catch (err) {
      fail(err);
    } finally {
      setSending(false);
    }
  };

  const deleteConversation = async (id: string) => {
    try {
      await window.api.conversations.delete(id);
      setHistory((list) => list.filter((c) => c.id !== id));
      setStreams((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)));
      if (selectionRef.current.conversationId === id) {
        setConversationId('');
        setDetail(undefined);
      }
    } catch (err) {
      fail(err);
    }
  };

  const openConversation = (targetBot: string, id: string) => {
    setRoomId(undefined);
    selectionRef.current = { botId: targetBot, conversationId: id };
    setBotId(targetBot);
    updateConversationId(id);
    setDetail(undefined);
  };

  // Notification clicks arrive through a listener registered once; keep it on the latest handlers.
  const openConversationRef = useRef(openConversation);
  const selectBotRef = useRef(selectBot);
  useEffect(() => {
    openConversationRef.current = openConversation;
    selectBotRef.current = selectBot;
  });

  useEffect(
    () =>
      window.api.app.onNavigate((target) => {
        if (target.roomId) return setRoomId(target.roomId);
        if (target.botId && target.conversationId)
          return openConversationRef.current(target.botId, target.conversationId);
        if (target.botId) selectBotRef.current(target.botId);
      }),
    [],
  );

  const cardActions: CardActions = {
    bots,
    projects,
    respond: async (approvalId, decision) => {
      try {
        await window.api.approvals.respond(approvalId, decision);
      } catch (err) {
        fail(err);
        throw err;
      }
    },
    editDraft: (approvalId, draft) => setEditor({ mode: 'draft', approvalId, bot: draft }),
    openBot: (id) => selectBot(id),
  };

  const approveEdited = async (approvalId: string, draft: BotDraft) => {
    try {
      await window.api.approvals.respond(approvalId, 'approved', draft);
      setEditor(undefined);
    } catch (err) {
      fail(err);
    }
  };

  if (!bot) return <div className="shell" />;
  const room = rooms.find((r) => r.id === roomId);
  const isChief = bot.system;
  const suggestions = isChief
    ? [t('hello.chief.s1'), t('hello.chief.s2'), t('hello.chief.s3')]
    : [];

  return (
    <div
      className={`shell${panelOpen ? ' has-panel' : ''}`}
      style={{ ['--bot' as string]: bot.avatar.color }}
    >
      <Rail
        bots={bots}
        activeId={room ? '' : bot.id}
        roster={roster}
        t={t}
        onSelect={selectBot}
        onNewBot={() => {
          const chief = bots.find((b) => b.system);
          if (!chief) return;
          newChat(chief.id);
          setDrafts((d) => ({ ...d, [chief.id]: t('hello.chief.s1') }));
        }}
        onSettings={() => setShowSettings(true)}
        onProfile={() => setShowProfile(true)}
        onProjects={() => setProjectsOpen(projects[0]?.id ?? 'new')}
        onConnections={() => setShowConnections(true)}
        profileName={settings?.profile?.name ?? ''}
        rooms={rooms}
        activeRoomId={roomId}
        onSelectRoom={(id) => setRoomId(id)}
        onNewRoom={() => setRoomSheet({})}
      />

      {room ? (
        <CardActionsContext.Provider value={cardActions}>
          <RoomView
            key={room.id}
            room={room}
            bots={bots}
            streams={streams}
            t={t}
            language={language}
            onEdit={() => setRoomSheet({ room })}
            onError={fail}
          />
        </CardActionsContext.Provider>
      ) : (
        <main className="convo" aria-label={t('chat.title')}>
          <header className="convo-head drag">
            <button
              type="button"
              className="bot-id no-drag"
              title={t('head.profile')}
              onClick={() => setEditor({ mode: 'edit', bot })}
            >
              <Avatar avatar={bot.avatar} size={30} state={status ?? 'idle'} />
              <span style={{ minWidth: 0 }}>
                <span className="title">{bot.name}</span>
                <span className="sub">
                  {nowDoing(events, t) ?? (bot.role || engineLine(bot, t))}
                </span>
              </span>
            </button>
            <div className="head-actions no-drag">
              <History
                items={history}
                currentId={conversationId}
                language={language}
                t={t}
                onOpen={(id) => {
                  if (id === conversationId) return;
                  setConversationId(id);
                  setDetail(undefined);
                }}
                onDelete={deleteConversation}
              />
              <button
                className="icon-btn"
                title={t('head.newChat')}
                aria-label={t('head.newChat')}
                onClick={() => newChat(bot.id)}
              >
                <PlusIcon size={17} />
              </button>
              <button
                className="icon-btn"
                title={t('head.panel')}
                aria-label={t('head.panel')}
                aria-pressed={panelOpen}
                onClick={togglePanel}
              >
                <PanelIcon size={17} />
              </button>
            </div>
          </header>

          <div ref={scrollRef} className="transcript scroll" aria-live="polite">
            {turns.length ? (
              <CardActionsContext.Provider value={cardActions}>
                <Transcript bot={bot} turns={turns} status={status} t={t} language={language} />
              </CardActionsContext.Provider>
            ) : (
              <div className="hello">
                <Avatar avatar={bot.avatar} size={72} state="idle" />
                <h2>
                  {isChief ? t('hello.chief.title') : t('hello.bot.title', { name: bot.name })}
                </h2>
                <p>
                  {isChief
                    ? t('hello.chief.body')
                    : t('hello.bot.body', {
                        engine: t(`engine.${bot.engine}`),
                        dir: lastSegment(bot.workdir),
                      })}
                </p>
                {suggestions.length > 0 && (
                  <div className="suggestions">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        className="suggestion"
                        onClick={() => {
                          setPrompt(s);
                          inputRef.current?.focus();
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <Composer
            bot={bot}
            value={prompt}
            models={models}
            busy={busy || sending}
            locked={busy || sending}
            t={t}
            inputRef={inputRef}
            onChange={setPrompt}
            onSend={() => void send()}
            onCancel={() => void window.api.chat.cancel(conversationId).catch(fail)}
            onEngine={(engine: EngineId) => void saveBot({ engine, model: 'default' })}
            onModel={(model) => void saveBot({ model })}
            onEffort={(effort) => void saveBot({ effort })}
          />
        </main>
      )}

      {panelOpen && !room && (
        <WorkPanel
          bot={bot}
          bots={bots}
          events={events}
          t={t}
          language={language}
          onAsk={(text) => void send(text)}
          onOpenConversation={openConversation}
          onError={fail}
        />
      )}

      {showSettings && settings && (
        <div
          className="scrim"
          onMouseDown={(e) => e.target === e.currentTarget && setShowSettings(false)}
        >
          <div className="sheet" role="dialog" aria-modal="true" aria-label={t('settings.title')}>
            <div className="sheet-head">
              <h2>{t('settings.title')}</h2>
              <button
                className="icon-btn"
                style={{ marginLeft: 'auto' }}
                aria-label={t('settings.close')}
                onClick={() => setShowSettings(false)}
              >
                <CloseIcon size={17} />
              </button>
            </div>
            <SettingsForm
              initial={settings}
              bots={bots}
              onSaved={(next) => {
                setSettings(next);
                setShowSettings(false);
              }}
              onClose={() => setShowSettings(false)}
              onError={fail}
            />
          </div>
        </div>
      )}

      {editor && (
        <BotEditor
          key={editor.mode === 'draft' ? editor.approvalId : editor.bot.id}
          bot={editor.bot}
          mode={editor.mode}
          bots={bots}
          t={t}
          onClose={() => setEditor(undefined)}
          onSaved={(saved) => {
            setBots((prev) => sortBots(prev.map((b) => (b.id === saved.id ? saved : b))));
            setEditor(undefined);
          }}
          onApprove={(draft) =>
            editor.mode === 'draft' && void approveEdited(editor.approvalId, draft)
          }
          onError={fail}
          onOpenProjects={() => setProjectsOpen('new')}
        />
      )}

      {projectsOpen && (
        <ProjectsSheet
          projects={projects}
          bots={bots}
          t={t}
          initialId={projectsOpen}
          onClose={() => setProjectsOpen(false)}
          onError={fail}
        />
      )}

      {roomSheet && (
        <RoomSheet
          room={roomSheet.room}
          bots={bots}
          t={t}
          onClose={() => setRoomSheet(false)}
          onSaved={(saved) => {
            setRooms((prev) =>
              prev.some((r) => r.id === saved.id)
                ? prev.map((r) => (r.id === saved.id ? saved : r))
                : [...prev, saved],
            );
            setRoomId(saved.id);
            setRoomSheet(false);
          }}
          onDeleted={() => {
            setRoomId(undefined);
            setRoomSheet(false);
          }}
          onError={fail}
        />
      )}

      {showConnections && (
        <ConnectionsSheet
          bots={bots}
          t={t}
          onClose={() => setShowConnections(false)}
          onError={fail}
        />
      )}

      {showProfile && settings && (
        <ProfileSheet
          profile={settings.profile}
          t={t}
          onClose={() => setShowProfile(false)}
          onSave={async (profile) => {
            try {
              setSettings(await window.api.settings.set({ profile }));
              setShowProfile(false);
            } catch (err) {
              fail(err);
            }
          }}
        />
      )}

      {error && (
        <div className="toast" role="alert">
          <span>{t(error)}</span>
          <button
            className="icon-btn"
            style={{ color: 'inherit' }}
            aria-label={t('settings.close')}
            onClick={() => setError('')}
          >
            <CloseIcon size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function sortBots(list: Bot[]) {
  return [...list].sort(
    (a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name),
  );
}

function lastSegment(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
