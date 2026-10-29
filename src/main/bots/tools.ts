import { translate } from '../../shared/i18n';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { botDraftSchema, botPatchSchema, botSchema } from '../../shared/bots';
import type { BotEvent } from '../../shared/events';
import type { BotStore } from './store';
import type { Repository } from '../db';
import type { ChatService } from '../chat';
import type { Approvals } from './approvals';
import { isChief } from '../engines/scopes';
import { accessLevelSchema, projectDraftSchema, projectSchema } from '../../shared/projects';
import type { ProjectStore } from '../projects';
import {
  routineDraftSchema,
  routineName,
  routinePatchSchema,
  routinePrompt,
  routineSchema,
} from '../../shared/routines';
import { roomDraftSchema, roomTextSchema } from '../../shared/room-helpers';

const id = botSchema.shape.id;
const task = z.string().trim().min(1).max(100_000);
export const toolSchemas = {
  post_to_room: z.object({ roomId: z.string().uuid(), text: roomTextSchema }).strict(),
  create_room: roomDraftSchema,
  list_routines: z.object({}).strict(),
  create_routine: routineDraftSchema
    .omit({ id: true, enabled: true })
    .extend({ botId: id.optional() })
    .strict(),
  update_routine: z
    .object({ routineId: routineSchema.shape.id, patch: routinePatchSchema, botId: id.optional() })
    .strict(),
  delete_routine: z.object({ routineId: routineSchema.shape.id, botId: id.optional() }).strict(),
  run_routine_now: z.object({ routineId: routineSchema.shape.id, botId: id.optional() }).strict(),
  report_to_chief: z
    .object({
      summary: z.string().trim().min(1).max(20_000),
      decisions: z.array(z.string().max(4000)).max(100).default([]),
      files: z.array(z.string().max(4000)).max(500).default([]),
      open: z.array(z.string().max(4000)).max(100).default([]),
    })
    .strict(),
  list_reports: z.object({ pending: z.boolean().optional() }).strict(),
  mark_reports_processed: z
    .object({
      ids: z.array(z.string().min(1).max(100)).min(1).max(500),
      into: z.string().trim().min(1).max(4000),
    })
    .strict(),
  list_bots: z.object({}).strict(),
  list_projects: z.object({}).strict(),
  create_project: projectDraftSchema.omit({ id: true }),
  grant_project: z
    .object({ botId: id, projectId: projectSchema.shape.id, level: accessLevelSchema.nullable() })
    .strict(),
  create_bot: z.object({ draft: botDraftSchema }).strict(),
  update_bot: z.object({ id, patch: botPatchSchema }).strict(),
  spawn_temp_bot: botDraftSchema
    .omit({ avatar: true, persona: true, parent: true, temporary: true })
    .partial({ engine: true, instructions: true })
    .extend({ task })
    .strict(),
  delegate_to_bot: z.object({ id, task }).strict(),
  remember: z.object({ text: z.string().trim().min(1).max(8000) }).strict(),
  forget: z.object({ match: z.string().trim().min(1).max(8000) }).strict(),
  search_history: z
    .object({
      query: z.string().trim().min(1).max(1000),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
};
const descriptions: Record<keyof typeof toolSchemas, string> = {
  post_to_room: 'Post a message to a room you belong to; member mentions continue the room chain.',
  create_room: 'Chief only: create a team room with existing bot ids, without approval.',
  list_routines: 'List your routines; Chief sees all bots.',
  create_routine:
    'Propose a routine named after the work; schedule in local time; wait for user approval.',
  update_routine:
    'Propose changes to a routine and wait for approval. System routines allow only enabled, schedule, prompt.',
  delete_routine: 'Delete a non-system routine after user approval.',
  run_routine_now: 'Run an accessible idle bot routine now, without approval.',
  report_to_chief:
    'Non-Chief: report completed work, important decisions, changed files and open questions to Chief.',
  list_reports: 'Chief only: list work reports, optionally pending only.',
  mark_reports_processed:
    'Chief only: after writing reports into the knowledge folder or an authorized writable project note, mark them processed with the destination path.',
  list_bots: 'List accessible bots and current activity; Chief also sees memory previews.',
  list_projects: 'List projects and folders accessible to you; Chief sees all.',
  create_project: 'Chief: propose a named group of folders and wait for user approval.',
  grant_project:
    'Grant, lower or remove project access for a bot after user approval; null removes access.',
  create_bot:
    'Propose a permanent bot and wait for user approval. Set network: true for research/connection work; the parent must allow network access.',
  update_bot:
    'Propose changes to an accessible bot and wait for user approval. Set network: true for research/connection work; the parent must allow network access.',
  spawn_temp_bot:
    'Create a temporary child, run the task in a new conversation, return its answer.',
  delegate_to_bot:
    'Run a task on an accessible idle bot in a new conversation and return its answer.',
  remember: 'Append a short note to your persistent memory.',
  forget: 'Remove memory lines containing the given literal text.',
  search_history: 'Search your past messages; Chief searches the whole team.',
};
export function penathonTools(chief: boolean) {
  return Object.entries(toolSchemas)
    .filter(([name]) =>
      chief
        ? name !== 'report_to_chief'
        : !['list_reports', 'mark_reports_processed', 'create_room'].includes(name),
    )
    .map(([name, schema]) => ({
      name,
      schema,
      description: descriptions[name as keyof typeof toolSchemas],
    }));
}
export async function penathonResult(
  call: (name: string, args: unknown) => Promise<unknown>,
  name: string,
  args: unknown,
) {
  try {
    const result = await call(name, args);
    return {
      content: [
        {
          type: 'text' as const,
          text: typeof result === 'string' ? result : JSON.stringify(result),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: error instanceof Error ? error.message : translate('en', 'errors.operationFailed'),
        },
      ],
    };
  }
}
export type Execution = {
  rootRunId?: string;
  depth: number;
  budget: { spawned: number };
  signal: AbortSignal;
  reportId?: string;
  room?: { roomId: string; depth: number; chain: { responses: number; rootRunId?: string } };
};
export class BotTools {
  constructor(
    private store: BotStore,
    private db: Repository,
    private chat: ChatService,
    private approvals: Approvals,
    private callerId: string,
    private runId: string,
    private execution: Execution,
    private emit: (event: BotEvent) => void,
    private projects?: ProjectStore,
  ) {}
  private text(key: string, params?: Record<string, string | number>): string {
    return translate(this.chat.language(), key, params);
  }
  private checkChild(): void {
    if (this.execution.depth >= 3) throw new Error('errors.delegationDepth');
  }
  private card(kind: string, data: Record<string, unknown>): void {
    this.emit({ type: 'card', cardId: randomUUID(), kind, data });
  }
  async call(name: string, args: unknown): Promise<unknown> {
    try {
      return await this.execute(name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'errors.operationFailed';
      throw new Error(message.replace(/^errors\.[a-zA-Z]+/, (key) => this.text(key)));
    }
  }
  private async execute(name: string, args: unknown): Promise<unknown> {
    if (this.execution.signal.aborted) throw new Error('errors.runEnded');
    const caller = this.store.get(this.callerId);
    switch (name) {
      case 'create_room': {
        if (!isChief(caller)) throw new Error('errors.chiefOnly');
        return this.chat.rooms.create(toolSchemas.create_room.parse(args));
      }
      case 'post_to_room': {
        const { roomId, text } = toolSchemas.post_to_room.parse(args);
        return this.chat.rooms.post(caller.id, roomId, text, this.runId, this.execution);
      }
      case 'list_routines': {
        toolSchemas.list_routines.parse(args);
        return (isChief(caller) ? this.store.list() : [caller]).flatMap((bot) =>
          this.chat.routines.list(bot.id),
        );
      }
      case 'create_routine': {
        const { botId = caller.id, ...draft } = toolSchemas.create_routine.parse(args);
        const routine = this.store.previewRoutine(botId, { ...draft, enabled: true }, caller.id);
        return (
          (await this.approvals.request(
            this.runId,
            {
              kind: 'routine.create',
              title: this.text('approval.createRoutine', {
                name: this.text(routineName(routine, botId)),
              }),
              details: this.text(routinePrompt(routine, botId)),
              data: { botId, routine },
            },
            this.execution.signal,
            this.emit,
            async (edited) => {
              if (edited !== undefined) {
                const next = this.store.previewRoutine(
                  botId,
                  routineDraftSchema.omit({ id: true }).parse(edited),
                  caller.id,
                );
                return this.store.createRoutine(botId, { ...next, id: routine.id }, caller.id);
              }
              return this.store.createRoutine(botId, routine, caller.id);
            },
          )) ?? this.text('approval.cancelled')
        );
      }
      case 'update_routine': {
        const { botId = caller.id, routineId, patch } = toolSchemas.update_routine.parse(args);
        if (!this.store.canManage(caller.id, botId)) throw new Error('errors.routinePermission');
        const before = this.store.get(botId).routines.find((routine) => routine.id === routineId);
        if (!before) throw new Error('errors.routineMissing');
        if (
          before.system &&
          Object.keys(patch).some((key) => !['enabled', 'schedule', 'prompt'].includes(key))
        )
          throw new Error('errors.systemRoutineProtected');
        const draft = {
          id: before.id,
          name: before.name,
          schedule: before.schedule,
          prompt: before.prompt,
          enabled: before.enabled,
          model: before.model,
        };
        const routine = this.store.previewRoutine(botId, { ...draft, ...patch }, caller.id);
        return (
          (await this.approvals.request(
            this.runId,
            {
              kind: 'routine.update',
              title: this.text('approval.updateRoutine', {
                name: this.text(routineName(routine, botId)),
              }),
              details: this.text(routinePrompt(routine, botId)),
              data: { botId, routine, before },
            },
            this.execution.signal,
            this.emit,
            async (edited) => {
              const changes = edited === undefined ? patch : routinePatchSchema.parse(edited);
              if (
                before.system &&
                Object.keys(changes).some((key) => !['enabled', 'schedule', 'prompt'].includes(key))
              )
                throw new Error('errors.systemRoutineProtected');
              return this.store.saveRoutine(botId, { ...draft, ...changes }, caller.id, before);
            },
          )) ?? this.text('approval.cancelled')
        );
      }
      case 'delete_routine': {
        const { botId = caller.id, routineId } = toolSchemas.delete_routine.parse(args);
        if (!this.store.canManage(caller.id, botId)) throw new Error('errors.routinePermission');
        const before = this.store.get(botId).routines.find((routine) => routine.id === routineId);
        if (!before || before.system) throw new Error('errors.routineProtected');
        return (
          (await this.approvals.request(
            this.runId,
            {
              title: this.text('approval.deleteRoutine', { name: before.name }),
              details: before.prompt,
              data: { botId, routine: before },
            },
            this.execution.signal,
            this.emit,
            async (edited) => {
              if (edited !== undefined) throw new Error('errors.approvalNotEditable');
              await this.store.deleteRoutine(botId, routineId, caller.id, before);
              this.card('work.changed', { kind: 'routine.delete', botId });
              return this.text('tools.routineDeleted');
            },
          )) ?? this.text('approval.cancelled')
        );
      }
      case 'run_routine_now': {
        const { botId: requested, routineId } = toolSchemas.run_routine_now.parse(args);
        const targets = this.store
          .list()
          .filter(
            (bot) =>
              this.store.canManage(caller.id, bot.id) &&
              bot.routines.some((routine) => routine.id === routineId),
          );
        const botId =
          requested ??
          targets.find((bot) => bot.id === caller.id)?.id ??
          (targets.length === 1 ? targets[0].id : undefined);
        if (!botId) throw new Error('errors.routineAmbiguous');
        if (!this.store.canManage(caller.id, botId)) throw new Error('errors.routinePermission');
        return this.chat.routines.runNow(botId, routineId, this.execution);
      }
      case 'report_to_chief': {
        if (isChief(caller)) throw new Error('errors.chiefReportSelf');
        return this.chat.reportToChief(
          caller.id,
          this.runId,
          toolSchemas.report_to_chief.parse(args),
        );
      }
      case 'list_reports': {
        if (!isChief(caller)) throw new Error('errors.chiefOnly');
        const filter = toolSchemas.list_reports.parse(args);
        if (this.execution.reportId) {
          const report = this.db.report(this.execution.reportId);
          return filter.pending === undefined || !report.processedAt === filter.pending
            ? [report]
            : [];
        }
        return this.db.reports({ ...filter, limit: 500 });
      }
      case 'mark_reports_processed': {
        if (!isChief(caller) || !this.store.hasReportDestination())
          throw new Error('errors.reportDestinationMissing');
        const { ids, into } = toolSchemas.mark_reports_processed.parse(args);
        if (this.execution.reportId && ids.some((id) => id !== this.execution.reportId))
          throw new Error('errors.selectedReportOnly');
        const destination = await this.store.validateReportDestination(into);
        await this.chat.markReportsProcessed(ids, destination);
        return this.text('tools.reportsProcessed');
      }
      case 'list_bots': {
        toolSchemas.list_bots.parse(args);
        const bots = this.store.list().filter((bot) => this.store.canManage(this.callerId, bot.id));
        return Promise.all(
          bots.map(async (bot) => ({
            id: bot.id,
            name: bot.name,
            role: bot.role,
            engine: bot.engine,
            model: bot.model,
            parent: bot.parent,
            temporary: bot.temporary,
            projects: bot.projects,
            active: this.chat.isBotActive(bot.id),
            ...(isChief(caller)
              ? { memory: (await this.store.getMemory(bot.id)).slice(0, 300) }
              : {}),
          })),
        );
      }
      case 'list_projects': {
        toolSchemas.list_projects.parse(args);
        return (this.projects?.list() ?? []).flatMap((project) => {
          const grant = caller.projects.find((grant) => grant.project === project.id);
          return isChief(caller) || grant
            ? [{ ...project, ...(grant ? { level: grant.level } : {}) }]
            : [];
        });
      }
      case 'create_project': {
        if (!isChief(caller)) throw new Error('errors.chiefCreateProject');
        if (!this.projects) throw new Error('errors.projectStoreUnavailable');
        const draft = toolSchemas.create_project.parse(args);
        const preview = await this.projects.preview(draft);
        return (
          (await this.approvals.request(
            this.runId,
            {
              title: this.text('approval.createProject', { name: preview.name }),
              details: [preview.description, ...preview.folders].filter(Boolean).join('\n'),
            },
            this.execution.signal,
            this.emit,
            async (edited) => {
              if (edited !== undefined) throw new Error('errors.approvalNotEditable');
              if (!isChief(this.store.get(this.callerId)))
                throw new Error('errors.chiefCreateProject');
              return this.projects!.save({
                name: preview.name,
                description: preview.description,
                folders: preview.folders,
              });
            },
          )) ?? this.text('approval.cancelled')
        );
      }
      case 'grant_project': {
        const { botId, projectId, level } = toolSchemas.grant_project.parse(args);
        await this.store.checkProjectGrant(this.callerId, botId, projectId, level);
        const project = this.projects?.list().find((project) => project.id === projectId);
        if (!project) throw new Error('errors.projectMissing');
        const before =
          this.store.get(botId).projects.find((grant) => grant.project === projectId)?.level ??
          null;
        return (
          (await this.approvals.request(
            this.runId,
            {
              kind: 'project.grant',
              title: this.text('approval.grantProject', { name: project.name }),
              details:
                this.store.get(botId).name + ': ' + (level ?? this.text('approval.removeAccess')),
              data: { botId, project, level, before },
            },
            this.execution.signal,
            this.emit,
            async (edited) => {
              if (edited !== undefined) throw new Error('errors.approvalNotEditable');
              if (
                JSON.stringify(this.projects?.list().find((value) => value.id === projectId)) !==
                  JSON.stringify(project) ||
                (this.store.get(botId).projects.find((grant) => grant.project === projectId)
                  ?.level ?? null) !== before
              )
                throw new Error('errors.projectApprovalChanged');
              return this.store.grantProject(this.callerId, botId, projectId, level);
            },
          )) ?? this.text('approval.cancelled')
        );
      }
      case 'create_bot': {
        const { draft } = toolSchemas.create_bot.parse(args);
        const bot = await this.store.draft({ ...draft, temporary: false }, this.callerId);
        const result = await this.approvals.request(
          this.runId,
          {
            kind: 'bot.create',
            title: this.text('approval.createBot', { name: bot.name }),
            details: bot.role,
            data: { bot },
          },
          this.execution.signal,
          this.emit,
          async (edited) => {
            if (edited === undefined) return this.store.create(bot, this.callerId);
            const next = botDraftSchema.parse(edited);
            return this.store.create(
              { ...next, avatar: next.avatar ?? bot.avatar, temporary: false },
              this.callerId,
            );
          },
        );
        return result ?? this.text('approval.cancelled');
      }
      case 'update_bot': {
        const { id, patch } = toolSchemas.update_bot.parse(args);
        const beforeBot = this.store.get(id);
        const afterBot = await this.store.previewUpdate(id, patch, this.callerId);
        const keys = (Object.keys(patch) as (keyof typeof patch)[]).filter(
          (key) => JSON.stringify(beforeBot[key]) !== JSON.stringify(afterBot[key]),
        );
        const before = Object.fromEntries(keys.map((key) => [key, beforeBot[key]]));
        const after = Object.fromEntries(keys.map((key) => [key, afterBot[key]]));
        if (!keys.length) return beforeBot;
        const result = await this.approvals.request(
          this.runId,
          {
            kind: 'bot.update',
            title: this.text('approval.updateBot', { name: beforeBot.name }),
            details: keys.join(', '),
            data: { botId: id, before, after },
          },
          this.execution.signal,
          this.emit,
          async (edited) => {
            if (JSON.stringify(this.store.get(id)) !== JSON.stringify(beforeBot))
              throw new Error('errors.botApprovalChanged');
            return this.store.update(
              id,
              botPatchSchema.parse(edited === undefined ? after : edited),
              this.callerId,
            );
          },
        );
        return result ?? this.text('approval.cancelled');
      }
      case 'spawn_temp_bot': {
        this.checkChild();
        const { task, ...draft } = toolSchemas.spawn_temp_bot.parse(args);
        if (this.execution.budget.spawned >= 5) throw new Error('errors.spawnLimit');
        this.execution.budget.spawned++;
        const bot = await this.store.create(
          {
            ...draft,
            engine: draft.engine ?? caller.engine,
            instructions: draft.instructions ?? task,
            parent: caller.id,
            temporary: true,
          },
          caller.id,
        );
        this.card('bot.spawned', { botId: bot.id, name: bot.name, task, temporary: true });
        return this.chat.delegate(bot.id, task, this.execution);
      }
      case 'delegate_to_bot': {
        this.checkChild();
        const { id, task } = toolSchemas.delegate_to_bot.parse(args);
        if (id === caller.id) throw new Error('errors.selfDelegation');
        if (!this.store.canManage(caller.id, id)) throw new Error('errors.delegationDenied');
        const bot = this.store.get(id);
        try {
          const result = await this.chat.delegate(id, task, this.execution);
          this.card('bot.delegated', { botId: id, name: bot.name, task, result });
          return result;
        } catch (error) {
          this.card('bot.delegated', {
            botId: id,
            name: bot.name,
            task,
            error: (error instanceof Error ? error.message : 'errors.operationFailed').replace(
              /^errors\.[a-zA-Z]+/,
              (key) => this.text(key),
            ),
          });
          throw error;
        }
      }
      case 'remember': {
        const { text } = toolSchemas.remember.parse(args);
        await this.store.changeMemory(
          caller.id,
          (memory) => [memory.trimEnd(), text].filter(Boolean).join('\n') + '\n',
        );
        this.card('memory', { action: 'remember', text });
        return this.text('tools.remembered');
      }
      case 'forget': {
        const { match } = toolSchemas.forget.parse(args);
        await this.store.changeMemory(caller.id, (memory) =>
          memory
            .split('\n')
            .filter((line) => !line.toLocaleLowerCase().includes(match.toLocaleLowerCase()))
            .join('\n'),
        );
        this.card('memory', { action: 'forget', text: match });
        return this.text('tools.forgotten');
      }
      case 'search_history': {
        const { query, limit } = toolSchemas.search_history.parse(args);
        return this.db.search(query, isChief(caller) ? undefined : caller.id, limit).map((hit) => ({
          ...hit,
          botName: this.store.list().find((bot) => bot.id === hit.botId)?.name ?? hit.botId,
        }));
      }
      default:
        throw new Error('errors.unknownTeamTool');
    }
  }
}
