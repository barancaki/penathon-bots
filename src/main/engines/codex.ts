import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ThreadItem } from '@openai/codex-sdk';
import type { ConnectionInfo } from '../../shared/api';
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
import { allowsConnection, effectiveAccess, inScope, isChief, withoutKnowledge } from './scopes';
import { sdkUrl } from './sdk';
import { randomUUID } from 'node:crypto';
import { PenathonHttpServer } from '../bots/http-tools';
import { codexMcpNames } from './codex-mcp';

export class CodexEngine implements EngineAdapter {
  readonly id = 'codex';
  private controllers = new Map<string, AbortController>();
  private mcp = new PenathonHttpServer();
  constructor(private context: EngineContext) {}
  async models() {
    const defaults = [{ id: 'default', label: 'Varsayılan' }];
    try {
      const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json');
      const cache = z
        .object({
          models: z.array(
            z.object({
              slug: z.string().trim().min(1),
              display_name: z.string().optional(),
              visibility: z.string(),
            }),
          ),
        })
        .parse(JSON.parse(await readFile(file, 'utf8')));
      return [
        ...defaults,
        ...cache.models
          .filter((model) => model.visibility === 'list')
          .map((model) => ({ id: model.slug, label: model.display_name || model.slug })),
      ];
    } catch {
      return defaults;
    }
  }
  async connections(): Promise<ConnectionInfo[]> {
    const names = await codexMcpNames(
      engineEnv({ mode: 'local-cli' }, 'codex'),
      this.context.workdir?.() ?? process.cwd(),
      new AbortController().signal,
    );
    return names
      .filter((name) => name !== 'team')
      .map((name) => ({ name, source: 'codex', status: 'unknown' }));
  }
  async checkAuth() {
    return authStatus(await this.context.auth());
  }
  cancel(id: string): void {
    this.controllers.get(id)?.abort();
  }
  async close(): Promise<void> {
    await this.mcp.close();
  }
  async *run(input: RunInput): AsyncIterable<BotEvent> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) controller.abort();
    this.controllers.set(input.conversationId, controller);
    const started = Date.now();
    const texts = new Map<string, string>();
    const tools = new Set<string>();
    let resumeToken = input.resumeToken;
    let finished = false;
    let registration: Awaited<ReturnType<PenathonHttpServer['register']>> | undefined;
    try {
      const knowledgeDir = this.context.knowledgeDir();
      const projects = this.context.projects?.() ?? [];
      const bot = await withoutKnowledge(input.bot, knowledgeDir, projects);
      if (
        bot.readScope.length < input.bot.readScope.length ||
        bot.writeScope.length < input.bot.writeScope.length
      )
        yield { type: 'notice', level: 'warning', message: 'notice.knowledgePathsRemoved' };
      const access = effectiveAccess(bot, projects);
      const vault = isChief(bot) ? knowledgeDir : undefined;
      if (access.sandbox === 'workspace-write' && !(await inScope(bot.workdir, access.writeRoots)))
        throw new Error('errors.writeScope');
      const auth = await this.context.auth();
      const { Codex }: typeof import('@openai/codex-sdk') = await import(
        sdkUrl('@openai/codex-sdk')
      );
      const env = engineEnv(auth, 'codex');
      const inheritedMcp = await codexMcpNames(env, bot.workdir, controller.signal);
      if (input.callTool)
        registration = await this.mcp.register({
          botId: bot.id,
          runId: input.runId ?? randomUUID(),
          conversationId: input.conversationId,
          chief: isChief(bot),
          signal: controller.signal,
          call: input.callTool,
        });
      if (registration) input.addRedactionSecret?.(registration.token);
      // Only file-defined servers have transports to merge; built-in CLI names must stay untouched.
      const mcpEntries = inheritedMcp
        .filter((name) => !registration || name !== 'team')
        .map(
          (name) =>
            `${JSON.stringify(name)}={enabled=${name !== 'team' && allowsConnection(bot.connections, name)}}`,
        );
      // The run-local server enforces app approvals; keep them open until cancellation.
      if (registration)
        mcpEntries.unshift(
          `team={enabled=true,url=${JSON.stringify(registration.url)},bearer_token_env_var="PENATHON_MCP_TOKEN",tool_timeout_sec=2147483647,default_tools_approval_mode="approve"}`,
        );
      const codex = new Codex({
        env: {
          ...env,
          ...(registration ? { PENATHON_MCP_TOKEN: registration.token } : {}),
        },
        apiKey: auth.mode === 'api-key' ? auth.apiKey : undefined,
        // shortcut: team is reserved for this app; isolate config if an external server uses that name.
        configOverrides: [`mcp_servers={${mcpEntries.join(',')}}`],
      });
      const options = {
        workingDirectory: input.bot.workdir,
        ...(input.bot.model && input.bot.model !== 'default' ? { model: input.bot.model } : {}),
        modelReasoningEffort: input.bot.effort,
        sandboxMode: access.sandbox,
        approvalPolicy: 'never' as const,
        skipGitRepoCheck: true,
        networkAccessEnabled: bot.network,
        additionalDirectories: [...new Set([...access.writeRoots, ...(vault ? [vault] : [])])],
      };
      const thread = input.resumeToken
        ? codex.resumeThread(input.resumeToken, options)
        : codex.startThread(options);
      yield { type: 'status', status: 'thinking' };
      // limit: SDK has no per-path read deny; the prompt alone forbids reading the knowledge folder.
      // limit: Codex SDK cannot pause deletions for an app approval; Writer deletion approval is a chat instruction.
      const rules = await projectInstructions(
        bot,
        projects,
        knowledgeDir,
        (await this.context.secrets?.()) ?? [],
      );
      const stream = await thread.runStreamed(
        `${instructions(bot, vault, input.memory, this.context.profile?.(), this.context.team?.(), projects, rules)}${knowledgeDir && !vault ? '\n\nBilgi klasörüne erişme.' : ''}\n\nUser request:\n${input.prompt}`,
        { signal: controller.signal },
      );
      for await (const event of stream.events) {
        if (event.type === 'thread.started') resumeToken = event.thread_id;
        if (event.type === 'turn.started') yield { type: 'status', status: 'thinking' };
        if (
          event.type === 'item.started' ||
          event.type === 'item.updated' ||
          event.type === 'item.completed'
        ) {
          const item = event.item;
          if (item.type === 'agent_message') {
            const previous = texts.get(item.id) ?? '';
            if (item.text.startsWith(previous) && item.text.length > previous.length)
              yield {
                type: 'message.delta',
                messageId: item.id,
                text: item.text.slice(previous.length),
              };
            texts.set(item.id, item.text);
            if (event.type === 'item.completed')
              yield { type: 'message.done', messageId: item.id, text: item.text };
          } else if (item.type === 'reasoning') yield { type: 'status', status: 'thinking' };
          else if (item.type === 'error')
            yield { type: 'notice', level: 'warning', message: item.message };
          else {
            const safeItem = registration ? redact(item, [registration.token]) : item;
            const tool = describeTool(safeItem);
            if (tool && !tools.has(item.id)) {
              tools.add(item.id);
              yield { type: 'status', status: 'working' };
              yield { type: 'tool.start', toolId: item.id, ...tool };
            }
            if (tool && event.type === 'item.completed')
              yield {
                type: 'tool.end',
                toolId: item.id,
                resultSummary: toolResult(safeItem),
                error:
                  ('status' in item && item.status === 'failed') ||
                  (item.type === 'command_execution' &&
                    item.exit_code !== undefined &&
                    item.exit_code !== 0) ||
                  (item.type === 'mcp_tool_call' && !!item.error),
              };
          }
        }
        if (event.type === 'turn.completed') {
          finished = true;
          yield { type: 'status', status: 'done' };
          yield {
            type: 'run.done',
            resumeToken: thread.id ?? resumeToken,
            durationMs: Date.now() - started,
            usage: {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
              cachedInputTokens: event.usage.cached_input_tokens,
            },
          };
          return;
        }
        if (event.type === 'turn.failed' || event.type === 'error') {
          finished = true;
          yield { type: 'status', status: 'error' };
          yield engineError('codex', event.type === 'error' ? event.message : event.error.message);
          return;
        }
      }
      if (!finished && !controller.signal.aborted) throw new Error('errors.streamEnded');
    } catch (error) {
      if (!finished && !controller.signal.aborted) {
        finished = true;
        yield { type: 'status', status: 'error' };
        yield engineError('codex', error instanceof Error ? error.message : 'errors.engine');
      }
    } finally {
      registration?.revoke();
      input.signal.removeEventListener('abort', abort);
      this.controllers.delete(input.conversationId);
    }
    if (!finished && controller.signal.aborted) {
      yield { type: 'status', status: 'idle' };
      yield { type: 'run.done', resumeToken, durationMs: Date.now() - started, cancelled: true };
    }
  }
}
function describeTool(
  item: ThreadItem,
):
  | Pick<Extract<BotEvent, { type: 'tool.start' }>, 'kind' | 'title' | 'argsSummary' | 'files'>
  | undefined {
  switch (item.type) {
    case 'command_execution':
      return { kind: 'command', title: 'command', argsSummary: item.command };
    case 'file_change':
      return {
        kind: 'file_write',
        title: 'file_change',
        argsSummary: summary(item.changes),
        files: item.changes.map((change) => change.path),
      };
    case 'web_search':
      return { kind: 'search', title: 'web_search', argsSummary: item.query };
    case 'mcp_tool_call':
      return {
        kind: 'mcp',
        title: `${item.server}/${item.tool}`,
        argsSummary: summary(item.arguments),
      };
    default:
      return undefined;
  }
}
function toolResult(item: ThreadItem): string {
  if (item.type === 'command_execution') return summary(item.aggregated_output);
  if (item.type === 'mcp_tool_call') return summary(item.error?.message ?? item.result);
  if (item.type === 'file_change') return summary(item.changes);
  return summary(item);
}
