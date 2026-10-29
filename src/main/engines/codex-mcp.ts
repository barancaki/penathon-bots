import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const key = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)`;
const mcp = String.raw`(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
const header = new RegExp(String.raw`^\s*\[\s*${mcp}\s*\.\s*(${key})\s*(?:\]|\.)`);
const dotted = new RegExp(String.raw`^\s*${mcp}\s*\.\s*(${key})\s*\.`);

export async function codexMcpNames(
  env: Record<string, string>,
  cwd: string,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const files = new Set([
      resolve(cwd, env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
    ]);
    for (let directory = resolve(cwd); ; directory = dirname(directory)) {
      files.add(join(directory, '.codex', 'config.toml'));
      if (directory === dirname(directory)) break;
    }
    const names = new Set<string>();
    for (const file of files) {
      let source: string;
      try {
        source = await readFile(file, { encoding: 'utf8', signal });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      // Ignore comments and multiline examples without stripping quoted server names.
      source = source.replace(
        /"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|#[^\r\n]*/g,
        (value) =>
          value.startsWith('#') || value.startsWith('"""') || value.startsWith("'''")
            ? value.replace(/[^\r\n]/g, ' ')
            : value,
      );
      let inRoot = true;
      // shortcut: literal table/root dotted keys only; use a TOML parser for other declaration forms.
      for (const line of source.split(/\r?\n/)) {
        const table = /^\s*\[/.test(line);
        if (table) inRoot = false;
        const match = (table ? header : inRoot ? dotted : undefined)?.exec(line);
        if (!match) continue;
        const name = match[1];
        names.add(
          name.startsWith('"')
            ? (JSON.parse(name) as string)
            : name.startsWith("'")
              ? name.slice(1, -1)
              : name,
        );
      }
    }
    return [...names];
  } catch {
    throw new Error('Codex MCP configuration could not be read.');
  }
}
