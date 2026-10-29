import { beforeEach, expect, it, vi } from 'vitest';
import { dirname, join, parse, resolve } from 'node:path';
import { codexMcpNames } from '../src/main/engines/codex-mcp';

const mock = vi.hoisted(() => ({ readFile: vi.fn(), homedir: vi.fn(), execFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: mock.readFile }));
vi.mock('node:os', () => ({ homedir: mock.homedir }));
vi.mock('node:child_process', () => ({ execFile: mock.execFile }));
const home = resolve('.tmp/mcp/home');
const cwd = resolve('.tmp/mcp/project/nested');
const env = { CODEX_HOME: join(home, 'custom-codex') };
let files: Map<string, string>;
const discover = (environment: Record<string, string> = env) =>
  codexMcpNames(environment, cwd, new AbortController().signal);

beforeEach(() => {
  vi.clearAllMocks();
  files = new Map();
  mock.homedir.mockReturnValue(home);
  mock.readFile.mockImplementation(async (file: string, options: { signal: AbortSignal }) => {
    options.signal.throwIfAborted();
    if (files.has(file)) return files.get(file);
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
});

it('reads only file-defined names, including quoted names and root dotted keys', async () => {
  files.set(
    join(env.CODEX_HOME, 'config.toml'),
    String.raw`
mcp_servers.dotted.command = "unused"
[mcp_servers.archived]
command = "unused"
[mcp_servers.penathon]
url = "http://127.0.0.1:1/mcp"
[mcp_servers."a.b\"quoted"]
command = "unused"
[mcp_servers.'literal.name']
command = "unused"
`,
  );
  expect(await discover()).toEqual([
    'dotted',
    'archived',
    'penathon',
    'a.b"quoted',
    'literal.name',
  ]);
});

it('ignores servers present only in CLI listings, without spawning a CLI per run', async () => {
  mock.execFile.mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: null, stdout: string) => void)(null, '[{"name":"codex_app"}]');
  });
  files.set(join(env.CODEX_HOME, 'config.toml'), '[mcp_servers.defined]\ncommand = "unused"');
  expect(await discover()).toEqual(['defined']);
  expect(mock.execFile).not.toHaveBeenCalled();
});

it('includes project configs from cwd through the filesystem root and deduplicates names', async () => {
  files.set(join(env.CODEX_HOME, 'config.toml'), '[mcp_servers.shared]\ncommand = "unused"');
  files.set(join(cwd, '.codex/config.toml'), '[mcp_servers.nearest]\ncommand = "unused"');
  files.set(
    join(dirname(cwd), '.codex/config.toml'),
    '[mcp_servers.ancestor]\ncommand = "unused"\n[mcp_servers.shared]\ncommand = "unused"',
  );
  files.set(join(parse(cwd).root, '.codex/config.toml'), '[mcp_servers.root]\ncommand = "unused"');
  expect(await discover()).toEqual(['shared', 'nearest', 'ancestor', 'root']);
});

it('falls back to ~/.codex and reads an overlapping config file only once', async () => {
  files.set(join(home, '.codex/config.toml'), '[mcp_servers.home]\ncommand = "unused"');
  expect(await discover({})).toEqual(['home']);
  files.set(join(cwd, '.codex/config.toml'), '[mcp_servers.project]\ncommand = "unused"');
  mock.readFile.mockClear();
  expect(await discover({ CODEX_HOME: join(cwd, '.codex') })).toEqual(['project']);
  expect(
    mock.readFile.mock.calls.filter(([file]) => file === join(cwd, '.codex/config.toml')),
  ).toHaveLength(1);
});

it('ignores comments, multiline examples and dotted keys inside unrelated tables', async () => {
  files.set(
    join(env.CODEX_HOME, 'config.toml'),
    `
# [mcp_servers.comment]
instructions = """
[mcp_servers.example]
mcp_servers.example_key.command = "unused"
"""
other_instructions = '''
[mcp_servers.literal_example]
'''
[mcp_servers.real] # """
command = "unused # '''"
[unrelated]
mcp_servers.nested.command = "unused"
`,
  );
  expect(await discover()).toEqual(['real']);
});

it('accepts missing config files without returning builtin servers', async () => {
  expect(await discover()).toEqual([]);
});

it('fails closed without exposing unreadable config contents or paths', async () => {
  mock.readFile.mockRejectedValue(
    Object.assign(new Error('private-config-value'), { code: 'EACCES' }),
  );
  await expect(discover()).rejects.toThrow('Codex MCP configuration could not be read.');
});

it('passes cancellation to config reads', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(codexMcpNames(env, cwd, controller.signal)).rejects.toThrow(
    'Codex MCP configuration could not be read.',
  );
  expect(mock.readFile).toHaveBeenCalledWith(join(env.CODEX_HOME, 'config.toml'), {
    encoding: 'utf8',
    signal: controller.signal,
  });
});
