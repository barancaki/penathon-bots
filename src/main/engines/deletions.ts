import { isAbsolute, resolve, sep, win32 } from 'node:path';

export const indirectDeletion =
  'Silme komutunda hedef yolları açıkça yaz (dolaylı hedef desteklenmiyor).';

type Token = { value: string; operator?: boolean };
export type ShellCommand = { args: string[]; redirects: Token[]; indirect: boolean };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let value = '';
  let started = false;
  let quote = '';
  const flush = () => {
    if (started) tokens.push({ value });
    value = '';
    started = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\' && quote !== "'" && /[\s;'"&|<>]/.test(source[i + 1] ?? '')) {
      value += source[++i];
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/[;&|\r\n<>]/.test(char)) {
      let operator = char;
      if (/[<>]/.test(char) && /^\d+$/.test(value)) {
        operator = value + char;
        value = '';
        started = false;
      }
      flush();
      const descriptor =
        /^[<>]$/.test(char) && /^&(?:\d+|-)(?=$|[\s;&|<>])/.exec(source.slice(i + 1));
      if (descriptor) {
        i += descriptor[0].length;
        continue;
      }
      if (char === '&' && source[i + 1] === '>') {
        operator += source[++i];
        if (source[i + 1] === '>') operator += source[++i];
      } else if (/[&|<>]/.test(char) && source[i + 1] === char) operator += source[++i];
      tokens.push({ value: operator, operator: true });
    } else if (/\s/.test(char)) flush();
    else {
      value += char;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed shell quote');
  flush();
  return tokens;
}

export function commandName(value: string): string {
  return value
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(?:exe|cmd|bat)$/i, '')
    .toLowerCase();
}

export function inlineScript(args: string[]): { language: string; script: string } | undefined {
  const name = commandName(args[0] ?? '');
  const language = /^(?:python(?:\d+(?:\.\d+)*)?|py)$/.test(name)
    ? 'python'
    : /^(?:node|deno|bun)$/.test(name)
      ? 'javascript'
      : /^(?:ruby|perl)$/.test(name)
        ? name
        : undefined;
  if (!language) return undefined;
  const index = args.findIndex(
    (arg, i) =>
      i > 0 &&
      (name === 'deno'
        ? arg === 'eval'
        : language === 'python'
          ? arg === '-c'
          : /^(?:-e|--eval)$/.test(arg)),
  );
  if (index < 0) return undefined;
  let start = index + 1;
  if (name === 'deno') while (args[start]?.startsWith('-')) start++;
  return { language, script: args[start] ?? '' };
}

function quoteArgs(args: string[]): string {
  return args.map((arg) => "'" + arg.replace(/'/g, "'\"'\"'") + "'").join(' ');
}

export function isNullDevice(value: string): boolean {
  return /^(?:\/dev\/null|\$null|nul:?)$/i.test(value);
}

