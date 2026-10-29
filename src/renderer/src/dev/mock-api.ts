// Browser-only stand-in for the preload bridge so the interface can be
// designed and reviewed outside Electron. Never bundled into production.
import type { Api, Conversation, ConversationDetail, Message } from '../../../shared/api';
import {
  botSchema,
  botDraftSchema,
  botPatchSchema,
  defaultPersona,
  type Bot,
  type BotDraft,
} from '../../../shared/bots';
import { randomAvatar } from '../../../shared/avatars';
import type { BotEvent, EventEnvelope } from '../../../shared/events';
import { notificationsSchema, settingsPatchSchema, type Settings } from '../../../shared/settings';
import { projectDraftSchema, projectSchema, type AccessLevel } from '../../../shared/projects';
import {
  routineDraftSchema,
  type Routine,
  type RoutineDraft,
  type RoutineRun,
  type WorkReport,
} from '../../../shared/routines';
import type { TelegramStatus } from '../../../shared/telegram';
import { telegramOptionsSchema } from '../../../shared/settings';
import type { Room, RoomActivity, RoomMessage } from '../../../shared/rooms';
import {
  roomDraftSchema,
  roomPatchSchema,
  roomTextSchema,
  roomMentions,
} from '../../../shared/room-helpers';

const base: Pick<
  Bot,
  | 'role'
  | 'persona'
  | 'parent'
  | 'connections'
  | 'projects'
  | 'effort'
  | 'writeScope'
  | 'readScope'
  | 'sandbox'
  | 'network'
  | 'routines'
  | 'system'
  | 'temporary'
  | 'instructions'
> = {
  role: '',
  persona: defaultPersona,
  parent: null,
  connections: [],
  projects: [],
  effort: 'high',
  writeScope: [],
  readScope: [],
  sandbox: 'workspace-write',
  network: false,
  routines: [],
  system: false,
  temporary: false,
  instructions: '',
};

const bots: Bot[] = [
  {
    ...base,
    id: 'chief',
    name: 'Şef',
    engine: 'claude',
    model: 'opus',
    workdir: 'C:/work/team',
    system: true,
    network: true,
    role: 'Ekibi kurar ve işi dağıtır',
    connections: ['*'],
    projects: [
      { project: 'acme', level: 'full' },
      { project: 'penathon-web', level: 'full' },
    ],
    avatar: { shape: 'hexagon', color: '#6E6AF0', eyes: 'dots', detail: 'none' },
  },
  {
    ...base,
    id: 'leads',
    name: 'Lead Takibi',
    projects: [{ project: 'acme', level: 'write' }],
    engine: 'codex',
    model: 'default',
    workdir: 'C:/work/leads',
    avatar: { shape: 'circle', color: '#2FB38A', eyes: 'happy', detail: 'sprout' },
  },
  {
    ...base,
    id: 'content',
    name: 'İçerik Stüdyosu',
    projects: [{ project: 'penathon-web', level: 'write' }],
    engine: 'claude',
    model: 'sonnet',
    workdir: 'C:/work/content',
    avatar: { shape: 'square', color: '#E8A23B', eyes: 'wink', detail: 'ears' },
  },
  {
    ...base,
    id: 'brief',
    name: 'Sabah Brifingi',
    projects: [{ project: 'acme', level: 'read' }],
    engine: 'claude',
    model: 'haiku',
    workdir: 'C:/work/brief',
    avatar: { shape: 'circle', color: '#3E9BE8', eyes: 'big', detail: 'antenna' },
  },
  {
    ...base,
    id: 'tmp-fair',
    name: 'Fuar katılımcı araştırması',
    role: 'Eksik sektörleri araştırır',
    parent: 'leads',
    engine: 'codex',
    model: 'default',
    workdir: 'C:/work/leads/tmp',
    temporary: true,
    avatar: { shape: 'square', color: '#C26BE0', eyes: 'dots', detail: 'halo' },
  },
];

const settings: Settings = {
  runInBackground: true,
  notifications: {
    enabled: true,
    done: true,
    approval: true,
    error: true,
    routine: true,
    rooms: false,
  },
  telegram: { enabled: false, routeTo: 'chief', notifyRoutines: true, hasToken: false },
  botsDir: 'C:/work/bots',
  projects: [
    {
      id: 'acme',
      name: 'Acme',
      description: 'Fuar araştırması ve müşteri takibi',
      folders: ['C:/work/acme/research', 'C:/work/acme/leads'],
    },
    {
      id: 'penathon-web',
      name: 'Penathon Web',
      description: 'Web sitesi',
      folders: ['C:/work/penathon-web'],
    },
  ],
  language: 'tr',
  theme: 'system',
  profile: { name: '', address: '' },
  engines: {
    claude: { authMode: 'local-cli', hasApiKey: false },
    codex: { authMode: 'local-cli', hasApiKey: false },
  },
};

