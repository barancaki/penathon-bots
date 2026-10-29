import { ipcMain, dialog, BrowserWindow } from 'electron';
import { z } from 'zod';
import { channels, type AppView } from '../shared/api';
import { botSchema, botDraftSchema, botPatchSchema, engineSchema } from '../shared/bots';
import { settingsPatchSchema, telegramOptionsSchema } from '../shared/settings';
import type { TelegramBridge } from './telegram';
import type { BotStore } from './bots/store';
import type { Repository } from './db';
import type { ChatService } from './chat';
import type { EngineAdapter } from './engines/types';
import type { EngineId } from '../shared/bots';
import type { Settings } from '../shared/settings';
import type { SettingsStore } from './settings';
import { BotScopeError } from './engines/scopes';
import { projectDraftSchema } from '../shared/projects';
import type { ProjectStore } from './projects';
import { routineDraftSchema, routinePatchSchema } from '../shared/routines';
import { roomDraftSchema, roomPatchSchema, roomTextSchema } from '../shared/room-helpers';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export function registerIpc(services: {
  window(): BrowserWindow | undefined;
  bots(): BotStore;
  db: Repository;
  chat: ChatService;
  engines: Record<EngineId, EngineAdapter>;
  settings: SettingsStore;
  projects: ProjectStore;
  telegram: TelegramBridge;
  app: { setView(view: AppView): void; quit(): void };
  setSettings(patch: z.infer<typeof settingsPatchSchema>): Promise<Settings>;
}): void {
  const handle = (channel: string, schema: z.ZodType, action: (args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const window = services.window();
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('errors.ipcDenied');
      const result = schema.safeParse(args);
      if (!result.success) throw new Error('errors.invalidInput');
      try {
        return await action(result.data as unknown[]);
      } catch (error) {
        throw new Error(
          error instanceof BotScopeError ||
            (error instanceof Error && /^errors\.[a-zA-Z]+$/.test(error.message))
            ? error.message
            : 'errors.operationFailed',
        );
      }
    });
  };
  const viewSchema = z
    .object({ botId: id.optional(), conversationId: id.optional(), roomId: id.optional() })
    .strict();
  handle(channels.appSetView, z.tuple([viewSchema]), (args) =>
    services.app.setView(viewSchema.parse(args[0])),
  );
  handle(channels.appActivity, z.tuple([]), () => services.chat.activity());
  handle(channels.appQuit, z.tuple([]), () => services.app.quit());
  handle(channels.botsList, z.tuple([]), () => services.bots().list());
  handle(channels.telegramStatus, z.tuple([]), () => services.telegram.status());
  handle(
    channels.telegramSetToken,
    z.tuple([z.string().trim().min(1).max(8192).nullable()]),
    (args) => services.telegram.setToken(args[0] as string | null),
  );
  handle(channels.telegramStartPairing, z.tuple([]), () => services.telegram.startPairing());
  handle(channels.telegramUnpair, z.tuple([]), () => services.telegram.unpair());
  handle(channels.telegramSetOptions, z.tuple([telegramOptionsSchema]), (args) =>
    services.telegram.setOptions(telegramOptionsSchema.parse(args[0])),
  );
  const limit = z.number().int().min(1).max(500).optional();
  handle(channels.roomsList, z.tuple([]), () => services.chat.rooms.list());
  handle(channels.roomsCreate, z.tuple([roomDraftSchema]), (args) =>
    services.chat.rooms.create(args[0]),
  );
  handle(channels.roomsUpdate, z.tuple([id, roomPatchSchema]), (args) =>
    services.chat.rooms.update(args[0] as string, args[1]),
  );
  handle(channels.roomsDelete, z.tuple([id]), (args) =>
    services.chat.rooms.delete(args[0] as string),
  );
  handle(channels.roomsMessages, z.tuple([id, limit]), (args) =>
    services.chat.rooms.messages(args[0] as string, args[1] as number | undefined),
  );
  handle(channels.roomsSend, z.tuple([id, roomTextSchema]), (args) =>
    services.chat.rooms.send(args[0] as string, args[1] as string),
  );
  handle(channels.roomsCancel, z.tuple([id]), (args) =>
    services.chat.rooms.cancel(args[0] as string),
  );
  handle(channels.roomsActivity, z.tuple([id]), (args) =>
    services.chat.rooms.activity(args[0] as string),
  );
  handle(channels.routinesList, z.tuple([id]), (args) =>
    services.chat.routines.list(args[0] as string),
  );
  handle(channels.routinesSave, z.tuple([id, routineDraftSchema]), (args) =>
    services.chat.routines.save(args[0] as string, args[1]),
  );
  handle(channels.routinesDelete, z.tuple([id, id]), (args) =>
    services.chat.routines.delete(args[0] as string, args[1] as string),
  );
  handle(channels.routinesRunNow, z.tuple([id, id]), (args) =>
    services.chat.routines.runNow(args[0] as string, args[1] as string),
  );
  handle(channels.routinesRuns, z.tuple([id, id, limit]), (args) => {
    services.bots().get(args[0] as string);
    return services.db.routineRuns(
      args[0] as string,
      args[1] as string,
      args[2] as number | undefined,
    );
  });
  handle(
    channels.reportsList,
    z.tuple([
      z
        .object({ pending: z.boolean().optional(), botId: id.optional(), limit })
        .strict()
        .optional(),
    ]),
    (args) =>
      services.db.reports(
        args[0] as { pending?: boolean; botId?: string; limit?: number } | undefined,
      ),
  );
  handle(channels.reportsProcessNow, z.tuple([id]), (args) =>
    services.chat.processReportNow(args[0] as string),
  );
  handle(channels.botsGet, z.tuple([id]), (args) => services.bots().get(args[0] as string));
  handle(channels.botsSave, z.tuple([botSchema]), (args) =>
    services.bots().save(botSchema.parse(args[0])),
  );
  handle(channels.botsDelete, z.tuple([id]), async (args) => {
    const ids = [
      args[0] as string,
      ...services
        .bots()
        .descendants(args[0] as string)
        .map((bot) => bot.id),
    ];
    if (ids.some((botId) => services.chat.isBotActive(botId))) throw new Error('errors.botBusy');
    await services.bots().delete(args[0] as string);
    for (const room of services.chat.rooms.list()) {
      const members = room.members.filter((botId) => !ids.includes(botId));
      if (members.length === room.members.length) continue;
      if (members.length) await services.chat.rooms.update(room.id, { members });
      else await services.chat.rooms.delete(room.id);
    }
  });
  handle(channels.botsCreate, z.tuple([botDraftSchema]), (args) =>
    services.bots().create(botDraftSchema.parse(args[0])),
  );
  handle(channels.botsUpdate, z.tuple([id, botPatchSchema]), (args) =>
    services.bots().update(args[0] as string, botPatchSchema.parse(args[1])),
  );
  handle(channels.botsMakePermanent, z.tuple([id]), (args) =>
    services.bots().update(args[0] as string, { temporary: false }),
  );
  handle(channels.botsMemoryGet, z.tuple([id]), (args) =>
    services.bots().getMemory(args[0] as string),
  );
  handle(channels.botsMemorySet, z.tuple([id, z.string().max(200_000)]), (args) =>
    services.bots().setMemory(args[0] as string, args[1] as string),
  );
  handle(
    channels.approvalsRespond,
    z.tuple([
      id,
      z.enum(['approved', 'rejected']),
      z.union([botDraftSchema, botPatchSchema, routinePatchSchema]).optional(),
    ]),
    (args) =>
      services.chat.approvals.respond(
        args[0] as string,
        args[1] as 'approved' | 'rejected',
        args[2],
      ),
  );
  handle(channels.connectionsList, z.tuple([z.boolean().optional()]), async (args) =>
    (
      await Promise.all([
        services.engines.claude.connections?.(args[0] as boolean | undefined) ?? [],
        services.engines.codex?.connections?.(args[0] as boolean | undefined) ?? [],
      ])
    ).flat(),
  );
  handle(channels.projectsList, z.tuple([]), () => services.projects.list());
  handle(channels.projectsSave, z.tuple([projectDraftSchema]), (args) =>
    services.projects.save(projectDraftSchema.parse(args[0])),
  );
  handle(channels.projectsDelete, z.tuple([id]), (args) =>
    services.projects.delete(args[0] as string),
  );
  handle(channels.projectsPickFolder, z.tuple([]), async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? services.window();
    if (!owner) throw new Error('errors.ipcDenied');
    const result = await dialog.showOpenDialog(owner, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(channels.conversationsList, z.tuple([id]), (args) => services.db.list(args[0] as string));
  handle(channels.conversationsGet, z.tuple([id]), (args) => services.db.get(args[0] as string));
  handle(channels.conversationsDelete, z.tuple([id]), (args) =>
    services.chat.delete(args[0] as string),
  );
  handle(
    channels.chatSend,
    z.tuple([id, z.string().trim().min(1).max(100_000), id.optional()]),
    (args) =>
      services.chat.send(args[0] as string, args[1] as string, args[2] as string | undefined),
  );
  handle(channels.chatCancel, z.tuple([id]), (args) => services.chat.cancel(args[0] as string));
  handle(channels.enginesStatus, z.tuple([]), async () => ({
    claude: await services.engines.claude.checkAuth(),
    codex: await services.engines.codex.checkAuth(),
  }));
  handle(channels.enginesModels, z.tuple([engineSchema]), (args) =>
    services.engines[engineSchema.parse(args[0])].models(),
  );
  handle(channels.settingsGet, z.tuple([]), () => services.settings.get());
  handle(channels.settingsSet, z.tuple([settingsPatchSchema]), (args) =>
    services.setSettings(settingsPatchSchema.parse(args[0])),
  );
}
