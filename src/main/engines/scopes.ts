import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Bot } from '../../shared/bots';
import { accessRank, type Project, type ProjectGrant } from '../../shared/projects';
import {
  commandName,
  deletionCommand,
  explicitShellPath,
  gitInvocation,
  inlineScript,
  isNullDevice,
  shellCommands,
} from './deletions';

export function effectiveAccess(bot: Bot, projects: Project[] = []) {
  const readRoots = [bot.workdir, ...bot.readScope, ...bot.writeScope];
  const writeRoots =
    bot.sandbox === 'read-only'
      ? []
      : [...(bot.sandbox === 'danger-full-access' ? [bot.workdir] : []), ...bot.writeScope];
  const fullRoots = bot.sandbox === 'danger-full-access' ? [bot.workdir, ...bot.writeScope] : [];
  const deleteApprovalRoots =
    bot.sandbox === 'workspace-write' ? [bot.workdir, ...bot.writeScope] : [];
  for (const grant of bot.projects) {
    const project = projects.find((project) => project.id === grant.project);
    if (!project) {
      console.warn('Unknown project grant:', grant.project);
      continue;
    }
    readRoots.push(...project.folders);
    if (grant.level !== 'read') writeRoots.push(...project.folders);
    if (grant.level === 'full') fullRoots.push(...project.folders);
    if (grant.level === 'write') deleteApprovalRoots.push(...project.folders);
  }
  return {
    readRoots: [...new Set(readRoots)],
    writeRoots: [...new Set(writeRoots)],
    fullRoots: [...new Set(fullRoots)],
    deleteApprovalRoots: [...new Set(deleteApprovalRoots)],
    sandbox:
      bot.sandbox === 'danger-full-access'
        ? bot.sandbox
        : writeRoots.length
          ? ('workspace-write' as const)
          : ('read-only' as const),
  };
}
export type EffectiveAccess = ReturnType<typeof effectiveAccess>;