const now = Date.now();
const iso = (offset: number) => new Date(now - offset).toISOString();
const conversations: Conversation[] = [
  { id: 'c1', botId: 'chief', title: 'Fuar listesi için ekip planı', createdAt: iso(600_000) },
];
const messages: Message[] = [
  {
    id: 'm1',
    conversationId: 'c1',
    role: 'user',
    text: 'Acme fuarı katılımcı listesini çıkar, Lead Takibi botuna ver.',
    createdAt: iso(600_000),
  },
];
let seq = 0;
const env = (conversationId: string, event: BotEvent, offset: number): EventEnvelope => ({
  conversationId,
  runId: 'r1',
  sequence: ++seq,
  createdAt: iso(offset),
  event,
});
const history: EventEnvelope[] = [
  env('c1', { type: 'status', status: 'thinking' }, 599_000),
  env(
    'c1',
    {
      type: 'message.done',
      messageId: 'a1',
      text: 'Tamam. Önce mevcut lead klasörüne bakıp neyin elimizde olduğunu görüyorum.',
    },
    598_000,
  ),
  env(
    'c1',
    {
      type: 'tool.start',
      toolId: 't1',
      kind: 'file_read',
      title: 'Lead klasörünü oku',
      argsSummary: 'leads/2026/acme-katilimcilar.csv',
    },
    597_000,
  ),
  env(
    'c1',
    {
      type: 'tool.end',
      toolId: 't1',
      resultSummary: '214 satır, son güncelleme 21 Ekim',
      error: false,
    },
    596_000,
  ),
  env(
    'c1',
    {
      type: 'tool.start',
      toolId: 't2',
      kind: 'search',
      title: 'Eksik firmaları ara',
      argsSummary: 'katılımcı listesinde sektör alanı boş olanlar',
    },
    595_000,
  ),
  env(
    'c1',
    { type: 'tool.end', toolId: 't2', resultSummary: '38 firmada sektör eksik', error: false },
    594_000,
  ),
  env(
    'c1',
    {
      type: 'tool.start',
      toolId: 't3',
      kind: 'command',
      title: 'Geçici bot aç',
      argsSummary: 'spawn_temp_bot "Fuar katılımcı araştırması"',
    },
    593_000,
  ),
  env(
    'c1',
    { type: 'tool.end', toolId: 't3', resultSummary: 'Geçici bot çalışıyor', error: false },
    592_000,
  ),
  env(
    'c1',
    {
      type: 'tool.start',
      toolId: 't4',
      kind: 'file_write',
      title: 'Plan notunu yaz',
      argsSummary: 'notes/fuar-plani.md',
    },
    591_000,
  ),
  env(
    'c1',
    { type: 'tool.end', toolId: 't4', resultSummary: '12 satır eklendi', error: false },
    590_000,
  ),
  env(
    'c1',
    {
      type: 'diff',
      file: 'notes/fuar-plani.md',
      unifiedDiff:
        '--- a/notes/fuar-plani.md\n+++ b/notes/fuar-plani.md\n@@ -1,3 +1,6 @@\n # Fuar planı\n-Durum: bekliyor\n+Durum: araştırma sürüyor\n+- 214 firma elde\n+- 38 firmada sektör eksik, geçici bot dolduruyor\n+- Bitince Lead Takibi skorlayacak',
    },
    589_000,
  ),
  env(
    'c1',
    {
      type: 'message.done',
      messageId: 'a2',
      text: 'Elimizde 214 firma var; 38 tanesinde sektör bilgisi eksik. Bunları doldurmak için “Fuar katılımcı araştırması” adında geçici bir bot açtım. Bitince listeyi Lead Takibi’ne devredeceğim, o da skorlayıp öncelik sırasını çıkaracak.\n\nİstersen bu işi her pazartesi tekrarlayan bir rutine çevirebilirim.\n\n## Durum\n\n| Adım | Bot | Durum |\n|---|---|---|\n| Sektörleri doldur | Fuar katılımcı araştırması | **Sürüyor** |\n| Skorla ve sırala | Lead Takibi | Bekliyor |\n\n- Liste: `leads/2026/acme-katilimcilar.csv`\n- Not: `notes/fuar-plani.md`',
    },
    588_000,
  ),
  env(
    'c1',
    {
      type: 'approval.request',
      approvalId: 'p1',
      title: 'Rutin kur: Haftalık fuar listesi güncellemesi',
      details: 'Her pazartesi 09:00, Şef çalıştırır. Sonuç bu sohbete düşer.',
    },
    587_500,
  ),
  env(
    'c1',
    { type: 'run.done', durationMs: 48_300, usage: { inputTokens: 18_420, outputTokens: 1_310 } },
    587_000,
  ),
  env('c1', { type: 'approval.resolved', approvalId: 'p1', decision: 'expired' }, 587_000),
  env(
    'c1',
    {
      type: 'card',
      cardId: 'spawn-example',
      kind: 'bot.spawned',
      data: {
        botId: 'tmp-fair',
        name: 'Fuar katılımcı araştırması',
        task: 'Eksik sektörleri araştır',
        temporary: true,
      },
    },
    592_000,
  ),
  env('c1', { type: 'status', status: 'done' }, 587_000),
];

