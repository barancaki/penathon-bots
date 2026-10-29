import type { Bot, EngineId } from '../../shared/bots';
import type { BotEvent } from '../../shared/events';
import type { Settings } from '../../shared/settings';
import type { AuthStatus, ConnectionInfo, EngineModel } from '../../shared/api';
import type { Project } from '../../shared/projects';

export type RunInput = {
  bot: Bot;
  conversationId: string;
  runId?: string;
  prompt: string;
  resumeToken?: string;
  memory?: string;
  addRedactionSecret?: (secret: string) => void;
  callTool?: (name: string, args: unknown) => Promise<unknown>;
  requestApproval?: (
    request: Omit<Extract<BotEvent, { type: 'approval.request' }>, 'type' | 'approvalId'>,
  ) => Promise<boolean>;
  signal: AbortSignal;
};
export type EngineAuth = { mode: 'local-cli' | 'api-key'; apiKey?: string };
export type EngineContext = {
  auth(): EngineAuth | Promise<EngineAuth>;
  knowledgeDir(): string | undefined;
  profile?(): Settings['profile'];
  team?(): Pick<Bot, 'name' | 'role'>[];
  workdir?(): string;
  projects?(): Project[];
  getBot?(id: string): Bot;
  secrets?(): string[] | Promise<string[]>;
};
export interface EngineAdapter {
  readonly id: EngineId;
  run(input: RunInput): AsyncIterable<BotEvent>;
  cancel(conversationId: string): void;
  close?(): Promise<void>;
  models(): Promise<EngineModel[]>;
  checkAuth(): Promise<AuthStatus>;
  connections?(refresh?: boolean): Promise<ConnectionInfo[]>;
}