async function canonical(path: string): Promise<string> {
  path = resolve(path);
  try {
    // fs/promises.realpath uses the native implementation on every platform.
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    // A dangling symlink cannot be scoped as if it were a new file.
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (entry) throw error;
    return resolve(await canonical(dirname(path)), relative(dirname(path), path));
  }
}
export async function inScope(path: string, roots: string[]): Promise<boolean> {
  const target = await canonical(path);
  for (const root of roots) {
    if (lexicallyInside(target, await canonical(root))) return true;
  }
  return false;
}
export function isChief(bot: Bot): boolean {
  return bot.id === 'chief' && bot.system;
}
export function normalizeServer(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
export function allowsConnection(connections: string[], server: string): boolean {
  return (
    connections.includes('*') ||
    connections.some((name) => normalizeServer(name) === normalizeServer(server))
  );
}
export class BotScopeError extends Error {}
export function assertNetworkCeiling(bot: Bot, parent: Bot): void {
  if (bot.network && !parent.network) throw new BotScopeError('errors.networkCeiling');
}
export function assertProjectCeiling(bot: Bot, parent: Bot, approved: ProjectGrant[] = []): void {
  for (const grant of bot.projects) {
    if (
      approved.some(
        (value) =>
          value.project === grant.project && accessRank[value.level] >= accessRank[grant.level],
      )
    )
      continue;
    const superior = parent.projects.find((value) => value.project === grant.project);
    if (!superior || accessRank[grant.level] > accessRank[superior.level])
      throw new BotScopeError('errors.projectCeiling');
  }
}
export async function assertCeiling(
  bot: Bot,
  parent: Bot,
  projects: Project[] = [],
  approved: ProjectGrant[] = [],
): Promise<void> {
  assertNetworkCeiling(bot, parent);
  assertProjectCeiling(bot, parent, approved);
  const ceiling = effectiveAccess(parent, projects);
  const access = effectiveAccess(
    {
      ...bot,
      projects: bot.projects.filter(
        (grant) =>
          !approved.some(
            (value) =>
              value.project === grant.project && accessRank[value.level] >= accessRank[grant.level],
          ),
      ),
    },
    projects,
  );
  const levels = ['read-only', 'workspace-write', 'danger-full-access'];
  if (levels.indexOf(bot.sandbox) > levels.indexOf(parent.sandbox))
    throw new BotScopeError('errors.sandboxCeiling');
  for (const path of access.readRoots)
    if (!isAbsolute(path) || !(await inScope(path, ceiling.readRoots)))
      throw new BotScopeError('errors.readCeiling: ' + path);
  for (const path of access.fullRoots)
    if (!isAbsolute(path) || !(await inScope(path, ceiling.fullRoots)))
      throw new BotScopeError('errors.fullCeiling: ' + path);
  for (const path of access.writeRoots)
    if (!isAbsolute(path) || !(await inScope(path, ceiling.writeRoots)))
      throw new BotScopeError('errors.writeCeiling: ' + path);
  if (bot.connections.some((name) => !allowsConnection(parent.connections, name)))
    throw new BotScopeError('errors.connectionCeiling');
}
export async function assertKnowledgeScope(
  bot: Bot,
  knowledgeDir?: string,
  projects: Project[] = [],
): Promise<void> {
  if (!knowledgeDir || isChief(bot)) return;
  for (const root of [
    bot.workdir,
    ...bot.readScope,
    ...bot.writeScope,
    ...projects
      .filter((project) => bot.projects.some((grant) => grant.project === project.id))
      .flatMap((project) => project.folders),
  ])
    if ((await inScope(knowledgeDir, [root])) || (await inScope(root, [knowledgeDir])))
      throw new BotScopeError(`errors.knowledgeScope: ${root} (${knowledgeDir})`);
}
export async function withoutKnowledge(
  bot: Bot,
  knowledgeDir?: string,
  projects: Project[] = [],
): Promise<Bot> {
  await assertKnowledgeScope({ ...bot, readScope: [] }, knowledgeDir, projects);
  if (!knowledgeDir || isChief(bot)) return bot;
  const filter = async (paths: string[]) => {
    const allowed = await Promise.all(
      paths.map(
        async (path) =>
          !(await inScope(path, [knowledgeDir])) && !(await inScope(knowledgeDir, [path])),
      ),
    );
    return paths.filter((_, i) => allowed[i]);
  };
  return {
    ...bot,
    readScope: await filter(bot.readScope),
    writeScope: await filter(bot.writeScope),
  };
}
export function toolPath(workdir: string, value: string): string {
  return resolve(workdir, /^file:\/\//i.test(value) ? fileURLToPath(value) : value);
}
function lexicallyInside(path: string, root: string) {
  if (process.platform === 'win32') {
    path = path.toLowerCase();
    root = root.toLowerCase();
  }
  const rel = relative(resolve(root), resolve(path));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}
async function referencesKnowledge(
  input: unknown,
  workdir: string,
  knowledgeDir: string,
): Promise<boolean> {
  if (typeof input === 'string') {
    if (/[\r\n\u2028\u2029]/.test(input)) return false;
    try {
      // Plain relative text stays under workdir, which cannot overlap the vault.
      // limit: MCP servers may use their own cwd for relative paths; this is best effort.
      const path = toolPath(workdir, input);
      return (await inScope(path, [knowledgeDir])) || (await inScope(knowledgeDir, [path]));
    } catch {
      // Too long or unreadable for the filesystem check: compare the normalised text instead.
      try {
        const path = resolve(workdir, input);
        return lexicallyInside(path, knowledgeDir) || lexicallyInside(knowledgeDir, path);
      } catch {
        return false;
      }
    }
  }
  if (input && typeof input === 'object')
    for (const value of Object.values(input))
      if (await referencesKnowledge(value, workdir, knowledgeDir)) return true;
  return false;
}
function normalizedOperation(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase();
}
function mcpOperation(tool: string, input: unknown, pattern: RegExp): boolean {
  const name = normalizedOperation(tool);
  const scan = (value: unknown, all: boolean): boolean => {
    if (typeof value === 'string') return all && pattern.test(normalizedOperation(value));
    if (Array.isArray(value)) return value.some((item) => scan(item, all));
    if (value && typeof value === 'object')
      return Object.entries(value).some(
        ([key, item]) =>
          (all && pattern.test(normalizedOperation(key))) ||
          scan(item, all || /^(?:action|operation|method|type|kind)$/i.test(key)),
      );
    return false;
  };
  return (
    (!/^(?:create_draft(?:$|_)|search_|get_|list_|read_)/.test(name) && pattern.test(name)) ||
    scan(input, /(?:^|_)(?:batch|bulk|execute|run|call|invoke)(?:_|$)/.test(name))
  );
}
export function isMcpAction(tool: string, input: unknown): boolean {
  return mcpOperation(
    tool,
    input,
    /send|reply|forward|publish|post|delete|trash|remove|archive|pay|purchase|transfer|invite|share/,
  );
}
export function isMcpDeletion(name: string, input?: unknown): boolean {
  return (
    name.startsWith('mcp__') &&
    mcpOperation(
      name.split('__').at(-1)!,
      input,
      /delete|remove|unlink|trash|(?:^|_)rm(?:dir)?(?:_|$)/,
    )
  );
}
export function mcpPaths(input: unknown, workdir: string, pathField = false): string[] {
  if (typeof input === 'string') {
    const value = input.trim();
    const fileUri = /^file:/i.test(value);
    if (!pathField && !fileUri) return [];
    if (!fileUri && !/^[a-z]:[\\/]/i.test(value) && /^[a-z][a-z0-9+.-]*:\/\//i.test(value))
      return [];
    let path = value;
    if (fileUri) {
      try {
        path = fileURLToPath(value);
      } catch (error) {
        if (!pathField) return [];
        throw error;
      }
    }
    const checked = process.platform === 'win32' ? path.replace(/^\\\\\?\\/, '') : path;
    // Embedded tildes are literal (including Windows 8.3 names); leading ~ is indirect.
    if (!checked || /^~|[$%\x60*?[\]{}!\0]/.test(checked)) throw new Error('Indirect tool path');
    return [toolPath(workdir, path)];
  }
  if (pathField && (input === null || typeof input !== 'object'))
    throw new Error('Invalid tool path');
  if (Array.isArray(input)) return input.flatMap((value) => mcpPaths(value, workdir, pathField));
  if (input && typeof input === 'object')
    return Object.entries(input).flatMap(([key, value]) =>
      mcpPaths(
        value,
        workdir,
        /^(?:paths?|files?|uris?|urls?|file_?(?:paths?|uris?|urls?)|directories|directory|source|destination|targets?)$/i.test(
          key,
        ),
      ),
    );
  return [];
}
export async function deletionPathsAllowed(
  bot: Bot,
  paths: string[],
  access: EffectiveAccess,
  knowledgeDir?: string,
): Promise<boolean> {
  if (!paths.length) return false;
  for (const path of paths) {
    if (
      knowledgeDir &&
      !isChief(bot) &&
      ((await inScope(path, [knowledgeDir])) || (await inScope(knowledgeDir, [path])))
    )
      return false;
    if (
      !(await inScope(path, [
        ...access.writeRoots,
        ...(isChief(bot) && knowledgeDir ? [knowledgeDir] : []),
      ]))
    )
      return false;
  }
  return true;
}
function scriptWrites(args: string[], command: string) {
  const inline = inlineScript(args);
  const writes: string[] = [];
  const reads: string[] = [];
  let script = '';
  let patterns: RegExp[] = [];
  if (inline?.language === 'python') {
    script = inline.script;
    patterns = [
      /\bopen\s*\(\s*([^,]+),\s*(?:mode\s*=\s*)?(['"])(?:[wax][+bt]*|r[bt]*\+[bt]*)\2/g,
      /(?:\b(?:pathlib\s*\.\s*)?Path\s*\(([^)]*)\)\s*)?\.\s*(?:write_(?:text|bytes)|mkdir)\s*\(/g,
      /\b(?:mkdir|makedirs|rename|replace)\s*\(\s*([^,)]*)/g,
      /\b(?:copyfile|copy|copy2|rename|replace)\s*\(\s*[^,]*,\s*([^,)]*)/g,
    ];
  } else if (inline?.language === 'javascript') {
    script = inline.script;
    patterns = [
      /\bBun\s*\.\s*write\s*\(\s*([^,)]*)/g,
      /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|writeTextFile(?:Sync)?|mkdir(?:Sync)?|rename(?:Sync)?)\s*\(\s*([^,)]*)/g,
      /\b(?:copyFile|rename)(?:Sync)?\s*\(\s*[^,]*,\s*([^,)]*)/g,
    ];
  } else if (inline?.language === 'ruby') {
    script = inline.script;
    patterns = [
      /\bFile\.(?:write|binwrite)\s*\(\s*([^,)]*)/g,
      /\bFile\.open\s*\(\s*([^,]+),\s*(['"])[wax][+bt]*\2/g,
      /\b(?:mkdir|rename)\s*\(\s*([^,)]*)/g,
      /\b(?:copy_file|rename)\s*\(\s*[^,]*,\s*([^,)]*)/g,
    ];
  } else if (inline?.language === 'perl') {
    script = inline.script;
    patterns = [
      /\bopen\s*\(?\s*[^,]+,\s*['"](?:>>?|\+>|\+<)['"]\s*,\s*([^,)]*)/g,
      /\b(?:mkdir|rename)\s*\(\s*([^,)]*)/g,
      /\b(?:copy|rename)\s*\(\s*[^,]*,\s*([^,)]*)/g,
    ];
  } else if (/\[(?:System\.)?IO\.File\]\s*::/i.test(args.join(' '))) {
    // The shell tokenizer strips PowerShell's inner quotes; recover literals from the source.
    script = command;
    patterns = [
      /\[(?:System\.)?IO\.File\]\s*::\s*(?:WriteAllText|WriteAllBytes|AppendAllText|WriteAllLines|AppendAllLines)\s*\(\s*([^,)]*)/gi,
    ];
  }
  for (const pattern of patterns)
    for (const match of script.matchAll(pattern)) {
      const literal = /^\s*(?:r|u)?(['"])(.*?)\1\s*$/is.exec(match[1] ?? '');
      writes.push(literal && !/[$%`]/.test(literal[2]) ? literal[2].replace(/\\\\/g, '\\') : '.');
    }
  for (const match of script.matchAll(
    /\b(?:copyFile(?:Sync)?|copyfile|copy2?|copy_file)\s*\(\s*([^,)]*)/g,
  )) {
    const literal = /^\s*(?:r|u)?(['"])(.*?)\1\s*$/is.exec(match[1]);
    reads.push(literal ? literal[2].replace(/\\\\/g, '\\') : '.');
  }
  return { reads, writes };
}

function bashArguments(args: string[], command: string) {
  const scripted = scriptWrites(args, command);
  const name = commandName(args[0] ?? '');
  const values = args.slice(name === 'git' ? 2 : 1);
  const copy = /^(?:cp|mv|rsync|install|ln|copy-item|cpi|copy|move-item|mi|move)$/.test(name);
  const move =
    /^(?:mv|move-item|mi|move|ren|rename-item)$/.test(name) || (name === 'git' && args[1] === 'mv');
  const sedWrite = name === 'sed' && values.some((arg) => /^-i|^--in-place(?:=|$)/.test(arg));
  const gitWrite =
    name === 'git' &&
    (/^(?:restore|checkout|reset|clean|rm|mv|apply|am|merge|rebase|pull|switch|commit)$/.test(
      args[1] ?? '',
    ) ||
      (args[1] === 'stash' && /^(?:pop|apply)$/.test(values[0] ?? '')));
  const gitPaths =
    name === 'git' &&
    (args[1] === 'restore' ||
      args[1] === 'mv' ||
      (args[1] === 'checkout' && values.includes('--')));
  const writer =
    copy ||
    sedWrite ||
    gitWrite ||
    /^(?:touch|mkdir|tee|new-item|ni|set-content|sc|add-content|ac|out-file|rename-item|ren)$/.test(
      name,
    );
  const packageWrite =
    /^(?:npm|pnpm|yarn)$/.test(name) &&
    ((name !== 'npm' && !values.length) ||
      /^(?:install|i|ci|add|remove|uninstall|update|upgrade|up|dedupe|rebuild|link|unlink)$/.test(
        values[0] ?? '',
      ));
  const search =
    /^(?:grep|rg|ag|ack|findstr|select-string|sed|awk)$/.test(name) ||
    (name === 'git' && args[1] === 'grep');
  const reads: string[] = [...scripted.reads];
  const operands: string[] = [];
  const writes: string[] = [...scripted.writes];
  let pattern = false;
  let literal = false;
  let destination = false;
  for (let i = 0; i < values.length; i++) {
    const arg = values[i];
    if (!literal && arg === '--') {
      literal = true;
      continue;
    }
    // Check attached paths before ':' options so -tC:/dir keeps its drive letter.
    const attached =
      !literal &&
      ((copy ? /^(-t)(.+)$/.exec(arg) : null) ??
        (search ? /^(-[ABCmefgt])(.+)$/.exec(arg) : null) ??
        /^(-[a-z])((?:[a-z]:[\\/]|[\\/]).*)$/i.exec(arg) ??
        /^(-[^:=]+)[:=](.*)$/.exec(arg));
    const option = !literal && arg.startsWith('-') ? (attached ? attached[1] : arg) : '';
    let value = attached ? attached[2] : option ? undefined : arg;
    if (option) {
      if (scripted.writes.length && /^(?:-c|-e|--eval)$/i.test(option)) {
        if (value === undefined) i++;
        continue;
      }
      if (search && (/^(?:-e|--regexp|--expression)$/.test(option) || /^-pattern$/i.test(option))) {
        if (value === undefined) i++;
        pattern = true;
        continue;
      }
      if (
        search &&
        /^(?:-[ABCmgt]|--context|--after-context|--before-context|--max-count|--glob|--iglob|--type|--type-not|--threads|--max-depth)$/.test(
          option,
        )
      ) {
        if (value === undefined) i++;
        continue;
      }
      if (
        /^(?:-g|--glob|--iglob|--include|--exclude|--exclude-dir|-encoding|-width|-inputobject|-value|-filter|-include|-exclude|-itemtype|-newname)$/.test(
          option.toLowerCase(),
        ) ||
        (name === 'install' && /^(?:-m|-o|-g|--mode|--owner|--group)$/.test(option)) ||
        (name === 'touch' && /^(?:-t|-d|--date|--time)$/.test(option)) ||
        (name === 'rsync' && /^(?:-e|--rsh|--exclude|--include)$/.test(option)) ||
        (name === 'git' && /^(?:-s|--source|-m|--message)$/.test(option))
      ) {
        if (value === undefined) i++;
        continue;
      }
      if (search && /^(?:-f|--file)$/.test(option)) {
        if (value === undefined) value = values[++i];
        pattern = true;
        if (value !== undefined) reads.push(value);
        continue;
      }
      const target =
        (copy && /^(?:-t|--target-directory|-destination)$/i.test(option)) ||
        (packageWrite && /^(?:--prefix|--dir|--cwd|-C)$/.test(option));
      const path = /^(?:-path|-literalpath|-filepath|--file|--directory)$/i.test(option);
      if (target || path) {
        if (value === undefined) value = values[++i];
        if (value === undefined) throw new Error('Missing shell path');
        if (target) {
          writes.push(value);
          destination = true;
        } else {
          operands.push(value);
          if (writer && !copy) writes.push(value);
        }
      } else if (value !== undefined) reads.push(value);
      continue;
    }
    if (name === 'dd' && /^(?:if|of)=/.test(arg)) {
      const path = arg.slice(3);
      if (arg.startsWith('of=')) writes.push(path);
      else reads.push(path);
      continue;
    }
    if (search && !pattern) {
      pattern = true;
      continue;
    }
    if (/^(?:del|erase|rd|rmdir)$/.test(name) && /^\/(?:s|q|f|a(?::.*)?)$/i.test(arg)) continue;
    if (name === 'git' && args[1] === 'checkout' && values.includes('--') && !literal) continue;
    operands.push(arg);
  }
  reads.push(...operands);
  if (move) {
    writes.push(...operands);
  } else if (copy && !destination && !(name === 'install' && values.includes('-d'))) {
    if (operands.length) writes.push(operands.at(-1)!);
  } else if (
    (writer && !copy && !gitWrite) ||
    gitPaths ||
    (name === 'install' && values.includes('-d'))
  ) {
    const textOutput = /^(?:set-content|sc|add-content|ac|out-file)$/.test(name);
    writes.push(...(textOutput ? operands.slice(0, 1) : operands));
  }
  if (packageWrite || gitWrite) writes.push('.');
  return {
    reads,
    writes: writes.filter((value) => !isNullDevice(value)),
    writer: writer || packageWrite || scripted.writes.length > 0,
    writeReads: name === 'git' && args[1] === 'checkout' && !values.includes('--'),
  };
}

export function commandMayWrite(command: string): boolean {
  if (deletionCommand(command, process.cwd())) return true;
  try {
    return shellCommands(command).some(({ args, redirects }) => {
      if (redirects.some((token) => token.operator)) return true;
      const invocation = gitInvocation(args, process.cwd());
      const access = bashArguments(invocation.args, command);
      return access.writer || access.writes.length > 0;
    });
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function allowBash(
  bot: Bot,
  command: string,
  access: EffectiveAccess,
  knowledgeDir?: string,
): Promise<boolean> {
  try {
    const deletion = deletionCommand(command, bot.workdir);
    if (deletion?.uncertain) return false;
    if (deletion && !access.writeRoots.length) return false;
    if (deletion && !(await deletionPathsAllowed(bot, deletion.paths, access, knowledgeDir)))
      return false;
    const allowed = async (value: string, write: boolean, workdir = bot.workdir) => {
      if (write && !access.writeRoots.length) return false;
      if (write) value = explicitShellPath(value, workdir);
      else {
        if (value.startsWith('~')) value = homedir() + value.slice(1);
        if (win32.isAbsolute(value) && !isAbsolute(value)) return false;
        value = toolPath(workdir, value);
      }
      if (
        knowledgeDir &&
        !isChief(bot) &&
        ((await inScope(value, [knowledgeDir])) || (await inScope(knowledgeDir, [value])))
      )
        return false;
      return inScope(value, [
        ...(write ? access.writeRoots : access.readRoots),
        ...(isChief(bot) && knowledgeDir ? [knowledgeDir] : []),
      ]);
    };
    const readPath = async (value: string, workdir: string) => {
      if (
        value.includes('..') ||
        value.startsWith('~') ||
        win32.isAbsolute(value) ||
        isAbsolute(value)
      ) {
        // Git Bash's missing /name paths do not refer to the Windows drive root.
        if (
          sep === '\\' &&
          /^\/[^/]/.test(value) &&
          !(await exists(resolve('/', value.split('/')[1])))
        )
          return false;
        return true;
      }
      return exists(toolPath(workdir, value));
    };
    if (!(await allowed(bot.workdir, false))) return false;
    const segments = shellCommands(command);
    if (!segments.length) return false;
    const changesCwd = segments.some(({ args }) =>
      /^(?:cd|chdir|pushd|set-location|sl)$/.test(commandName(args[0] ?? '')),
    );
    for (const { args, redirects } of segments) {
      const invocation = gitInvocation(args, bot.workdir);
      const { reads, writes, writer, writeReads } = bashArguments(invocation.args, command);
      for (const directory of invocation.directories)
        if (!(await allowed(directory, writer))) return false;
      if (writer && !access.writeRoots.length) return false;
      if (changesCwd && (deletion || writer || redirects.some((token) => token.operator)))
        return false;
      for (const { value, operator } of redirects)
        if (!(await allowed(value, !!operator))) return false;
      for (const value of writes)
        if (!(await allowed(value, true, invocation.workdir))) return false;
      for (const value of reads)
        if (
          (await readPath(value, invocation.workdir)) &&
          !(await allowed(value, writeReads, invocation.workdir))
        )
          return false;
    }
    return true;
  } catch {
    return false;
  }
}
export function isTeamTool(name: string, server?: { name: string; source: string }): boolean {
  return (
    name.startsWith('mcp__team__') &&
    (!server || (server.name === 'team' && server.source === 'sdk'))
  );
}

export async function allowClaudeTool(
  bot: Bot,
  name: string,
  input: Record<string, unknown>,
  knowledgeDir?: string,
  server?: { name: string; source: string },
  access: EffectiveAccess = effectiveAccess(bot),
): Promise<boolean> {
  if (name.startsWith('mcp__')) {
    const match = /^mcp__(.+?)__(.+)$/.exec(name);
    // Extra separators are ambiguous without the SDK's serving-server provenance.
    if (!match || (!server && match[2].includes('__'))) return false;
    const actual = server?.name ?? match[1];
    if (server && !name.startsWith('mcp__' + normalizeServer(actual) + '__')) return false;
    if (isTeamTool(name, server)) return true;
    if (
      knowledgeDir &&
      !isChief(bot) &&
      (await referencesKnowledge(input, bot.workdir, knowledgeDir))
    )
      return false;
    try {
      if (isMcpDeletion(name, input)) {
        const paths = mcpPaths(input, bot.workdir);
        if (paths.length && !(await deletionPathsAllowed(bot, paths, access, knowledgeDir)))
          return false;
      } else {
        const paths = mcpPaths(input, bot.workdir);
        const writePattern = /write|edit|update|create|move|rename|append/;
        const roots =
          writePattern.test(normalizedOperation(match[2])) ||
          mcpOperation(match[2], input, writePattern)
            ? access.writeRoots
            : access.readRoots;
        for (const path of paths)
          if (
            !(await inScope(path, [
              ...roots,
              ...(isChief(bot) && knowledgeDir ? [knowledgeDir] : []),
            ]))
          )
            return false;
      }
    } catch {
      return false;
    }
    return allowsConnection(bot.connections, actual);
  }
  if (name === 'WebFetch' || name === 'WebSearch') return bot.network;
  const chief = isChief(bot);
  const write = name === 'Write' || name === 'Edit';
  if (name === 'Bash') {
    return typeof input.command === 'string' && allowBash(bot, input.command, access, knowledgeDir);
  }
  if (!['Read', 'Write', 'Edit', 'Grep', 'Glob'].includes(name)) return false;
  if (write && !access.writeRoots.length) return false;
  const path = input.file_path ?? input.path ?? bot.workdir;
  if (typeof path !== 'string') return false;
  const paths = [toolPath(bot.workdir, path)];
  if (name === 'Glob' || name === 'Grep')
    for (const pattern of name === 'Grep' ? [input.glob] : [input.pattern, input.glob])
      if (
        typeof pattern === 'string' &&
        (/^(?:[a-z]:[\\/]|[\\/]|file:\/\/)/i.test(pattern) || pattern.split(/[\\/]/).includes('..'))
      )
        paths.push(toolPath(paths[0], pattern));
  for (const resolved of paths) {
    if (
      knowledgeDir &&
      !chief &&
      ((await inScope(resolved, [knowledgeDir])) ||
        (!write && (await inScope(knowledgeDir, [resolved]))))
    )
      return false;
    if (
      !(await inScope(resolved, [
        ...(write ? access.writeRoots : access.readRoots),
        ...(chief && knowledgeDir ? [knowledgeDir] : []),
      ]))
    )
      return false;
  }
  return true;
}