const listeners = new Set<(e: EventEnvelope) => void>();
const routineChanged = new Set<(botId: string) => void>();
const reportChanged = new Set<() => void>();
const notifyRoutines = (botId: string) => routineChanged.forEach((listener) => listener(botId));
const notifyReports = () => reportChanged.forEach((listener) => listener());
const routineHistory: RoutineRun[] = [];
const workReports: WorkReport[] = [];
for (const bot of bots) {
  bot.routines = [
    bot.id === 'chief'
      ? {
          id: 'vault-update',
          name: 'Vault güncelleme',
          schedule: { kind: 'daily', time: '22:00' },
          prompt:
            'Bekleyen raporları bilgi klasörünün kurallarına göre ilgili notlara yaz ve işaretle.',
          model: 'haiku',
          system: true,
          enabled: false,
        }
      : {
          id: 'morning-summary',
          name: 'Sabah iş özeti',
          schedule: { kind: 'daily', time: '09:00' },
          prompt: 'Bugünkü işleri ve açık konuları kısaca özetle.',
          system: false,
          enabled: true,
        },
  ];
  for (const [index, status] of (['done', 'skipped', 'error'] as const).entries()) {
    const id = 'routine-' + bot.id + '-' + index;
    const conversationId = status === 'skipped' ? '' : id;
    const summary =
      status === 'done'
        ? 'İşler özetlendi; proje notları güncellendi.'
        : status === 'skipped'
          ? 'bot meşguldü'
          : 'Bağlantı kurulamadı.';
    if (conversationId) {
      conversations.push({
        id: conversationId,
        botId: bot.id,
        title: bot.routines[0].name,
        createdAt: iso((index + 1) * 86_400_000),
      });
      messages.push({
        id,
        conversationId,
        role: 'assistant',
        text: summary,
        createdAt: iso((index + 1) * 86_400_000),
      });
    }
    routineHistory.push({
      id,
      botId: bot.id,
      routineId: bot.routines[0].id,
      conversationId,
      startedAt: iso((index + 1) * 86_400_000 + 2000),
      finishedAt: iso((index + 1) * 86_400_000),
      durationMs: status === 'skipped' ? 0 : 2000,
      status,
      summary,
    });
  }
}
for (const [index, botId] of ['leads', 'content', 'brief'].entries())
  workReports.push({
    id: 'report-' + index,
    botId,
    conversationId: 'routine-' + botId + '-0',
    createdAt: iso(index * 60_000),
    summary: [
      'Firma listesi güncellendi, 12 yeni aday bulundu.',
      'Haftalık içerik taslakları hazırlandı.',
      'Sabah özeti hazır; iki konu takip bekliyor.',
    ][index],
    decisions: ['Öncelik mevcut projelere verildi.'],
    files: [bots.find((bot) => bot.id === botId)!.workdir + '/notes.md'],
    open: ['Son kontrol bekleniyor.'],
    source: 'auto',
  });
const mockNextRun = (routine: Routine): string | undefined => {
  if (!routine.enabled) return undefined;
  const date = new Date();
  if (routine.schedule.kind === 'interval')
    date.setMinutes(date.getMinutes() + routine.schedule.everyMinutes);
  else {
    const [hour, minute] = routine.schedule.time.split(':').map(Number);
    date.setHours(hour, minute, 0, 0);
    if (date <= new Date()) date.setDate(date.getDate() + 1);
    if (routine.schedule.kind === 'weekly')
      while (!routine.schedule.days.includes(date.getDay())) date.setDate(date.getDate() + 1);
  }
  return date.toISOString();
};
const live: EventEnvelope[] = [];
const emit = (e: EventEnvelope) => {
  live.push(e);
  listeners.forEach((l) => l(e));
};

const changed = new Set<() => void>();
const notify = () => changed.forEach((listener) => listener());
const projectChanged = new Set<() => void>();
const notifyProjects = () => projectChanged.forEach((listener) => listener());
const memories = new Map<string, string>();
const getBot = (id: string): Bot => {
  const bot = bots.find((bot) => bot.id === id);
  if (!bot) throw new Error('errors.botMissing');
  return structuredClone(bot);
};
const preview = (input: BotDraft): Bot => {
  const draft = botDraftSchema.parse(input);
  const parent = draft.parent ? getBot(draft.parent) : getBot('chief');
  const slug =
    draft.name
      .toLocaleLowerCase('tr')
      .replace(/ı/g, 'i')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 56) || 'bot';
  let id = slug;
  for (let n = 2; bots.some((bot) => bot.id === id); n++) id = slug + '-' + n;
  return botSchema.parse({
    ...draft,
    id,
    workdir: draft.workdir ?? parent.workdir,
    readScope: draft.readScope ?? parent.readScope,
    writeScope: draft.writeScope ?? parent.writeScope,
    sandbox: draft.sandbox ?? (parent.sandbox === 'read-only' ? 'read-only' : 'workspace-write'),
    avatar: draft.avatar ?? randomAvatar(bots.map((bot) => bot.avatar)),
  });
};
type MockRun = {
  push(event: BotEvent): void;
  timers: ReturnType<typeof setTimeout>[];
  approvalId?: string;
  draft?: BotDraft;
  routine?: { botId: string; draft: RoutineDraft };
  routineRun?: RoutineRun;
  reportId?: string;
  grant?: { botId: string; projectId: string; level: AccessLevel };
};
const runs = new Map<string, MockRun>();
const approvals = new Map<string, string>();
const finish = (id: string, text: string, cancelled = false) => {
  const run = runs.get(id);
  if (!run) return;
  run.timers.forEach(clearTimeout);
  if (text) {
    run.push({ type: 'message.done', messageId: crypto.randomUUID(), text });
    messages.push({
      id: crypto.randomUUID(),
      conversationId: id,
      role: 'assistant',
      text,
      createdAt: new Date().toISOString(),
    });
  }
  run.push({ type: 'status', status: cancelled ? 'idle' : 'done' });
  run.push({ type: 'run.done', durationMs: 1000, cancelled });
  if (run.routineRun) {
    Object.assign(run.routineRun, {
      status: cancelled ? 'cancelled' : 'done',
      finishedAt: new Date().toISOString(),
      durationMs: 1000,
      summary: text.slice(0, 300),
    });
    notifyRoutines(run.routineRun.botId);
  }
  if (run.reportId && !cancelled) {
    Object.assign(
      workReports.find((report) => report.id === run.reportId)!,
      {
        processedAt: new Date().toISOString(),
        processedInto: 'daily/' + new Date().toISOString().slice(0, 10) + '.md',
      },
    );
    notifyReports();
  }
  runs.delete(id);
};
const rooms: Room[] = [
  {
    id: 'acme-room',
    name: 'Acme lansmanı',
    members: ['chief', 'leads', 'content'],
    lead: 'chief',
    createdAt: iso(600_000),
  },
];
const roomMessages: RoomMessage[] = [
  {
    id: 'room-m1',
    roomId: 'acme-room',
    author: { kind: 'user' },
    text: 'Acme lansmanını birlikte hazırlayalım.',
    createdAt: iso(600_000),
  },
  {
    id: 'room-m2',
    roomId: 'acme-room',
    author: { kind: 'bot', botId: 'chief' },
    text: '@Lead_Takibi, firma listesini hazırlar mısın?',
    createdAt: iso(590_000),
  },
  {
    id: 'room-m3',
    roomId: 'acme-room',
    author: { kind: 'bot', botId: 'leads' },
    text: 'Firma listesi hazır, 12 yeni aday ekledim.',
    createdAt: iso(580_000),
  },
];
const roomChanged = new Set<() => void>();
const roomListeners = new Set<(message: RoomMessage) => void>();
const roomActivityListeners = new Set<(activity: RoomActivity) => void>();
const roomConversations = new Set<string>();
const roomRuns = new Map<
  string,
  {
    queue: string[];
    active?: string;
    timer?: ReturnType<typeof setTimeout>;
    conversationId?: string;
    runId?: string;
  }
