import { translate } from '../../shared/i18n';
import type { McpServerStatus, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { stat } from 'node:fs/promises';
import type { ConnectionInfo } from '../../shared/api';
import { createPenathonServer } from '../bots/claude-tools';
import type { BotEvent } from '../../shared/events';
import type { EngineAdapter, EngineContext, RunInput } from './types';
import {
  authStatus,
  engineEnv,
  engineError,
  instructions,
  projectInstructions,
  redact,
  summary,
} from './common';
import {
  allowClaudeTool,
  deletionPathsAllowed,
  effectiveAccess,
  inScope,
  isMcpDeletion,
  isMcpAction,
  isTeamTool,
  allowsConnection,
  isChief,
  mcpPaths,
  toolPath,
  normalizeServer,
  withoutKnowledge,
} from './scopes';
import { deletionCommand, indirectDeletion } from './deletions';
import { sdkUrl } from './sdk';
import { connectorSummary, mcpSecrets, userMcpServers, waitForMcp } from './claude-mcp';

const patchSchema = z.object({
  filePath: z.string(),
  staged: z.boolean().optional(),
  structuredPatch: z.array(
    z.object({
      oldStart: z.number(),
      oldLines: z.number(),
      newStart: z.number(),
      newLines: z.number(),
      lines: z.array(z.string()),
    }),
  ),
});
export class ClaudeEngine implements EngineAdapter {
  readonly id = 'claude';
  private controllers = new Map<string, AbortController>();
  private cachedConnections: ConnectionInfo[] = [];
  private discovered = false;
  private userServers = new Set<string>();
  private probing?: Promise<ConnectionInfo[]>;
  constructor(private context: EngineContext) {}
  private cache(
    servers: (Pick<McpServerStatus, 'name' | 'source' | 'scope' | 'tools'> & { status: string })[],
    tools?: string[],
    replace = false,
  ): void {
    const known = new Map(
      this.cachedConnections.map((connection) => [connection.name, connection]),
    );
    const connections: ConnectionInfo[] = servers.map((server) => ({
      ...known.get(server.name),
      name: server.name,
      status: ['connected', 'needs-auth', 'failed', 'pending', 'disabled'].includes(
        server.status ?? '',
      )
        ? (server.status as ConnectionInfo['status'])
        : 'unknown',
      source:
        server.name === 'team'
          ? 'app'
          : server.source === 'claudeai' || server.scope === 'claudeai'
            ? 'claudeai'
            : this.userServers.has(server.name) ||
                server.source === 'user' ||
                server.scope === 'user'
              ? 'user'
              : ['project', 'local'].includes(server.source ?? server.scope ?? '')
                ? 'project'
                : (known.get(server.name)?.source ?? 'other'),
      ...(server.tools
        ? { toolCount: server.tools.length }
        : tools
          ? {
              toolCount: tools.filter((name) =>
                name.startsWith('mcp__' + normalizeServer(server.name) + '__'),
              ).length,
            }
          : {}),
    }));
    this.cachedConnections = replace
      ? connections
      : [
          ...this.cachedConnections.filter(
            (connection) => !servers.some((server) => server.name === connection.name),
          ),
          ...connections,
        ];
  }
  async connections(refresh = false): Promise<ConnectionInfo[]> {
    if (this.probing) return this.probing;
    if (!refresh && this.discovered) return structuredClone(this.cachedConnections);
    this.probing = this.probe();
    try {
      return await this.probing;
    } finally {
      this.probing = undefined;
    }
  }
  private async probe(): Promise<ConnectionInfo[]> {
    const controller = new AbortController();
    let secrets: string[] = [];
    let stream: ReturnType<(typeof import('@anthropic-ai/claude-agent-sdk'))['query']> | undefined;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const sdk: typeof import('@anthropic-ai/claude-agent-sdk') = await import(
        sdkUrl('@anthropic-ai/claude-agent-sdk')
      );
      const env = engineEnv(await this.context.auth(), 'claude');
      const userServers = await userMcpServers(this.context.workdir?.() ?? process.cwd());
      secrets = [...((await this.context.secrets?.()) ?? []), ...mcpSecrets(userServers)];
      for (const name of Object.keys(userServers)) this.userServers.add(name);
      stream = sdk.query({
        prompt: {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await hold;
              return { done: true as const, value: undefined };
            },
          }),
        },
        options: {
          cwd: this.context.workdir?.(),
          env,
          settingSources: [],
          abortController: controller,
          tools: [],
          persistSession: false,
          canUseTool: async () => ({ behavior: 'deny', message: 'Connection discovery only' }),
          mcpServers: {
            ...userServers,
            team: createPenathonServer(sdk, async () => {
              throw new Error(translate(this.context.language?.() ?? 'en', 'errors.runMissing'));
            }),
          },
        },
      });
      const servers = await waitForMcp(stream, 20000, controller.signal);
      this.cache(servers, undefined, true);
      this.discovered = true;
      return structuredClone(this.cachedConnections);
    } catch (error) {
      console.warn(
        'Claude connection discovery failed:',
        redact(error instanceof Error ? error.message : String(error), secrets),
      );
      return structuredClone(this.cachedConnections);
    } finally {
      controller.abort();
      release();
      stream?.close();
    }
  }
  async models() {
    // shortcut: offline aliases; use SDK discovery when a standalone catalog API exists.
    return [
      { id: 'default', label: translate(this.context.language?.() ?? 'en', 'engine.defaultModel') },
      ...['sonnet', 'opus', 'haiku'].map((id) => ({ id, label: id })),
    ];
  }
  async checkAuth() {
    return authStatus(await this.context.auth());
  }
  cancel(id: string): void {
    this.controllers.get(id)?.abort();
  }
  async *run(input: RunInput): AsyncIterable<BotEvent> {
    const t = (key: string) => translate(this.context.language?.() ?? 'en', key);
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) controller.abort();
    this.controllers.set(input.conversationId, controller);
    const started = Date.now();
    let session: string | undefined = input.resumeToken;
    let finished = false;
    let messageId = '';
    const streamed = new Set<string>();
    const tools = new Set<string>();
    const knowledgeDir = this.context.knowledgeDir();
    try {
      const sdk: typeof import('@anthropic-ai/claude-agent-sdk') = await import(
        sdkUrl('@anthropic-ai/claude-agent-sdk')
      );
      const projects = this.context.projects?.() ?? [];
      const bot = await withoutKnowledge(input.bot, knowledgeDir, projects);
      if (
        bot.readScope.length < input.bot.readScope.length ||
        bot.writeScope.length < input.bot.writeScope.length
      )
        yield { type: 'notice', level: 'warning', message: 'notice.knowledgePathsRemoved' };
      const access = effectiveAccess(bot, projects);
      const userServers = bot.connections.length ? await userMcpServers(bot.workdir) : {};
      for (const name of Object.keys(userServers)) this.userServers.add(name);
      const allowedServers = Object.fromEntries(
        Object.entries(userServers).filter(([name]) => allowsConnection(bot.connections, name)),
      );
      const secrets = [...((await this.context.secrets?.()) ?? []), ...mcpSecrets(userServers)];
      for (const secret of secrets) if (secret) input.addRedactionSecret?.(secret);
      const vault = isChief(bot) ? knowledgeDir : undefined;
      const server = createPenathonServer(
        sdk,
        input.callTool ??
          (async () => {
            throw new Error(t('errors.botSessionMissing'));
          }),
        isChief(bot),
      );
      const decisions = new Map<string, Promise<boolean>>();
      const authorize = async (
        name: string,
        args: Record<string, unknown>,
        id: string,
        server?: { name: string; source: string },
      ) => {
        let deletion =
          name === 'Bash' && typeof args.command === 'string'
            ? deletionCommand(args.command, bot.workdir)
            : undefined;
        if (deletion?.uncertain || (deletion && !deletion.paths.length)) return t(indirectDeletion);
        let currentAccess = access;
        const permitted = async () => {
          if (controller.signal.aborted) return false;
          try {
            const latest = this.context.getBot ? this.context.getBot(bot.id) : bot;
            currentAccess = effectiveAccess(latest, this.context.projects?.() ?? projects);
            // The running shell still uses its original cwd after the bot's workdir is trimmed.
            const currentBot = { ...latest, workdir: bot.workdir };
            const currentKnowledge = this.context.knowledgeDir();
            return (
              (await allowClaudeTool(
                currentBot,
                name,
                args,
                currentKnowledge,
                server,
                currentAccess,
              )) &&
              (!deletion ||
                (await deletionPathsAllowed(
                  currentBot,
                  deletion.paths,
                  currentAccess,
                  currentKnowledge,
                )))
            );
          } catch {
            return false;
          }
        };
        if (!(await permitted())) return t('errors.toolScopeDenied');
        const match = /^mcp__(.+?)__(.+)$/.exec(name);
        const tool = server
          ? name.slice(('mcp__' + normalizeServer(server.name) + '__').length)
          : match?.[2];
        if (tool && !isTeamTool(name, server) && isMcpAction(tool, args)) {
          const connection =
            server?.name ??
            bot.connections.find((connection) => normalizeServer(connection) === match?.[1]) ??
            match?.[1];
          const key = JSON.stringify([id, name, args]);
          let decision = decisions.get(key);
          if (!decision) {
            decision =
              input.requestApproval?.({
                title: connection + ': ' + tool,
                details: connectorSummary(args, secrets),
              }) ?? Promise.resolve(false);
            decisions.set(key, decision);
          }
          if (!(await decision)) return t('errors.connectorDenied');
          if (!(await permitted())) return t('errors.toolScopeDenied');
          return;
        }
        if (name === 'Write' && typeof args.content === 'string' && !args.content.trim()) {
          const path = toolPath(bot.workdir, String(args.file_path ?? args.path));
          try {
            if ((await stat(path)).isFile()) deletion = { paths: [path], uncertain: false };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        } else if (isMcpDeletion(name, args) && !isTeamTool(name, server)) {
          const paths = mcpPaths(args, bot.workdir);
          deletion = {
            paths,
            uncertain: false,
          };
        }
        if (!deletion) return;
        if (deletion.uncertain || !deletion.paths.length) return t(indirectDeletion);
        if (!(await permitted())) return t('errors.toolScopeDenied');
        if (
          (
            await Promise.all(deletion.paths.map((path) => inScope(path, currentAccess.fullRoots)))
          ).every(Boolean)
        )
          return;
        const key = JSON.stringify([id, name, args]);
        let decision = decisions.get(key);
        if (!decision) {
          const command =
            typeof args.command === 'string' ? args.command : name + ' ' + summary(args);
          decision =
            input.requestApproval?.({
              kind: 'file.delete',
              title: t('approval.deleteFiles'),
              details: command,
              data: { command, paths: deletion.paths },
            }) ?? Promise.resolve(false);
          decisions.set(key, decision);
        }
        if (!(await decision)) return t('errors.deletionDenied');
        if (!(await permitted())) return t('errors.toolScopeDenied');
      };
      const rules = await projectInstructions(bot, projects, knowledgeDir, secrets);
      const readOnlyRoots: string[] = [];
      for (const root of access.readRoots) {
        if (await inScope(root, access.writeRoots)) continue;
        if (
          (await Promise.all(access.writeRoots.map((path) => inScope(path, [root])))).some(Boolean)
        )
          continue;
        readOnlyRoots.push(root);
      }
      const options: Options = {
        cwd: input.bot.workdir,
        ...(input.bot.model && input.bot.model !== 'default' ? { model: input.bot.model } : {}),
        effort: input.bot.effort,
        thinking: { type: 'adaptive' },
        resume: input.resumeToken,
        abortController: controller,
        includePartialMessages: true,
        env: engineEnv(await this.context.auth(), 'claude'),
        settingSources: [],
        permissionMode: 'default',
        tools: [
          'Read',
          'Write',
          'Edit',
          'Grep',
          'Glob',
          'Bash',
          ...(bot.network ? ['WebFetch', 'WebSearch'] : []),
        ],
        mcpServers: { ...allowedServers, team: server },
        canUseTool: async (name, args, permission) => {
          const reason = await authorize(name, args, permission.toolUseID, permission.mcpServer);
          return reason
            ? { behavior: 'deny', message: reason }
            : { behavior: 'allow', updatedInput: args };
        },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: instructions(
            bot,
            vault,
            input.memory,
            this.context.profile?.(),
            this.context.team?.(),
            projects,
            rules,
          ),
        },
        additionalDirectories: [...new Set([...access.readRoots, ...(vault ? [vault] : [])])],
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hook) => {
                  if (hook.hook_event_name !== 'PreToolUse') return {};
                  const reason = await authorize(
                    hook.tool_name,
                    z.record(z.string(), z.unknown()).parse(hook.tool_input),
                    hook.tool_use_id,
                    hook.mcp_server,
                  );
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: reason ? 'deny' : 'allow',
                      permissionDecisionReason: reason ?? t('permission.withinScope'),
                    },
                  };
                },
              ],
            },
          ],
        },
        sandbox:
          process.platform === 'win32' || bot.sandbox === 'danger-full-access'
            ? undefined
            : {
                enabled: true,
                failIfUnavailable: true,
                allowUnsandboxedCommands: false,
                filesystem: {
                  allowWrite:
                    access.sandbox === 'read-only'
                      ? []
                      : [...access.writeRoots, ...(vault ? [vault] : [])],
                  denyWrite: [...readOnlyRoots, ...(knowledgeDir && !vault ? [knowledgeDir] : [])],
                  denyRead: knowledgeDir && !vault ? [knowledgeDir] : [],
                },
              },
      };
      yield { type: 'status', status: 'thinking' };
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
        await gate;
        if (!controller.signal.aborted)
          yield {
            type: 'user',
            session_id: input.resumeToken ?? '',
            parent_tool_use_id: null,
            message: { role: 'user', content: input.prompt },
          };
      };
      const stream = sdk.query({
        prompt: bot.connections.length ? prompt() : input.prompt,
        options,
      });
      if (bot.connections.length) {
        yield { type: 'notice', level: 'info', message: 'notice.connectorsWarming' };
        try {
          const servers = await waitForMcp(stream, 15000, controller.signal, bot.connections);
          if (servers.length) this.cache(servers);
        } catch (error) {
          console.warn(
            'Claude connector warmup failed:',
            redact(error instanceof Error ? error.message : String(error), secrets),
          );
        } finally {
          ready();
        }
      }
      for await (const message of stream) {
        if (controller.signal.aborted) break;
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.mcp_servers?.length) {
            this.cache(message.mcp_servers, message.tools);
            this.discovered = true;
          }
        }
        if ('session_id' in message) session = message.session_id;
        if (message.type === 'stream_event' && !message.parent_tool_use_id) {
          if (message.event.type === 'message_start') messageId = message.event.message.id;
          if (
            message.event.type === 'content_block_delta' &&
            message.event.delta.type === 'text_delta'
          ) {
            streamed.add(messageId);
            yield { type: 'message.delta', messageId, text: message.event.delta.text };
          }
        }
        if (message.type === 'assistant' && !message.parent_tool_use_id) {
          const text = message.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
          if (text) {
            if (!streamed.has(message.message.id))
              yield { type: 'message.delta', messageId: message.message.id, text };
            yield { type: 'message.done', messageId: message.message.id, text };
          }
          for (const block of message.message.content)
            if (block.type === 'tool_use' && !tools.has(block.id)) {
              tools.add(block.id);
              const file = ['file_read', 'file_write'].includes(toolKind(block.name))
                ? (block.input as { file_path?: unknown } | null)?.file_path
                : undefined;
              const command =
                toolKind(block.name) === 'command'
                  ? (block.input as { command?: unknown } | null)?.command
                  : undefined;
              yield { type: 'status', status: 'working' };
              yield {
                type: 'tool.start',
                toolId: block.id,
                kind: toolKind(block.name),
                title: block.name,
                argsSummary: typeof command === 'string' ? command : summary(block.input),
                ...(typeof file === 'string' ? { files: [file] } : {}),
              };
            }
        }
        if (message.type === 'user' && Array.isArray(message.message.content)) {
          for (const block of message.message.content)
            if (block.type === 'tool_result') {
              yield {
                type: 'tool.end',
                toolId: block.tool_use_id,
                resultSummary: summary(block.content),
                error: !!block.is_error,
              };
            }
          const patch = patchSchema.safeParse(message.tool_use_result);
          if (patch.success && !patch.data.staged && patch.data.structuredPatch.length) {
            const p = patch.data;
            yield {
              type: 'diff',
              file: p.filePath,
              unifiedDiff: `--- a/${p.filePath}\n+++ b/${p.filePath}\n${p.structuredPatch.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`).join('\n')}\n`,
            };
          }
        }
        if (message.type === 'result') {
          finished = true;
          if (message.is_error || message.subtype !== 'success') {
            yield { type: 'status', status: 'error' };
            yield engineError(
              'claude',
              message.subtype === 'success' ? message.result : message.errors.join('\n'),
              this.context.language?.() ?? 'en',
            );
          } else {
            yield { type: 'status', status: 'done' };
            yield {
              type: 'run.done',
              resumeToken: session,
              durationMs: message.duration_ms,
              usage: {
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens,
                cachedInputTokens: message.usage.cache_read_input_tokens,
                costUsd: message.total_cost_usd,
              },
            };
          }
          return;
        }
      }
      if (!finished && !controller.signal.aborted) throw new Error('errors.streamEnded');
    } catch (error) {
      if (!finished && !controller.signal.aborted) {
        yield { type: 'status', status: 'error' };
        yield engineError(
          'claude',
          error instanceof Error ? error.message : 'errors.engine',
          this.context.language?.() ?? 'en',
        );
        finished = true;
      }
    } finally {
      input.signal.removeEventListener('abort', abort);
      this.controllers.delete(input.conversationId);
    }
    if (!finished && controller.signal.aborted) {
      yield { type: 'status', status: 'idle' };
      yield {
        type: 'run.done',
        resumeToken: session,
        durationMs: Date.now() - started,
        cancelled: true,
      };
    }
  }
}
function toolKind(name: string): Extract<BotEvent, { type: 'tool.start' }>['kind'] {
  if (name.startsWith('mcp__')) return 'mcp';
  const kinds: Record<string, Extract<BotEvent, { type: 'tool.start' }>['kind']> = {
    Read: 'file_read',
    Edit: 'file_write',
    Write: 'file_write',
    Bash: 'command',
    Glob: 'search',
    Grep: 'search',
    WebSearch: 'search',
  };
  return kinds[name] ?? 'other';
}
