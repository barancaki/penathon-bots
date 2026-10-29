import type { Bot, BotDraft, BotPatch, EngineId } from './bots';
import type { EventEnvelope } from './events';
import type { Settings, SettingsPatch } from './settings';
import type { Project, ProjectDraft } from './projects';
import type { RoutineDraft, RoutineRun, RoutineState, WorkReport } from './routines';
import type { Room, RoomActivity, RoomMessage } from './rooms';
import type { TelegramStatus } from './telegram';
import type { TelegramOptions } from './settings';

export type Conversation = { id: string; botId: string; title: string; createdAt: string };
export type Message = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
};
export type ConversationDetail = {
  conversation: Conversation;
  messages: Message[];
  events: EventEnvelope[];
};
export type EngineModel = { id: string; label: string };
export type AuthStatus = {
  mode: 'local-cli' | 'api-key';
  state: 'configured' | 'missing' | 'unverified';
  messageKey: string;
};
export type ConnectionInfo = {
  /** MCP server name as the engine reports it, e.g. `claude.ai Gmail`, `penathon`. */
  name: string;
  status: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'unknown';
  /** Where the engine found it: claude.ai account, user/project config, Codex config, or this app. */
  source: 'claudeai' | 'user' | 'project' | 'codex' | 'app' | 'other';
  toolCount?: number;
};
export type ApprovalDecision = 'approved' | 'rejected';
export type AppView = { botId?: string; conversationId?: string; roomId?: string };
export type AppActivity = {
  running: { botId: string; name: string; conversationId: string }[];
  pendingApprovals: number;
};
export interface Api {
  app: {
    /** Renderer tells main what is on screen, so main doesn't notify about it while focused. */
    setView(view: AppView): void;
    /** Main asks the renderer to open something (notification or tray click). */
    onNavigate(listener: (target: AppView) => void): () => void;
    /** Bots running right now, for the tray and the window title. */
    activity(): Promise<AppActivity>;
    onActivity(listener: (a: AppActivity) => void): () => void;
    quit(): Promise<void>;
  };
  telegram: {
    status(): Promise<TelegramStatus>;
    setToken(token: string | null): Promise<TelegramStatus>;
    startPairing(): Promise<TelegramStatus>;
    unpair(): Promise<TelegramStatus>;
    setOptions(options: TelegramOptions): Promise<TelegramStatus>;
    onStatus(listener: (status: TelegramStatus) => void): () => void;
  };
  rooms: {
    activity(id: string): Promise<RoomActivity>;
    onActivity(listener: (activity: RoomActivity) => void): () => void;
    list(): Promise<Room[]>;
    create(input: { name: string; members: string[]; lead?: string }): Promise<Room>;
    update(id: string, patch: { name?: string; members?: string[]; lead?: string }): Promise<Room>;
    delete(id: string): Promise<void>;
    messages(id: string, limit?: number): Promise<RoomMessage[]>;
    send(id: string, text: string): Promise<void>;
    cancel(id: string): Promise<void>;
    onMessage(listener: (message: RoomMessage) => void): () => void;
    onChanged(listener: () => void): () => void;
  };
  routines: {
    list(botId: string): Promise<RoutineState[]>;
    save(botId: string, draft: RoutineDraft): Promise<RoutineState>;
    delete(botId: string, routineId: string): Promise<void>;
    runNow(botId: string, routineId: string): Promise<{ conversationId: string }>;
    runs(botId: string, routineId: string, limit?: number): Promise<RoutineRun[]>;
    onChanged(listener: (botId: string) => void): () => void;
  };
  reports: {
    list(filter?: { pending?: boolean; botId?: string; limit?: number }): Promise<WorkReport[]>;
    /** Chief processes this report now in a new run. */
    processNow(id: string): Promise<{ conversationId: string }>;
    onChanged(listener: () => void): () => void;
  };
  bots: {
    list(): Promise<Bot[]>;
    get(id: string): Promise<Bot>;
    save(bot: Bot): Promise<Bot>;
    delete(id: string): Promise<void>;
    /** Manual path (editor / "+"): main assigns id and, if missing, a random avatar. */
    create(draft: BotDraft): Promise<Bot>;
    update(id: string, patch: BotPatch): Promise<Bot>;
    makePermanent(id: string): Promise<Bot>;
    memory: {
      get(id: string): Promise<string>;
      set(id: string, text: string): Promise<void>;
    };
    onChanged(listener: () => void): () => void;
  };
  approvals: {
    /** `edited` carries the user's version of the draft/patch from the card's editor. */
    respond(
      approvalId: string,
      decision: ApprovalDecision,
      edited?: BotDraft | BotPatch | Partial<RoutineDraft>,
    ): Promise<void>;
  };
  connections: {
    /** Claude MCP status and Codex config servers; `refresh` probes Claude again. */
    list(refresh?: boolean): Promise<ConnectionInfo[]>;
  };
  projects: {
    list(): Promise<Project[]>;
    /** Creates (no id) or replaces a project; main assigns the id from the name. */
    save(draft: ProjectDraft): Promise<Project>;
    /** Also removes every bot's grant to it. */
    delete(id: string): Promise<void>;
    /** Native folder picker; null when cancelled. */
    pickFolder(): Promise<string | null>;
    onChanged(listener: () => void): () => void;
  };
  conversations: {
    list(botId: string): Promise<Conversation[]>;
    get(id: string): Promise<ConversationDetail>;
    delete(id: string): Promise<void>;
  };
  chat: {
    send(
      botId: string,
      text: string,
      conversationId?: string,
    ): Promise<{ conversationId: string; runId: string }>;
    cancel(conversationId: string): Promise<void>;
    onEvent(listener: (event: EventEnvelope) => void): () => void;
  };
  engines: {
    status(): Promise<Record<EngineId, AuthStatus>>;
    models(engine: EngineId): Promise<EngineModel[]>;
  };
  settings: { get(): Promise<Settings>; set(patch: SettingsPatch): Promise<Settings> };
}
export const channels = {
  appSetView: 'app:set-view',
  appNavigate: 'app:navigate',
  appActivity: 'app:activity',
  appOnActivity: 'app:on-activity',
  appQuit: 'app:quit',
  telegramStatus: 'telegram:status',
  telegramSetToken: 'telegram:set-token',
  telegramStartPairing: 'telegram:start-pairing',
  telegramUnpair: 'telegram:unpair',
  telegramSetOptions: 'telegram:set-options',
  telegramOnStatus: 'telegram:on-status',
  roomsActivity: 'rooms:activity',
  roomsOnActivity: 'rooms:on-activity',
  roomsList: 'rooms:list',
  roomsCreate: 'rooms:create',
  roomsUpdate: 'rooms:update',
  roomsDelete: 'rooms:delete',
  roomsMessages: 'rooms:messages',
  roomsSend: 'rooms:send',
  roomsCancel: 'rooms:cancel',
  roomsMessage: 'rooms:message',
  roomsChanged: 'rooms:changed',
  routinesList: 'routines:list',
  routinesSave: 'routines:save',
  routinesDelete: 'routines:delete',
  routinesRunNow: 'routines:run-now',
  routinesRuns: 'routines:runs',
  routinesChanged: 'routines:changed',
  reportsList: 'reports:list',
  reportsProcessNow: 'reports:process-now',
  reportsChanged: 'reports:changed',
  botsList: 'bots:list',
  botsGet: 'bots:get',
  botsSave: 'bots:save',
  botsDelete: 'bots:delete',
  botsChanged: 'bots:changed',
  botsCreate: 'bots:create',
  botsUpdate: 'bots:update',
  botsMakePermanent: 'bots:make-permanent',
  botsMemoryGet: 'bots:memory-get',
  botsMemorySet: 'bots:memory-set',
  approvalsRespond: 'approvals:respond',
  connectionsList: 'connections:list',
  projectsList: 'projects:list',
  projectsSave: 'projects:save',
  projectsDelete: 'projects:delete',
  projectsPickFolder: 'projects:pick-folder',
  projectsChanged: 'projects:changed',
  conversationsList: 'conversations:list',
  conversationsGet: 'conversations:get',
  conversationsDelete: 'conversations:delete',
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatEvent: 'chat:event',
  enginesStatus: 'engines:status',
  enginesModels: 'engines:models',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
} as const;