>();
const getRoom = (id: string): Room => {
  const room = rooms.find((room) => room.id === id);
  if (!room) throw new Error('errors.roomMissing');
  return room;
};
const roomActivity = (id: string): RoomActivity => ({
  roomId: id,
  active: roomRuns.get(id)?.active,
  queue: [...(roomRuns.get(id)?.queue ?? [])],
});
const notifyRoomActivity = (id: string) =>
  roomActivityListeners.forEach((listener) => listener(roomActivity(id)));
const pushRoomMessage = (message: RoomMessage) => {
  roomMessages.push(message);
  roomListeners.forEach((listener) => listener(structuredClone(message)));
};
const validateRoom = (room: Room): Room => {
  room.members = [...new Set(room.members)];
  room.members.forEach(getBot);
  if (!room.members.includes(room.lead)) throw new Error('errors.invalidInput');
  return room;
};
const mockRoomConversation = (roomId: string, botId: string): string => {
  const id = `room-${roomId}-${botId}`;
  if (!roomConversations.has(id)) {
    roomConversations.add(id);
    conversations.push({
      id,
      botId,
      title: getRoom(roomId).name,
      createdAt: new Date().toISOString(),
    });
  }
  return id;
};
for (const message of roomMessages) {
  if (message.author.kind !== 'bot') continue;
  message.conversationId = mockRoomConversation(message.roomId, message.author.botId);
  message.runId = crypto.randomUUID();
  messages.push({
    id: message.id,
    conversationId: message.conversationId,
    role: 'assistant',
    text: message.text,
    createdAt: message.createdAt,
  });
}
const nextRoomReply = (id: string): void => {
  const run = roomRuns.get(id);
  if (!run || run.active) return;
  const botId = run.queue.shift();
  if (!botId) {
    roomRuns.delete(id);
    notifyRoomActivity(id);
    return;
  }
  run.active = botId;
  run.conversationId = mockRoomConversation(id, botId);
  run.runId = crypto.randomUUID();
  const push = (event: BotEvent) =>
    emit({
      conversationId: run.conversationId!,
      runId: run.runId!,
      sequence: ++seq,
      createdAt: new Date().toISOString(),
      event,
    });
  push({ type: 'status', status: 'thinking' });
  notifyRoomActivity(id);
  run.timer = setTimeout(() => {
    const text = `${getBot(botId).name}: Anladım, kendi kısmımı hazırlıyorum.`;
    const createdAt = new Date().toISOString();
    push({ type: 'message.done', messageId: crypto.randomUUID(), text });
    push({ type: 'status', status: 'done' });
    push({ type: 'run.done', durationMs: 700 });
    messages.push({
      id: crypto.randomUUID(),
      conversationId: run.conversationId!,
      role: 'assistant',
      text,
      createdAt,
    });
    pushRoomMessage({
      id: crypto.randomUUID(),
      roomId: id,
      author: { kind: 'bot', botId },
      text,
      conversationId: run.conversationId,
      runId: run.runId,
      createdAt,
    });
    run.active = undefined;
    nextRoomReply(id);
  }, 700);
};