// limit: Shell semantics cannot be fully resolved statically. This is best effort;
// aliases, generated scripts and dynamic shell expansion are not interpreted.
// OS-level Codex sandbox roots and Claude file-tool hooks provide the primary protection.
export function shellCommands(source: string, indirect = false, depth = 0): ShellCommand[] {
  if (depth > 16) throw new Error('Too many shell wrappers');
  const segments: Token[][] = [[]];
  for (const token of tokenize(source)) {
    if (token.operator && /^[;&|\r\n]+$/.test(token.value)) segments.push([]);
    else segments.at(-1)!.push(token);
  }
  return segments.flatMap((tokens): ShellCommand[] => {
    const args: string[] = [];
    const redirects: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.operator) {
        const target = tokens[++i];
        if (!target || target.operator) throw new Error('Missing redirection target');
        if (!isNullDevice(target.value))
          redirects.push({ value: target.value, operator: token.value.includes('>') });
      } else args.push(token.value);
    }
    while (/^\w+=/.test(args[0] ?? '')) args.shift();
    const name = commandName(args[0] ?? '');
    let start = 1;
    if (['sudo', 'command', 'env', 'nohup', 'time', 'xargs'].includes(name)) {
      if (name === 'command' && ['-v', '-V'].includes(args[1]))
        return [{ args, redirects, indirect }];
      while (start < args.length) {
        const arg = args[start];
        if (arg === '--') {
          start++;
          break;
        }
        if (name === 'env' && /^(?:-S|--split-string)(?:=|$)/.test(arg)) {
          const attached = arg.includes('=');
          const split = attached ? arg.slice(arg.indexOf('=') + 1) : args[start + 1];
          args.splice(
            start,
            attached ? 1 : 2,
            ...tokenize(split).map((token) => {
              if (token.operator) throw new Error('Indirect env command');
              return token.value;
            }),
          );
          continue;
        }
        if (/^\w+=/.test(arg) || arg.startsWith('-')) {
          if (/^(?:-C|--chdir|-D|--directory)(?:=|$)/.test(arg)) throw new Error('Indirect cwd');
          const takesValue =
            name === 'sudo'
              ? /^(?:-u|-g|-h|-p|--user|--group|--host|--prompt)$/
              : name === 'env'
                ? /^(?:-u|--unset)$/
                : name === 'time'
                  ? /^(?:-f|-o|--format|--output)$/
                  : name === 'xargs'
                    ? /^(?:-n|-L|-P|-I|-E|-d|-s|-a|--max-args|--max-lines|--max-procs|--replace|--eof|--delimiter|--max-chars|--arg-file)$/
                    : /^$/;
          if (takesValue.test(arg)) start++;
          start++;
        } else break;
      }
      // Requote tokens so wrappers preserve paths and embedded shell scripts.
      const nested = shellCommands(
        quoteArgs(args.slice(start)),
        indirect || name === 'xargs',
        depth + 1,
      );
      return [{ args: [], redirects, indirect }, ...nested];
    }
    if (['cmd', 'powershell', 'pwsh', 'bash', 'sh'].includes(name)) {
      const index = args.findIndex((arg, i) => i > 0 && /^(?:\/c|-c|-command)$/i.test(arg));
      if (index >= 0) {
        const inner = args.slice(index + 1);
        const script =
          inner.length === 1 || name === 'bash' || name === 'sh' ? inner[0] : quoteArgs(inner);
        const nested = shellCommands(script, indirect, depth + 1);
        return [{ args: [], redirects, indirect }, ...nested];
      }
    }
    return args.length || redirects.length ? [{ args, redirects, indirect }] : [];
  });
}

export function explicitShellPath(value: string, workdir: string): string {
  // shortcut: reject target globs; expand and canonicalize every match before supporting them.
  if (!value || /[*?[\]{},!$%~\x60\0]/.test(value)) throw new Error('Indirect shell path');
  if ((win32.isAbsolute(value) && !isAbsolute(value)) || (sep === '/' && value.includes('\\')))
    throw new Error('Foreign shell path');
  return resolve(workdir, value);
}

export function gitInvocation(args: string[], workdir: string) {
  const directories: string[] = [];
  if (commandName(args[0] ?? '') !== 'git') return { args, workdir, directories };
  let index = 1;
  while (args[index]?.startsWith('-')) {
    const option = args[index++];
    if (option === '--') break;
    const attached =
      /^(--(?:git-dir|work-tree))=(.*)$/.exec(option) ?? /^(-[Cc])(.+)$/.exec(option);
    const flag = attached ? attached[1] : option;
    if (!['-C', '-c', '--git-dir', '--work-tree'].includes(flag)) continue;
    const value = attached ? attached[2] : args[index++];
    if (value === undefined) throw new Error('Missing git option value');
    if (flag === '-c' || (value === '' && flag === '-C')) continue;
    const path = explicitShellPath(value, workdir);
    directories.push(path);
    if (flag !== '--git-dir') workdir = path;
  }
  return { args: [args[0], ...args.slice(index)], workdir, directories };
}

