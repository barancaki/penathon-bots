import type { McpServerConfig, McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { allowsConnection, normalizeServer } from './scopes';
import { redact } from './common';

const serverSchema = z.union([
  z.looseObject({
    type: z.literal('stdio').optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.looseObject({
    type: z.enum(['http', 'sse']),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

export async function userMcpServers(workdir: string): Promise<Record<string, McpServerConfig>> {
  const file = join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
  try {
    const config = z
      .object({
        mcpServers: z.record(z.string(), z.unknown()).optional(),
        projects: z
          .record(
            z.string(),
            z.object({
              mcpServers: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .optional(),
      })
      .parse(JSON.parse(await readFile(file, 'utf8')));
    const project = Object.entries(config.projects ?? {}).find(([path]) =>
      process.platform === 'win32'
        ? resolve(path).toLowerCase() === resolve(workdir).toLowerCase()
        : resolve(path) === resolve(workdir),
    )?.[1];
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, definition] of Object.entries({
      ...config.mcpServers,
      ...project?.mcpServers,
    })) {
      if (normalizeServer(name) === 'team') continue;
      const parsed = serverSchema.safeParse(definition);
      if (parsed.success) servers[name] = parsed.data;
      // Validation errors can contain credentials from env/headers; only report the failure.
      else console.warn('Invalid Claude user MCP definition');
    }
    return servers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn('Claude user MCP configuration could not be read');
    return {};
  }
}

export function mcpSecrets(servers: Record<string, McpServerConfig>): string[] {
  return Object.values(servers).flatMap((server) =>
    [
      ...Object.entries('env' in server ? (server.env ?? {}) : {}),
      ...Object.entries('headers' in server ? (server.headers ?? {}) : {}),
    ]
      .filter(
        ([key, value]) =>
          value &&
          (/token|key|secret|password|auth|credential|bearer|cookie/i.test(key) ||
            (value.length >= 12 &&
              !/^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|true|false)$/i.test(value.trim()))),
      )
      .map(([, value]) => value),
  );
}

export async function waitForMcp(
  stream: Pick<Query, 'mcpServerStatus'>,
  timeoutMs: number,
  signal: AbortSignal,
  connections?: string[],
): Promise<McpServerStatus[]> {
  let latest: McpServerStatus[] = [];
  let stop!: () => void;
  const stopped = new Promise<null>((resolve) => {
    stop = () => resolve(null);
  });
  const timer = setTimeout(stop, timeoutMs);
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (!signal.aborted) {
      const servers = await Promise.race([stream.mcpServerStatus(), stopped]);
      if (servers === null) break;
      latest = servers;
      const selected = connections
        ? servers.filter(
            (server) => server.name !== 'team' && allowsConnection(connections, server.name),
          )
        : servers;
      const found =
        !connections ||
        connections.includes('*') ||
        connections.every((name) =>
          servers.some((server) => normalizeServer(server.name) === normalizeServer(name)),
        );
      if (selected.length && found && selected.every((server) => server.status !== 'pending'))
        break;
      let pause!: ReturnType<typeof setTimeout>;
      const elapsed = await Promise.race([
        new Promise<true>((resolve) => {
          pause = setTimeout(() => resolve(true), 500);
        }),
        stopped,
      ]);
      clearTimeout(pause);
      if (elapsed === null) break;
    }
    return latest;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

export function connectorSummary(args: Record<string, unknown>, secrets: string[]): string {
  const text = JSON.stringify(redact(args, secrets), (key, value) =>
    /password|secret|token|api[_-]?key|authorization|cookie|credential|headers|env/i.test(key)
      ? '[REDACTED]'
      : value,
  );
  return text.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]').slice(0, 300);
}
