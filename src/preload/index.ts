import { contextBridge, ipcRenderer } from 'electron';
import { channels, type Api } from '../shared/api';

const subscribe = <T>(channel: string, listener: (data: T) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, data: T) => listener(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const api: Api = {
  app: {
    setView: (view) => {
      void ipcRenderer.invoke(channels.appSetView, view).catch(() => undefined);
    },
    onNavigate: (listener) => subscribe(channels.appNavigate, listener),
    activity: () => ipcRenderer.invoke(channels.appActivity),
    onActivity: (listener) => subscribe(channels.appOnActivity, listener),
    quit: () => ipcRenderer.invoke(channels.appQuit),
  },
  telegram: {
    status: () => ipcRenderer.invoke(channels.telegramStatus),
    setToken: (token) => ipcRenderer.invoke(channels.telegramSetToken, token),
    startPairing: () => ipcRenderer.invoke(channels.telegramStartPairing),
    unpair: () => ipcRenderer.invoke(channels.telegramUnpair),
    setOptions: (options) => ipcRenderer.invoke(channels.telegramSetOptions, options),
    onStatus: (listener) => subscribe(channels.telegramOnStatus, listener),
  },
  rooms: {
    activity: (id) => ipcRenderer.invoke(channels.roomsActivity, id),
    onActivity: (listener) => subscribe(channels.roomsOnActivity, listener),
    list: () => ipcRenderer.invoke(channels.roomsList),
    create: (input) => ipcRenderer.invoke(channels.roomsCreate, input),
    update: (id, patch) => ipcRenderer.invoke(channels.roomsUpdate, id, patch),
    delete: (id) => ipcRenderer.invoke(channels.roomsDelete, id),
    messages: (id, limit) => ipcRenderer.invoke(channels.roomsMessages, id, limit),
    send: (id, text) => ipcRenderer.invoke(channels.roomsSend, id, text),
    cancel: (id) => ipcRenderer.invoke(channels.roomsCancel, id),
    onMessage: (listener) => subscribe(channels.roomsMessage, listener),
    onChanged: (listener) => subscribe(channels.roomsChanged, listener),
  },
  routines: {
    list: (botId) => ipcRenderer.invoke(channels.routinesList, botId),
    save: (botId, draft) => ipcRenderer.invoke(channels.routinesSave, botId, draft),
    delete: (botId, routineId) => ipcRenderer.invoke(channels.routinesDelete, botId, routineId),
    runNow: (botId, routineId) => ipcRenderer.invoke(channels.routinesRunNow, botId, routineId),
    runs: (botId, routineId, limit) =>
      ipcRenderer.invoke(channels.routinesRuns, botId, routineId, limit),
    onChanged: (listener) => subscribe(channels.routinesChanged, listener),
  },
  reports: {
    list: (filter) => ipcRenderer.invoke(channels.reportsList, filter),
    processNow: (id) => ipcRenderer.invoke(channels.reportsProcessNow, id),
    onChanged: (listener) => subscribe(channels.reportsChanged, listener),
  },
  bots: {
    list: () => ipcRenderer.invoke(channels.botsList),
    get: (id) => ipcRenderer.invoke(channels.botsGet, id),
    save: (bot) => ipcRenderer.invoke(channels.botsSave, bot),
    delete: (id) => ipcRenderer.invoke(channels.botsDelete, id),
    create: (draft) => ipcRenderer.invoke(channels.botsCreate, draft),
    update: (id, patch) => ipcRenderer.invoke(channels.botsUpdate, id, patch),
    makePermanent: (id) => ipcRenderer.invoke(channels.botsMakePermanent, id),
    memory: {
      get: (id) => ipcRenderer.invoke(channels.botsMemoryGet, id),
      set: (id, text) => ipcRenderer.invoke(channels.botsMemorySet, id, text),
    },
    onChanged: (listener) => subscribe(channels.botsChanged, listener),
  },
  approvals: {
    respond: (id, decision, edited) =>
      ipcRenderer.invoke(channels.approvalsRespond, id, decision, edited),
  },
  connections: { list: (refresh) => ipcRenderer.invoke(channels.connectionsList, refresh) },
  projects: {
    list: () => ipcRenderer.invoke(channels.projectsList),
    save: (draft) => ipcRenderer.invoke(channels.projectsSave, draft),
    delete: (id) => ipcRenderer.invoke(channels.projectsDelete, id),
    pickFolder: () => ipcRenderer.invoke(channels.projectsPickFolder),
    onChanged: (listener) => subscribe(channels.projectsChanged, listener),
  },
  conversations: {
    list: (botId) => ipcRenderer.invoke(channels.conversationsList, botId),
    get: (id) => ipcRenderer.invoke(channels.conversationsGet, id),
    delete: (id) => ipcRenderer.invoke(channels.conversationsDelete, id),
  },
  chat: {
    send: (botId, text, conversationId) =>
      ipcRenderer.invoke(channels.chatSend, botId, text, conversationId),
    cancel: (id) => ipcRenderer.invoke(channels.chatCancel, id),
    onEvent: (listener) => subscribe(channels.chatEvent, listener),
  },
  engines: {
    status: () => ipcRenderer.invoke(channels.enginesStatus),
    models: (engine) => ipcRenderer.invoke(channels.enginesModels, engine),
  },
  settings: {
    get: () => ipcRenderer.invoke(channels.settingsGet),
    set: (patch) => ipcRenderer.invoke(channels.settingsSet, patch),
  },
};
contextBridge.exposeInMainWorld('api', api);