const telegramListeners = new Set<(status: TelegramStatus) => void>();
let telegramPairingTimer: ReturnType<typeof setTimeout> | undefined;
let telegramPairingCode: string | undefined;
const telegramStatus = (): TelegramStatus => ({
  configured: settings.telegram.hasToken,
  running: settings.telegram.enabled && settings.telegram.hasToken,
  enabled: settings.telegram.enabled,
  routeTo: settings.telegram.routeTo,
  notifyRoutines: settings.telegram.notifyRoutines,
  botUsername: settings.telegram.hasToken ? 'penathon_demo_bot' : undefined,
  pairedChat: settings.telegram.pairedChatId
    ? { id: settings.telegram.pairedChatId, name: settings.telegram.pairedName! }
    : undefined,
  pairingCode: telegramPairingCode,
});
const notifyTelegram = () => {
  const status = telegramStatus();
  telegramListeners.forEach((listener) => listener(structuredClone(status)));
  return status;
};
const navigationListeners = new Set<Parameters<Api['app']['onNavigate']>[0]>();
export const mockApi: Api = {
  app: {
    setView: () => {},
    activity: async () => ({ running: [], pendingApprovals: 0 }),
    onActivity: (listener) => {
      const off = mockApi.chat.onEvent(() => {
        void mockApi.app.activity().then(listener);
      });
      return off;
    },
    onNavigate: (listener) => {
      navigationListeners.add(listener);
      return () => {
        navigationListeners.delete(listener);
      };
    },
    quit: async () => {},
  },
  telegram: {
    status: async () => telegramStatus(),
    setToken: async (token) => {
      clearTimeout(telegramPairingTimer);
      telegramPairingCode = undefined;
      Object.assign(settings.telegram, {
        hasToken: !!token?.trim(),
        enabled: !!token?.trim(),
        pairedChatId: undefined,
        pairedName: undefined,
      });
      return notifyTelegram();
    },
    startPairing: async () => {
      if (!settings.telegram.hasToken || settings.telegram.pairedChatId) return telegramStatus();
      clearTimeout(telegramPairingTimer);
      telegramPairingCode = '123456';
      settings.telegram.enabled = true;
      telegramPairingTimer = setTimeout(() => {
        telegramPairingCode = undefined;
        settings.telegram.pairedChatId = 123456789;
        settings.telegram.pairedName = 'Alex';
        notifyTelegram();
      }, 3000);
      return notifyTelegram();
    },
    unpair: async () => {
      clearTimeout(telegramPairingTimer);
      telegramPairingCode = undefined;
      settings.telegram.pairedChatId = undefined;
      settings.telegram.pairedName = undefined;
      return notifyTelegram();
    },
    setOptions: async (input) => {
      const options = telegramOptionsSchema.parse(input);
      if (options.routeTo !== undefined) getBot(options.routeTo);
      Object.assign(settings.telegram, options);
      if (options.enabled === false) {
        clearTimeout(telegramPairingTimer);
        telegramPairingCode = undefined;
      }
      return notifyTelegram();
    },
    onStatus: (listener) => {
      telegramListeners.add(listener);
      return () => {
        telegramListeners.delete(listener);
      };
    },
  },
  rooms: {
    list: async () => structuredClone(rooms),
    create: async (input) => {
      const draft = roomDraftSchema.parse(input);
      const room = validateRoom({
        ...draft,
        lead: draft.lead ?? (draft.members.includes('chief') ? 'chief' : draft.members[0]),
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      });
      rooms.push(room);
      roomChanged.forEach((listener) => listener());
      return structuredClone(room);
    },
    update: async (id, input) => {
      const before = getRoom(id);
      const patch = roomPatchSchema.parse(input);
      const members = patch.members ?? before.members;
      const room = validateRoom({
        ...before,
        ...patch,
        members,
        lead:
          patch.lead ??
          (members.includes(before.lead)
            ? before.lead
            : members.includes('chief')
              ? 'chief'
              : members[0]),
      });
      if (patch.members || patch.lead) await mockApi.rooms.cancel(id);
      Object.assign(before, room);
      roomChanged.forEach((listener) => listener());
      return structuredClone(room);
    },
    delete: async (id) => {
      getRoom(id);
      await mockApi.rooms.cancel(id);
      for (const conversationId of [...roomConversations].filter((value) =>
        value.startsWith(`room-${id}-`),
      )) {
        await mockApi.conversations.delete(conversationId);
        roomConversations.delete(conversationId);
        for (const rows of [messages, live, history])
          for (let i = rows.length - 1; i >= 0; i--)
            if (rows[i].conversationId === conversationId) rows.splice(i, 1);
      }
      rooms.splice(
        rooms.findIndex((room) => room.id === id),
        1,
      );
      for (let i = roomMessages.length - 1; i >= 0; i--)
        if (roomMessages[i].roomId === id) roomMessages.splice(i, 1);
      roomChanged.forEach((listener) => listener());
    },
    messages: async (id, limit = 100) => {
      getRoom(id);
      return structuredClone(roomMessages.filter((message) => message.roomId === id).slice(-limit));
    },
    activity: async (id) => {
      getRoom(id);
      return roomActivity(id);
    },
    send: async (id, input) => {
      const room = getRoom(id);
      const text = roomTextSchema.parse(input);
      pushRoomMessage({
        id: crypto.randomUUID(),
        roomId: id,
        author: { kind: 'user' },
        text,
        createdAt: new Date().toISOString(),
      });
      const targets = roomMentions(
        text,
        bots.filter((bot) => room.members.includes(bot.id)),
      );
      const run = roomRuns.get(id) ?? { queue: [] };
      run.queue.push(...(targets.length ? targets : [room.lead]));
      roomRuns.set(id, run);
      notifyRoomActivity(id);
      nextRoomReply(id);
    },
    cancel: async (id) => {
      getRoom(id);
      const run = roomRuns.get(id);
      clearTimeout(run?.timer);
      if (run?.conversationId && run.runId)
        emit({
          conversationId: run.conversationId,
          runId: run.runId,
          sequence: ++seq,
          createdAt: new Date().toISOString(),
          event: { type: 'run.done', durationMs: 0, cancelled: true },
        });
      roomRuns.delete(id);
      notifyRoomActivity(id);
    },
    onActivity: (listener) => {
      roomActivityListeners.add(listener);
      return () => roomActivityListeners.delete(listener);
    },
    onMessage: (listener) => {
      roomListeners.add(listener);
      return () => roomListeners.delete(listener);
    },
    onChanged: (listener) => {
      roomChanged.add(listener);
      return () => roomChanged.delete(listener);
    },
  },
  routines: {
    list: async (botId) =>
      getBot(botId).routines.map((routine) => ({
        botId,
        routine,
        nextRunAt: mockNextRun(routine),
        lastRun: structuredClone(
          routineHistory.find((run) => run.botId === botId && run.routineId === routine.id),
        ),
      })),
    save: async (botId, input) => {
      const draft = routineDraftSchema.parse(input);
      const bot = getBot(botId);
      const before = bot.routines.find((routine) => routine.id === draft.id);
      if (draft.id && !before) throw new Error('Routine missing');
      if (draft.name.toLocaleLowerCase('tr') === bot.name.toLocaleLowerCase('tr'))
        throw new Error('Rutin adı işin adı olmalı.');
      if (before?.system && (draft.name !== before.name || draft.model !== before.model))
        throw new Error('System routine protected');
      const routine: Routine = {
        ...draft,
        id: draft.id ?? 'routine-' + crypto.randomUUID(),
        system: before?.system ?? false,
      };
      await mockApi.bots.save({
        ...bot,
        routines: [...bot.routines.filter((value) => value.id !== routine.id), routine],
      });
      notifyRoutines(botId);
      return (await mockApi.routines.list(botId)).find((state) => state.routine.id === routine.id)!;
    },
    delete: async (botId, routineId) => {
      const bot = getBot(botId);
      const routine = bot.routines.find((routine) => routine.id === routineId);
      if (!routine || routine.system) throw new Error('Routine protected or missing');
      await mockApi.bots.save({
        ...bot,
        routines: bot.routines.filter((value) => value.id !== routineId),
      });
      notifyRoutines(botId);
    },
    runNow: async (botId, routineId) => {
      const routine = getBot(botId).routines.find((routine) => routine.id === routineId);
      if (!routine) throw new Error('Routine missing');
      if (
        conversations.some(
          (conversation) => conversation.botId === botId && runs.has(conversation.id),
        )
      )
        throw new Error('errors.botBusy');
      const run = await mockApi.chat.send(botId, routine.prompt);
      conversations.find((conversation) => conversation.id === run.conversationId)!.title =
        routine.name;
      const record: RoutineRun = {
        id: run.runId,
        botId,
        routineId,
        conversationId: run.conversationId,
        startedAt: new Date().toISOString(),
        status: 'running',
      };
      routineHistory.unshift(record);
      runs.get(run.conversationId)!.routineRun = record;
      notifyRoutines(botId);
      return run;
    },
    runs: async (botId, routineId, limit = 50) =>
      structuredClone(
        routineHistory
          .filter((run) => run.botId === botId && run.routineId === routineId)
          .slice(0, limit),
      ),
    onChanged: (listener) => {
      routineChanged.add(listener);
      return () => {
        routineChanged.delete(listener);
      };
    },
  },
  reports: {
    list: async (filter = {}) =>
      structuredClone(
        workReports
          .filter(
            (report) =>
              (filter.pending === undefined || !report.processedAt === filter.pending) &&
              (!filter.botId || report.botId === filter.botId),
          )
          .slice(0, filter.limit ?? 100),
      ),
    processNow: async (id) => {
      const report = workReports.find((report) => report.id === id);
      if (!report || report.processedAt) throw new Error('Report missing or processed');
      if (
        conversations.some(
          (conversation) => conversation.botId === 'chief' && runs.has(conversation.id),
        )
      )
        throw new Error('errors.botBusy');
      const run = await mockApi.chat.send(
        'chief',
        'Vault güncelleme: yalnız ' + id + ' raporunu işle.',
      );
      conversations.find((conversation) => conversation.id === run.conversationId)!.title =
        'Vault güncelleme';
      runs.get(run.conversationId)!.reportId = id;
      return run;
    },
    onChanged: (listener) => {
      reportChanged.add(listener);
      return () => {
        reportChanged.delete(listener);
      };
    },
  },
  bots: {
    list: async () => structuredClone(bots),
    get: async (id) => getBot(id),
    save: async (input) => {
      const bot = botSchema.parse(input);
      if (bot.id === 'chief' && (!bot.system || bot.parent || bot.temporary))
        throw new Error('errors.chiefProtected');
      if (bot.id !== 'chief' && bot.system) throw new Error('errors.chiefProtected');
      if (
        bot.projects.some(
          (grant) => !settings.projects.some((project) => project.id === grant.project),
        )
      )
        throw new Error('errors.projectMissing');
      const i = bots.findIndex((b) => b.id === bot.id);
      if (i < 0) bots.push(bot);
      else bots[i] = bot;
      notify();
      return structuredClone(bot);
    },
    create: async (draft) => mockApi.bots.save(preview(draft)),
    update: async (id, patch) =>
      mockApi.bots.save({ ...getBot(id), ...botPatchSchema.parse(patch) }),
    makePermanent: async (id) => mockApi.bots.update(id, { temporary: false }),
    memory: {
      get: async (id) => {
        getBot(id);
        return memories.get(id) ?? '';
      },
      set: async (id, text) => {
        getBot(id);
        memories.set(id, text);
      },
    },
    delete: async (id) => {
      if (getBot(id).system) throw new Error('errors.chiefProtected');
      for (const child of bots.filter((bot) => bot.parent === id))
        await mockApi.bots.delete(child.id);
      bots.splice(
        bots.findIndex((bot) => bot.id === id),
        1,
      );
      notify();
    },
    onChanged: (listener) => {
      changed.add(listener);
      return () => changed.delete(listener);
    },
  },
  approvals: {
    respond: async (approvalId, decision, edited) => {
      const conversationId = approvals.get(approvalId);
      const run = conversationId ? runs.get(conversationId) : undefined;
      if (!run || !conversationId) throw new Error('Onay bulunamadı veya süresi dolmuş.');
      const bot =
        decision === 'approved' && run.draft
          ? await mockApi.bots.create(
              edited === undefined ? run.draft! : botDraftSchema.parse(edited),
            )
          : undefined;
      if (decision === 'approved' && run.grant) {
        const grant = run.grant;
        const target = getBot(grant.botId);
        await mockApi.bots.update(target.id, {
          projects: [
            ...target.projects.filter((value) => value.project !== grant.projectId),
            { project: grant.projectId, level: grant.level },
          ],
        });
      }
      if (decision === 'approved' && run.routine)
        await mockApi.routines.save(
          run.routine.botId,
          edited === undefined ? run.routine.draft : routineDraftSchema.parse(edited),
        );
      approvals.delete(approvalId);
      run.push({
        type: 'approval.resolved',
        approvalId,
        decision: decision === 'approved' && edited ? 'edited' : decision,
        ...(bot ? { botId: bot.id } : {}),
      });
      finish(
        conversationId,
        bot
          ? bot.name + ' ekibe katıldı.'
          : run.draft
            ? 'Bot oluşturma iptal edildi.'
            : decision === 'approved'
              ? 'İşlem onaylandı.'
              : 'İşlem iptal edildi.',
      );
    },
  },
  connections: {
    list: async () => [
      { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai', toolCount: 12 },
      { name: 'claude.ai Google Drive', status: 'connected', source: 'claudeai', toolCount: 8 },
      { name: 'team', status: 'connected', source: 'app', toolCount: 11 },
      { name: 'penathon', status: 'connected', source: 'user', toolCount: 8 },
      { name: 'chrome-devtools', status: 'connected', source: 'user', toolCount: 6 },
    ],
  },
  projects: {
    list: async () => structuredClone(settings.projects),
    save: async (input) => {
      const draft = projectDraftSchema.parse(input);
      if (draft.id && !settings.projects.some((project) => project.id === draft.id))
        throw new Error('errors.projectMissing');
      if (draft.folders.some((folder) => !/^(?:[a-z]:[\\/]|\/)/i.test(folder)))
        throw new Error('errors.absolutePath');
      const slug =
        draft.name
          .toLocaleLowerCase('tr')
          .replace(/ı/g, 'i')
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 56) || 'project';
      let id = draft.id ?? slug;
      if (!draft.id)
        for (let n = 2; settings.projects.some((project) => project.id === id); n++)
          id = slug + '-' + n;
      const project = projectSchema.parse({ ...draft, id, folders: [...new Set(draft.folders)] });
      settings.projects = [...settings.projects.filter((value) => value.id !== id), project];
      notifyProjects();
      return structuredClone(project);
    },
    delete: async (id) => {
      if (!settings.projects.some((project) => project.id === id))
        throw new Error('errors.projectMissing');
      for (const bot of bots) bot.projects = bot.projects.filter((grant) => grant.project !== id);
      settings.projects = settings.projects.filter((project) => project.id !== id);
      notify();
      notifyProjects();
    },
    pickFolder: async () => 'C:/work/acme/research',
    onChanged: (listener) => {
      projectChanged.add(listener);
      return () => projectChanged.delete(listener);
    },
  },
  conversations: {
    delete: async (id) => {
      const i = conversations.findIndex((c) => c.id === id);
      if (i >= 0) conversations.splice(i, 1);
    },
    list: async (botId) =>
      conversations.filter((c) => c.botId === botId && !roomConversations.has(c.id)),
    get: async (id): Promise<ConversationDetail> => ({
      conversation: conversations.find((c) => c.id === id)!,
      messages: messages.filter((m) => m.conversationId === id),
      events: [...history, ...live].filter((e) => e.conversationId === id),
    }),
  },
  chat: {
    send: async (botId, text, conversationId) => {
      const id = conversationId ?? `c${conversations.length + 1}`;
      if (!conversationId)
        conversations.unshift({
          id,
          botId,
          title: text.slice(0, 40),
          createdAt: new Date().toISOString(),
        });
      messages.push({
        id: `m${messages.length + 1}`,
        conversationId: id,
        role: 'user',
        text,
        createdAt: new Date().toISOString(),
      });
      const runId = crypto.randomUUID();
      const push = (event: BotEvent) =>
        emit({
          conversationId: id,
          runId,
          sequence: ++seq,
          createdAt: new Date().toISOString(),
          event,
        });
      const run: MockRun = { push, timers: [] };
      runs.set(id, run);
      run.timers.push(setTimeout(() => push({ type: 'status', status: 'thinking' }), 100));
      if (/rutin/i.test(text)) {
        run.routine = {
          botId,
          draft: {
            name: 'Sabah mail özeti',
            schedule: { kind: 'daily', time: '09:00' },
            prompt: 'Maillerimi kısaca özetle.',
            enabled: true,
          },
        };
        run.approvalId = crypto.randomUUID();
        approvals.set(run.approvalId, id);
        run.timers.push(
          setTimeout(() => {
            push({ type: 'status', status: 'waiting' });
            push({
              type: 'approval.request',
              approvalId: run.approvalId!,
              kind: 'routine.create',
              title: 'Rutin kur: Sabah mail özeti',
              details: run.routine!.draft.prompt,
              data: {
                botId,
                routine: { ...run.routine!.draft, id: 'routine-' + runId, system: false },
              },
            });
          }, 400),
        );
      } else if (/projeye erişim ver|sil/i.test(text)) {
        const grant = /projeye erişim ver/i.test(text);
        const project = settings.projects[0];
        if (grant && !project) throw new Error('errors.projectMissing');
        run.approvalId = crypto.randomUUID();
        if (grant) run.grant = { botId: 'leads', projectId: project.id, level: 'write' };
        approvals.set(run.approvalId, id);
        run.timers.push(
          setTimeout(() => {
            push({ type: 'status', status: 'waiting' });
            push({
              type: 'approval.request',
              approvalId: run.approvalId!,
              title: grant ? 'Proje erişimi: ' + project.name : 'Dosya silme onayı',
              details: grant ? 'Lead Takibi: Writer' : 'rm C:/work/acme/leads/old.csv',
              kind: grant ? 'project.grant' : 'file.delete',
              data: grant
                ? {
                    botId: 'leads',
                    project,
                    level: 'write',
                    before:
                      getBot('leads').projects.find((value) => value.project === project.id)
                        ?.level ?? null,
                  }
                : {
                    command: 'rm C:/work/acme/leads/old.csv',
                    paths: ['C:/work/acme/leads/old.csv'],
                  },
            });
          }, 400),
        );
      } else if (/bot.*(?:kur|oluştur)|(?:kur|oluştur).*bot/i.test(text)) {
        const draft: BotDraft = {
          name: 'Araştırma Asistanı',
          role: 'Kaynaklı araştırma yapar',
          engine: 'claude',
          instructions: 'Kısa, kaynaklı araştırma yap.',
          parent: botId === 'chief' ? null : botId,
        };
        const bot = preview(draft);
        run.draft = { ...draft, avatar: bot.avatar };
        run.approvalId = crypto.randomUUID();
        approvals.set(run.approvalId, id);
        run.timers.push(
          setTimeout(() => {
            push({ type: 'status', status: 'waiting' });
            push({
              type: 'approval.request',
              approvalId: run.approvalId!,
              title: 'Bot oluştur: ' + bot.name,
              details: bot.role,
              kind: 'bot.create',
              data: { bot },
            });
          }, 400),
        );
      } else {
        run.timers.push(setTimeout(() => finish(id, 'Anladım, hemen başlıyorum.'), 1000));
      }
      return { conversationId: id, runId };
    },
    cancel: async (id) => {
      const run = runs.get(id);
      if (run?.approvalId) {
        approvals.delete(run.approvalId);
        run.push({ type: 'approval.resolved', approvalId: run.approvalId, decision: 'expired' });
      }
      finish(id, '', true);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  engines: {
    status: async () => ({
      claude: { mode: 'local-cli', state: 'unverified', messageKey: 'auth.localUnverified' },
      codex: { mode: 'local-cli', state: 'unverified', messageKey: 'auth.localUnverified' },
    }),
    models: async (engine) =>
      engine === 'claude'
        ? [
            { id: 'default', label: 'Varsayılan' },
            { id: 'opus', label: 'Opus' },
            { id: 'sonnet', label: 'Sonnet' },
            { id: 'haiku', label: 'Haiku' },
          ]
        : [
            { id: 'default', label: 'Varsayılan' },
            { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
            { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
          ],
  },
  settings: {
    get: async () => settings,
    set: async (input) => {
      const patch = settingsPatchSchema.parse(input);
      Object.assign(settings, {
        ...patch,
        notifications: notificationsSchema.parse({
          ...settings.notifications,
          ...patch.notifications,
        }),
        ...(patch.knowledgeDir === null ? { knowledgeDir: undefined } : {}),
      });
      if (patch.knowledgeDir !== undefined) {
        bots
          .find((bot) => bot.id === 'chief')!
          .routines.find((routine) => routine.id === 'vault-update')!.enabled =
          !!settings.knowledgeDir;
        notifyRoutines('chief');
      }
      return settings;
    },
  },
};