export function deletionCommand(
  command: string,
  workdir: string,
): { paths: string[]; uncertain: boolean } | undefined {
  const paths: string[] = [];
  let found = false;
  let uncertain = false;
  let cwd = workdir;
  const add = (value: string) => {
    try {
      paths.push(explicitShellPath(value, cwd));
    } catch {
      uncertain = true;
    }
  };
  try {
    for (const segment of shellCommands(command)) {
      const invocation = gitInvocation(segment.args, workdir);
      cwd = invocation.workdir;
      const [executable, ...args] = invocation.args;
      const name = commandName(executable ?? '');
      const script = inlineScript(invocation.args)?.script;
      const calls = /\b(?:rmtree|os\.(?:remove|rmdir)|unlink(?:Sync)?|rm(?:Sync)?)\s*\(/;
      const findDeletion =
        name === 'find' &&
        (args.includes('-delete') ||
          args.some(
            (arg, i) =>
              /^-(?:exec|execdir|ok|okdir)$/.test(arg) &&
              /^(?:rm|rmdir|unlink|shred)$/.test(commandName(args[i + 1] ?? '')),
          ));
      const git = name === 'git' && ['rm', 'clean'].includes(args[0]);
      if (
        !/^(?:rm|rmdir|del|erase|rd|remove-item|ri|unlink|shred)$/.test(name) &&
        !git &&
        !findDeletion &&
        !(script && calls.test(script))
      )
        continue;
      found = true;
      if (
        segment.indirect ||
        args.some((arg) => /(?:--?files0-from|--pathspec-from-file)/.test(arg))
      )
        uncertain = true;
      const before = paths.length;
      if (script) {
        const literalCalls =
          /\b(?:(?:require\(\s*['"](?:node:)?fs['"]\s*\)|\w+)\.)?(?:rmtree|remove|rmdir|unlink(?:Sync)?|rm(?:Sync)?)\s*\(\s*(['"])([^'"\\]*)\1\s*(?:,\s*\{\s*(?:(?:recursive|force)\s*:\s*(?:true|false)\s*,?\s*)*\})?\s*\)/g;
        for (const match of script.matchAll(literalCalls)) add(match[2]);
        const rest = script
          .replace(literalCalls, '')
          .replace(/\bimport\s+(?:os|shutil)(?:\s*,\s*(?:os|shutil))*/g, '')
          .replace(/\b(?:const|let|var)\s+\w+\s*=\s*require\(\s*(['"])(?:node:)?fs\1\s*\)/g, '');
        if (!/^[;\s]*$/.test(rest)) uncertain = true;
      } else if (findDeletion) {
        let index = 0;
        while (['-P', '-L', '-H'].includes(args[index])) index++;
        for (; index < args.length && !/^[-(!]/.test(args[index]); index++) add(args[index]);
        if (paths.length === before && !uncertain) add('.');
        for (let i = index; i < args.length; i++) {
          if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i])) continue;
          const action = args[i];
          const executable = commandName(args[++i] ?? '');
          if (!/^(?:rm|rmdir|unlink|shred)$/.test(executable)) continue;
          for (i++; i < args.length && ![';', '+'].includes(args[i]); i++) {
            const value = args[i];
            if (value === '{}' || value.startsWith('-')) continue;
            if (action.endsWith('dir') && !isAbsolute(value)) uncertain = true;
            add(value);
          }
        }
      } else {
        let literal = false;
        for (let value of git ? args.slice(1) : args) {
          if (!literal && value === '--') {
            literal = true;
            continue;
          }
          if (!literal && /^(?:-path|-literalpath):/i.test(value))
            value = value.slice(value.indexOf(':') + 1);
          if (
            !literal &&
            (value.startsWith('-') ||
              (/^(?:del|erase|rd|rmdir)$/.test(name) && /^\/(?:s|q|f|a(?::.*)?)$/i.test(value)))
          )
            continue;
          add(value);
        }
        if (paths.length === before && git && args[0] === 'clean' && !uncertain) add('.');
      }
      if (paths.length === before) uncertain = true;
    }
  } catch {
    return { paths, uncertain: true };
  }
  return found ? { paths: [...new Set(paths)], uncertain } : undefined;
}
