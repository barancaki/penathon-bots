import { afterEach, expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  inScope,
  allowClaudeTool,
  assertKnowledgeScope,
  withoutKnowledge,
  commandMayWrite,
} from '../src/main/engines/scopes';
import { removeTemporary, temporaryDirectory, testBot } from './helpers';

let directory: string;

it.each([
  `bun -e "Bun.write('TARGET', 'data')"`,
  `py -c "open('TARGET', 'w').write('data')"`,
  `py -3 -c "open('TARGET', 'w').write('data')"`,
  `node -e "fs.appendFile('TARGET', 'data', () => {})"`,
  `node -e "fs.promises.appendFile('TARGET', 'data')"`,
  `node -e "fs.writeFile('TARGET', 'data', () => {})"`,
  `node -e "fs.copyFile('TARGET', 'TARGET', () => {})"`,
  `node -e "fs.copyFileSync('TARGET', 'TARGET')"`,
  `node -e "fs.promises.copyFile('TARGET', 'TARGET')"`,
  `node -e "fs.rename('TARGET', 'TARGET', () => {})"`,
  `node -e "fs.renameSync('TARGET', 'TARGET')"`,
  `node -e "fs.promises.rename('TARGET', 'TARGET')"`,
  `node -e "fs.mkdir('TARGET', () => {})"`,
  `node -e "fs.mkdirSync('TARGET')"`,
  `node -e "fs.promises.mkdir('TARGET')"`,
  `deno eval "Deno.writeTextFile('TARGET', 'data')"`,
  `bun -e "require('fs').appendFile('TARGET', 'data', () => {})"`,
  `ruby -e "File.write('TARGET', 'data')"`,
  `perl -e "open(my $fh, '>', 'TARGET')"`,
  `powershell -c "[IO.File]::WriteAllText('TARGET', 'data')"`,
  `pwsh -Command "[IO.File]::WriteAllText('TARGET', 'data')"`,

  `python -c "open('TARGET', 'w').write('data')"`,
  `python3 -c "open('TARGET', 'a').write('data')"`,
  `python3.12 -c "open('TARGET', mode='x').write('data')"`,
  `python -c "open('TARGET', 'r+').write('data')"`,
  `python -c "from pathlib import Path; Path('TARGET').write_text('data')"`,
  `python -c "import pathlib; pathlib.Path('TARGET').write_bytes(b'data')"`,
  `node -e "require('fs').writeFileSync('TARGET', 'data')"`,
  `node -e "fs.appendFileSync('TARGET', 'data')"`,
  `node -e "fs.createWriteStream('TARGET')"`,
  `node -e "fs.promises.writeFile('TARGET', 'data')"`,
  `[IO.File]::WriteAllText('TARGET', 'data')`,
  `powershell -Command "[IO.File]::WriteAllText('TARGET', 'data')"`,
  `pwsh -c "[System.IO.File]::WriteAllText('TARGET', 'data')"`,
])('classifies inline writes and checks literal target scope: %s', async (template) => {
  directory = await temporaryDirectory();
  const work = join(directory, 'work');
  const reader = join(directory, 'reader');
  const vault = join(directory, 'vault');
  for (const path of [work, reader, vault]) await mkdir(path);
  const bot = testBot(work, { readScope: [work, reader] });
  const command = (target: string) => template.replaceAll('TARGET', target.replaceAll('\\', '/'));
  const run = (target: string, actor = bot) =>
    allowClaudeTool(actor, 'Bash', { command: command(target) }, vault);
  expect(commandMayWrite(command('new.txt'))).toBe(true);
  expect(await run('new.txt')).toBe(true);
  expect(await run('new.txt', { ...bot, sandbox: 'read-only', writeScope: [] })).toBe(false);
  expect(await run('../reader/new.txt')).toBe(false);
  expect(await run(join(vault, 'new.txt'))).toBe(false);
  expect(await run(join(work, 'new.txt'), { ...bot, workdir: reader })).toBe(true);
  expect(
    await allowClaudeTool(
      bot,
      'Bash',
      {
        command: command('new.txt') + ' "' + join(vault, 'private.txt') + '"',
      },
      vault,
    ),
  ).toBe(false);
});

it.each([
  `python -c "open(target, 'w').write('data')"`,
  `python -c "Path(target).write_text('data')"`,
  `python -c "target.write_bytes(b'data')"`,
  `node -e "fs.writeFileSync(target, 'data')"`,
  `node -e "fs.promises.writeFile(target, 'data')"`,
  `powershell -c "[IO.File]::WriteAllText($target, 'data')"`,
])('requires a writable cwd for unresolved inline write targets: %s', async (command) => {
  directory = await temporaryDirectory();
  const work = join(directory, 'work');
  const reader = join(directory, 'reader');
  await mkdir(work);
  await mkdir(reader);
  const bot = testBot(work, { readScope: [work, reader] });
  expect(commandMayWrite(command)).toBe(true);
  expect(await allowClaudeTool(bot, 'Bash', { command })).toBe(true);
  expect(
    await allowClaudeTool({ ...bot, sandbox: 'danger-full-access' }, 'Bash', { command }),
  ).toBe(true);
  expect(await allowClaudeTool({ ...bot, workdir: reader }, 'Bash', { command })).toBe(false);
  expect(await allowClaudeTool({ ...bot, sandbox: 'read-only' }, 'Bash', { command })).toBe(false);
});

it('exempts app-owned team tools from MCP path and deletion filters while checking provenance', async () => {
  directory = await temporaryDirectory();
  const bot = testBot(directory, {
    sandbox: 'read-only',
    writeScope: [],
    connections: ['team'],
  });
  const vault = join(directory, 'vault');
  const input = { id: 'routine', path: vault };
  for (const tool of ['delete_routine', 'delete_room', 'create_bot', 'remember']) {
    const name = 'mcp__team__' + tool;
    expect(await allowClaudeTool(bot, name, input, vault)).toBe(true);
    expect(await allowClaudeTool(bot, name, input, vault, { name: 'team', source: 'sdk' })).toBe(
      true,
    );
    expect(await allowClaudeTool(bot, name, input, vault, { name: 'team', source: 'user' })).toBe(
      false,
    );
    expect(await allowClaudeTool(bot, name, input, vault, { name: 'other', source: 'sdk' })).toBe(
      false,
    );
  }
});
afterEach(async () => {
  if (directory) await removeTemporary(directory);
});
it('uses path boundaries and canonical paths, denying traversal and symlink escapes', async () => {
  directory = await temporaryDirectory();
  const root = join(directory, 'workspace');
  const outside = join(directory, 'workspace-extra');
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(await inScope(join(root, 'new.ts'), [root])).toBe(true);
  expect(await inScope(join(root, '../workspace-extra/file'), [root])).toBe(false);
  expect(await inScope(join(root, 'escape/file'), [root])).toBe(false);
  const bot = testBot(root);
  expect(await allowClaudeTool(bot, 'Write', { file_path: join(root, 'ok.ts') })).toBe(true);
  expect(
    await allowClaudeTool(
      bot,
      'Write',
      { file_path: join(root, 'knowledge/info.md') },
      join(root, 'knowledge'),
    ),
  ).toBe(false);
  expect(
    await allowClaudeTool({ ...bot, sandbox: 'read-only' }, 'Edit', {
      file_path: join(root, 'ok.ts'),
    }),
  ).toBe(false);
  expect(await allowClaudeTool(bot, 'mcp__unknown', {})).toBe(false);
  expect(await allowClaudeTool(bot, 'Read', { file_path: join(outside, 'secret') })).toBe(false);
});

it('checks native tools and MCP URIs against the same canonical roots through short-name aliases', async () => {
  directory = await temporaryDirectory();
  const home = join(directory, 'runneradmin');
  const alias = join(directory, 'RUNNER~1');
  const work = join(home, 'work');
  const outside = join(home, 'work-extra');
  await mkdir(work, { recursive: true });
  await mkdir(outside);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(home, alias, linkType);
  await symlink(outside, join(work, 'escape'), linkType);
  await writeFile(join(work, 'existing file.md'), 'hello');
  for (const root of [work, join(alias, 'work')]) {
    const bot = testBot(root, { connections: ['filesystem'] });
    for (const spelling of [work, join(alias, 'work')]) {
      for (const tail of ['existing file.md', 'missing/nested/new file.md']) {
        const path = join(spelling, tail);
        expect(await inScope(path, [root + '/'])).toBe(true);
        expect(await inScope(relative(process.cwd(), path), [root])).toBe(true);
        for (const name of ['Read', 'Write', 'Edit'])
          expect(await allowClaudeTool(bot, name, { file_path: path })).toBe(true);
        for (const name of ['read_file', 'write_file', 'delete_file'])
          for (const input of [{ path }, { uri: pathToFileURL(path).href }])
            expect(await allowClaudeTool(bot, 'mcp__filesystem__' + name, input)).toBe(true);
      }
      for (const path of [
        join(outside, 'file.md'),
        spelling + '/../work-extra/file.md',
        join(spelling, 'escape', 'file.md'),
      ]) {
        expect(await inScope(path, [root])).toBe(false);
        expect(await allowClaudeTool(bot, 'Write', { file_path: path })).toBe(false);
        expect(
          await allowClaudeTool(bot, 'mcp__filesystem__delete_file', {
            uri: pathToFileURL(path).href,
          }),
        ).toBe(false);
      }
    }
  }
});

it('denies unresolved symlinks and indirect MCP paths instead of treating them as new files', async () => {
  directory = await temporaryDirectory();
  const work = join(directory, 'work');
  await mkdir(work);
  const dangling = join(work, 'dangling');
  await symlink(
    join(directory, 'missing'),
    dangling,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(inScope(join(dangling, 'file.md'), [work])).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(inScope(join(work, 'file.md'), [dangling])).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const bot = testBot(work, { connections: ['filesystem'] });
  for (const path of [dangling, join(dangling, 'file.md'), '~', '~/file.md', '%TEMP%/file.md'])
    expect(await allowClaudeTool(bot, 'mcp__filesystem__write_file', { path })).toBe(false);
  expect(
    await allowClaudeTool(bot, 'mcp__filesystem__write_file', {
      uri: pathToFileURL(join(dangling, 'file.md')).href,
    }),
  ).toBe(false);
});

it('rejects canonical knowledge overlap in read scopes while preserving sibling prefixes', async () => {
  directory = await temporaryDirectory();
  const vault = join(directory, 'vault');
  const project = join(directory, 'vault-project');
  const alias = join(directory, 'vault-link');
  await mkdir(vault);
  await mkdir(project);
  await symlink(vault, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const bot = testBot(project);
  await expect(assertKnowledgeScope(bot, vault)).resolves.toBeUndefined();
  for (const patch of [
    { readScope: [vault] },
    { readScope: [directory] },
    { readScope: [join(alias, 'new')] },
    { workdir: alias },
    { writeScope: [join(alias, 'new')] },
    { workdir: directory },
  ])
    await expect(assertKnowledgeScope({ ...bot, ...patch }, vault)).rejects.toThrow(
      'errors.knowledgeScope',
    );
  await expect(
    assertKnowledgeScope({ ...bot, id: 'chief', system: true, workdir: vault }, vault),
  ).resolves.toBeUndefined();
});

it('denies filesystem MCP access to relative and absolute vault paths at any depth', async () => {
  directory = await temporaryDirectory();
  const project = join(directory, 'project');
  const vault = join(directory, 'vault');
  const alias = join(directory, 'vault-link');
  await mkdir(project);
  await mkdir(vault);
  await symlink(vault, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const bot = testBot(project, { connections: ['filesystem'] });
  const file = join(vault, 'notes.md');
  const inputs = [
    { path: file },
    { path: file.replace(/\\/g, '/') },
    { path: pathToFileURL(file).href },
    { path: '../vault/note.md' },
    { query: { files: [{ location: join(alias, 'notes.md') }, '../vault-link/notes.md'] } },
  ];
  if (process.platform === 'win32')
    inputs.push(
      { path: '\\\\?\\' + file },
      { path: file.toUpperCase() },
      { path: '..\\vault\\note.md' },
    );
  for (const input of inputs) {
    expect(await allowClaudeTool(bot, 'mcp__filesystem__read_file', input, vault)).toBe(false);
    expect(
      await allowClaudeTool(
        { ...bot, id: 'chief', system: true },
        'mcp__filesystem__read_file',
        input,
        vault,
      ),
    ).toBe(true);
  }
  expect(
    await allowClaudeTool(bot, 'mcp__filesystem__read_file', { path: 'notes.md' }, vault),
  ).toBe(true);
  for (const actor of [bot, { ...bot, id: 'chief', system: true }])
    expect(
      await allowClaudeTool(actor, 'mcp__filesystem__read_file', { files: [null] }, vault),
    ).toBe(false);
  expect(await allowClaudeTool(bot, 'mcp__team__create_bot', { workdir: vault }, vault)).toBe(true);
  expect(
    await allowClaudeTool(
      { ...bot, connections: ['*'] },
      'mcp__team__read_file',
      { path: file },
      vault,
      { name: 'team', source: 'user' },
    ),
  ).toBe(false);
});

it.each(['Glob', 'Grep'])(
  'checks traversal and absolute %s file filters against scopes and the vault',
  async (name) => {
    directory = await temporaryDirectory();
    const project = join(directory, 'project');
    const vault = join(directory, 'vault');
    await mkdir(project);
    await mkdir(vault);
    const bot = testBot(project, { readScope: [directory] });
    const field = name === 'Glob' ? 'pattern' : 'glob';
    for (const input of [
      { [field]: '../vault/**/*' },
      { path: project, [field]: '../vault/**/*' },
      { glob: '../vault/**/*', pattern: 'needle' },
      { [field]: join(vault, '**/*') },
      { glob: pathToFileURL(join(vault, '**/*')).href },
    ])
      expect(await allowClaudeTool(bot, name, input, vault)).toBe(false);
    expect(await allowClaudeTool(testBot(project), name, { [field]: '../outside/**/*' })).toBe(
      false,
    );
    expect(
      await allowClaudeTool(
        bot,
        name,
        { path: join(project, 'nested'), glob: '../../vault/**/*' },
        vault,
      ),
    ).toBe(false);
    for (const pattern of ['**/*.ts', 'foo..bar', '../project/**/*.ts', join(project, '**/*.ts')])
      expect(await allowClaudeTool(bot, name, { [field]: pattern }, vault)).toBe(true);
  },
);

it('checks embedded options and the destinations of common file-writing commands', async () => {
  directory = await temporaryDirectory();
  const work = join(directory, 'work');
  const reader = join(directory, 'reader');
  const vault = join(directory, 'vault');
  for (const path of [work, reader, vault]) await mkdir(path);
  const bot = testBot(work, { readScope: [work, reader] });
  const run = (command: string, actor = bot) => allowClaudeTool(actor, 'Bash', { command }, vault);
  const readonly = { ...bot, sandbox: 'read-only' as const, writeScope: [] };
  const quote = (value: string) => '"' + value.replace(/\\/g, '/') + '"';
  const targets = [
    ...[
      'cp',
      'mv',
      'rsync',
      'install',
      'ln',
      'Copy-Item',
      'cpi',
      'copy',
      'Move-Item',
      'mi',
      'move',
    ].map((name) => (target: string) => name + ' a ' + quote(target)),
    (target: string) => 'cp -t' + quote(target) + ' a',
    (target: string) => 'cp --target-directory=' + quote(target) + ' a',
    (target: string) => 'mv -t ' + quote(target) + ' a',
    (target: string) => 'Copy-Item -Destination:' + quote(target) + ' -Path a',
    (target: string) => 'Move-Item -Path a -Destination ' + quote(target),
    ...[
      'touch',
      'mkdir',
      'tee',
      'New-Item',
      'ni',
      'Set-Content',
      'sc',
      'Add-Content',
      'ac',
      'Out-File',
      'Rename-Item',
      'ren',
    ].map((name) => (target: string) => name + ' ' + quote(target)),
    (target: string) => 'New-Item -ItemType Directory -Path:' + quote(target),
    (target: string) => 'install -d ' + quote(target),
    (target: string) => 'dd if=a of=' + quote(target),
    (target: string) => 'sed -i "s/api/value/g" ' + quote(target),
    (target: string) => 'sed -i -e "s/api/value/g" ' + quote(target),
    (target: string) => 'git checkout -- ' + quote(target),
    (target: string) => 'git restore --source=HEAD ' + quote(target),
  ];
  await Promise.all(
    targets.map(async (command) => {
      expect(await run(command(join(work, 'new'))), command('new')).toBe(true);
      for (const target of [
        join(reader, 'new'),
        join(vault, 'new'),
        join(directory, 'outside', 'new'),
      ])
        expect(await run(command(target)), command(target)).toBe(false);
      expect(await run(command('new'), readonly), command('new')).toBe(false);
      expect(await run(command('new'), { ...bot, workdir: reader }), command('new')).toBe(false);
    }),
  );
  for (const option of ['-LiteralPath:', '--opt=', '-Opt:', '-t']) {
    const command = 'Get-Content ' + option + quote(join(vault, 'x'));
    expect(await run(command), command).toBe(false);
  }
  for (const command of [
    'npm install',
    'npm ci',
    'pnpm install',
    'pnpm add package',
    'yarn',
    'yarn install',
    'yarn add package',
  ]) {
    expect(await run(command), command).toBe(true);
    expect(await run(command, readonly), command).toBe(false);
    expect(await run(command, { ...bot, workdir: reader }), command).toBe(false);
  }
  expect(await run('npm install --prefix ' + quote(reader))).toBe(false);
  expect(await run('cp -t../reader a')).toBe(false);
  expect(await run('Set-Content -Path new -Path ' + quote(join(reader, 'new')) + ' -Value x')).toBe(
    false,
  );
  expect(await run('cp ' + quote(join(reader, 'source')) + ' new')).toBe(true);
  const alias = join(work, 'reader-link');
  await symlink(reader, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(await run('touch ' + quote(join(alias, 'new')))).toBe(false);
});

it('allows normal developer commands, patterns and fd/null redirects in readable directories', async () => {
  directory = await temporaryDirectory();
  const work = join(directory, 'work');
  const vault = join(directory, 'vault');
  await mkdir(join(work, 'src'), { recursive: true });
  await mkdir(vault);
  await writeFile(join(work, 'README.md'), 'Read me');
  await writeFile(join(work, 'patterns.txt'), '../');
  const bot = testBot(work);
  const readonly = { ...bot, sandbox: 'read-only' as const, writeScope: [] };
  const run = (command: string, actor = bot) => allowClaudeTool(actor, 'Bash', { command }, vault);
  const normal = [
    'npm test 2>&1',
    'npm test 1>&2',
    'npm test >&2',
    'npm test 2>/dev/null',
    'npm test >$null',
    'npm test > NUL',
    'npm test 2>nul',
    'npm test &> /dev/null',
    'npm test &>> NUL',
    'rg -n "/api/" src',
    'rg -F -C 2 "../" src',
    'grep -A 2 "../" notes.txt',
    'grep -B2 -m 1 "../" notes.txt',
    'rg --context=2 --max-count 3 "../" src',
    'rg -F -g "*.ts" -t js "../" src',
    'rg --glob "*.ts" --type js "../" src',
    'rg -F -e "../" src',
    'rg -m1 -e../ src',
    'rg -f patterns.txt src',
    'grep -F -f patterns.txt README.md',
    'git grep -C 2 "../" -- src',
    'rg -F -C 2 "' + vault.replace(/\\/g, '/') + '" src',
    'grep "/api/" notes.txt',
    'grep -r "TODO" .',
    'rg --regexp="/api/" src',
    'rg -g "*.ts" "/api/" src',
    'grep -e "/api/" README.md',
    'ag "/api/" src',
    'ack "/api/" src',
    'findstr "/api/" README.md',
    'Select-String -Pattern:"/api/" -Path README.md',
    'git grep "/api/"',
    'sed -n "/api/p" README.md',
    'awk "/api/ {print}" README.md',
    'git status',
    'git diff',
    'node x.js',
    'python -m pytest',
    'ls -la',
    'cat README.md',
    'Get-ChildItem',
    'pnpm test',
    'yarn test',
    'echo src/missing',
    'grep "' + vault.replace(/\\/g, '/') + '" README.md',
  ];
  if (process.platform === 'win32') normal.push('cat /penathon-missing-read-target/');
  for (const command of normal) {
    expect(await run(command), command).toBe(true);
    expect(await run(command, readonly), command).toBe(true);
  }
  expect(await run('npm run build > build.log')).toBe(true);
  expect(await run('npm run build > build.log', readonly)).toBe(false);
  expect(await run('npm test &> build.log')).toBe(true);
  expect(await run('npm test &> build.log', readonly)).toBe(false);
  expect(await run('grep -e "/api/" "' + vault + '"')).toBe(false);
  expect(await run('rg -F -C 2 "../" "' + vault + '"')).toBe(false);
});

it('requires writable sources as well as destinations for moves and renames', async () => {
  directory = await temporaryDirectory();
  const work = join(directory, 'work');
  const reader = join(directory, 'reader');
  const vault = join(directory, 'vault');
  for (const path of [work, reader, vault]) await mkdir(path);
  const bot = testBot(work, { readScope: [work, reader] });
  const run = (command: string) => allowClaudeTool(bot, 'Bash', { command }, vault);
  await Promise.all(
    ['mv', 'Move-Item', 'mi', 'move', 'ren', 'Rename-Item', 'git mv'].map(async (name) => {
      const command = (source: string) =>
        name + ' "' + join(source, 'f') + '" "' + join(work, 'new') + '"';
      expect(await run(command(work)), name).toBe(true);
      for (const source of [reader, vault, join(directory, 'outside')])
        expect(await run(command(source)), command(source)).toBe(false);
    }),
  );
  expect(await run('Move-Item -Path "' + join(reader, 'f') + '" -Destination new')).toBe(false);
  expect(await run('Rename-Item -LiteralPath:"' + join(reader, 'f') + '" -NewName new')).toBe(
    false,
  );
  expect(await run('mv -t . a "' + join(reader, 'f') + '"')).toBe(false);
  expect(await run('git -C . mv "' + join(reader, 'f') + '" new')).toBe(false);
  expect(await run('cp "' + join(reader, 'f') + '" new')).toBe(true);
});

it('resolves git global directories and checks every writing subcommand against its cwd', async () => {
  directory = await temporaryDirectory();
  const work = join(directory, 'work');
  const reader = join(directory, 'reader');
  const vault = join(directory, 'vault');
  for (const path of [join(work, 'nested'), reader, vault]) await mkdir(path, { recursive: true });
  await writeFile(join(reader, 'change.patch'), 'patch input');
  const bot = testBot(work, { readScope: [work, reader] });
  const readonly = { ...bot, sandbox: 'read-only' as const, writeScope: [] };
  const run = (command: string, actor = bot) => allowClaudeTool(actor, 'Bash', { command }, vault);
  const writing = [
    'restore -- f',
    'checkout -- f',
    'checkout f',
    'checkout HEAD~1 -- f',
    'checkout HEAD~1',
    'reset --hard',
    'clean -fd',
    'rm -- f',
    'mv a b',
    'apply change.patch',
    'am change.patch',
    'merge main',
    'rebase main',
    'pull',
    'stash pop',
    'stash apply',
    'switch main',
    'commit -m "message ../api"',
  ];
  await Promise.all(
    writing.map(async (subcommand) => {
      const command = (cwd: string) =>
        'git --no-pager -P -c color.ui=false -C "' + cwd + '" ' + subcommand;
      expect(await run(command(work)), subcommand).toBe(true);
      expect(await run(command(work), readonly), subcommand).toBe(false);
      for (const cwd of [reader, vault, join(directory, 'outside')])
        expect(await run(command(cwd)), command(cwd)).toBe(false);
      expect(
        await run(
          'git --git-dir="' + join(work, '.git') + '" --work-tree="' + reader + '" ' + subcommand,
        ),
        subcommand,
      ).toBe(false);
    }),
  );
  for (const subcommand of ['status', 'diff', 'grep -F -C 2 "../" -- f']) {
    expect(await run('git -C "' + reader + '" ' + subcommand), subcommand).toBe(true);
    expect(
      await run(
        'git --git-dir="' + join(work, '.git') + '" --work-tree="' + reader + '" ' + subcommand,
      ),
      subcommand,
    ).toBe(true);
  }
  expect(await run('git -C . -C nested -c a=b restore -- f')).toBe(true);
  expect(await run('git -C nested restore -- ../../reader/f')).toBe(false);
  expect(await run('git -C . restore -- ../reader/f')).toBe(false);
  expect(await run('git checkout "' + join(reader, 'f') + '"')).toBe(false);
  expect(await run('git checkout HEAD~1 -- "' + join(reader, 'f') + '"')).toBe(false);
  expect(
    await run('git --git-dir "' + join(work, '.git') + '" --work-tree . commit -m message'),
  ).toBe(true);
  expect(
    await run(
      'git --git-dir="' + join(reader, '.git') + '" --work-tree="' + work + '" commit -m message',
    ),
  ).toBe(false);
  expect(
    await run('git --work-tree="' + work + '" restore -- f', { ...bot, workdir: reader }),
  ).toBe(true);
  expect(await run('git -C "' + reader + '" status > out.log')).toBe(true);
  expect(await run('git -C "' + work + '" status > out.log', { ...bot, workdir: reader })).toBe(
    false,
  );
  expect(await run('git apply "' + join(reader, 'change.patch') + '"')).toBe(true);
});

it('accepts connector text, outside relative paths and malformed paths without throwing', async () => {
  directory = await temporaryDirectory();
  const project = join(directory, 'project');
  const vault = join(directory, 'vault');
  await mkdir(project);
  await mkdir(vault);
  const bot = testBot(project, { connections: ['mail'] });
  for (const body of [
    'x'.repeat(40_000),
    'file:// this is ordinary text',
    'file:///%ZZ',
    join(project, 'x'.repeat(1025)),
    vault + '\nordinary text',
    vault + '\rordinary text',
    vault + '\u2028ordinary text',
    'merhaba dünya',
    'notes.md',
    './notes.md',
    '../outside/notes.md',
  ])
    await expect(
      allowClaudeTool(bot, 'mcp__mail__send', { message: { body } }, vault),
    ).resolves.toBe(true);
  for (const body of [
    vault.padEnd(1024, '/'),
    vault.padEnd(32_769, '/'),
    join(vault, 'invalid\0path'),
  ])
    expect(await allowClaudeTool(bot, 'mcp__mail__send', { body }, vault)).toBe(false);
  expect(
    await allowClaudeTool(
      bot,
      'mcp__mail__send',
      { body: 'file:// this is ordinary text', attachment: join(vault, 'notes.md') },
      vault,
    ),
  ).toBe(false);
});

it('denies recursive MCP listings outside scope even for Chief and allows explicitly granted ancestors', async () => {
  directory = await temporaryDirectory();
  const project = join(directory, 'vault-project');
  const vault = join(directory, 'vault');
  await mkdir(project);
  await mkdir(vault);
  const bot = testBot(project, { connections: ['filesystem'] });
  for (const path of [directory, pathToFileURL(directory).href, join(project, '..')]) {
    expect(await allowClaudeTool(bot, 'mcp__filesystem__directory_tree', { path }, vault)).toBe(
      false,
    );
    expect(
      await allowClaudeTool(
        { ...bot, id: 'chief', system: true },
        'mcp__filesystem__directory_tree',
        { path },
        vault,
      ),
    ).toBe(false);
    expect(
      await allowClaudeTool(
        { ...bot, id: 'chief', system: true, readScope: [directory] },
        'mcp__filesystem__directory_tree',
        { path },
        vault,
      ),
    ).toBe(true);
  }
  for (const path of [project, pathToFileURL(project).href, join(project, 'notes.md')])
    expect(await allowClaudeTool(bot, 'mcp__filesystem__directory_tree', { path }, vault)).toBe(
      true,
    );
});

it('treats Grep patterns as regexes while still checking its path and glob', async () => {
  directory = await temporaryDirectory();
  const project = join(directory, 'project');
  const vault = join(directory, 'vault');
  await mkdir(project);
  await mkdir(vault);
  const bot = testBot(project);
  for (const pattern of ['\\bTODO\\b', '/api/v1/users', '..']) {
    expect(await allowClaudeTool(bot, 'Grep', { pattern }, vault)).toBe(true);
    expect(await allowClaudeTool(bot, 'Grep', { pattern, path: project }, vault)).toBe(true);
    expect(await allowClaudeTool(bot, 'Grep', { pattern, path: vault }, vault)).toBe(false);
    expect(await allowClaudeTool(bot, 'Grep', { pattern, glob: '../vault/**/*' }, vault)).toBe(
      false,
    );
  }
});

it('normalizes padded relative paths and trailing separators before checking the vault', async () => {
  directory = await temporaryDirectory();
  const project = join(directory, 'project');
  const vault = join(directory, 'vault');
  await mkdir(project);
  await mkdir(vault);
  const bot = testBot(project, { connections: ['filesystem'] });
  for (const path of [
    '../' + './'.repeat(1000) + 'vault/x',
    '../' + './'.repeat(16_000) + 'vault/x',
    '../vault/',
    '../vault' + '/'.repeat(2000),
    vault + '/'.repeat(2000),
    vault.padEnd(32_768, '/'),
    '../' + './'.repeat(20_000) + 'vault/x',
  ])
    expect(
      await allowClaudeTool(bot, 'mcp__filesystem__read_file', { files: [{ path }] }, vault),
    ).toBe(false);
});

it.each(['native', 'forward-slash'] as const)(
  'checks Bash arguments and output targets with %s paths for Writer, Reader and Chief',
  async (style) => {
    directory = await temporaryDirectory();
    const work = join(directory, 'work');
    const reader = join(directory, 'reader');
    const vault = join(directory, 'vault');
    for (const path of [work, reader, vault]) await mkdir(path);
    const path = (value: string) => (style === 'forward-slash' ? value.replace(/\\/g, '/') : value);
    const bot = testBot(work, { readScope: [work, reader] });
    const run = (command: string, actor = bot) =>
      allowClaudeTool(actor, 'Bash', { command }, vault);
    for (const command of [
      'npm test',
      'git status',
      'ls',
      'node script.js',
      'python -m pytest',
      'grep "rm" notes.txt',
    ])
      expect(await run(command)).toBe(true);
    for (const command of [
      'git diff > out.txt',
      'git diff >> out.txt',
      'git diff 2> errors.txt',
      'echo x | tee out.txt',
      'echo x | Out-File -FilePath out.txt',
      'Set-Content -Path out.txt -Value x',
      'Out-File -Encoding utf8 out.txt',
    ]) {
      expect(await run(command)).toBe(true);
      expect(await run(command, { ...bot, workdir: reader })).toBe(false);
      expect(await run(command, { ...bot, sandbox: 'read-only', writeScope: [] })).toBe(false);
    }
    for (const command of [
      'cat "' + path(join(vault, 'a')) + '"',
      'find -P "' + path(join(vault, 'x')) + '" -delete',
      'echo x > "' + path(join(reader, 'out.txt')) + '"',
      'echo x > "' + path(join(directory, 'outside', 'x')) + '"',
      'echo x > C:/dışarı/x',
      'echo x > /outside/x',
      'cat ../outside/x',
      'cat --file=' + path(join(directory, 'outside', 'x')),
      'echo x | tee "' + path(join(reader, 'out.txt')) + '"',
      'Set-Content -Value x -Path "' + path(join(reader, 'out.txt')) + '"',
      'Set-Content -Path:"' + path(join(reader, 'out.txt')) + '" x',
      'git status; cat "' + path(join(vault, 'a')) + '"',
      'git status && cat "' + path(join(vault, 'a')) + '"',
      'git status || cat "' + path(join(vault, 'a')) + '"',
      'ls & cat "' + path(join(vault, 'a')) + '"',
      'cat < "' + path(join(vault, 'a')) + '"',
    ])
      expect(await run(command), command).toBe(false);
    const chief = { ...bot, id: 'chief', system: true };
    expect(await run('cat "' + path(join(vault, 'a')) + '"', chief)).toBe(true);
    expect(await run('git diff > "' + path(join(vault, 'out.txt')) + '"', chief)).toBe(true);
    expect(await run('cat "' + path(join(directory, 'outside', 'a')) + '"', chief)).toBe(false);
    expect(await run('ls', { ...bot, sandbox: 'read-only', writeScope: [] })).toBe(true);
    expect(await run('rm a.txt', { ...bot, sandbox: 'read-only', writeScope: [] })).toBe(false);
  },
);
it.each([
  `node -e "fs.rm('old', {}, () => {})"`,
  `node -e "fs.rmSync('old')"`,
  `node -e "fs.unlink('old', () => {})"`,
  `node -e "fs.promises.rm('old')"`,
  `node -e "fs.promises.unlink('old')"`,
  `py -c "import os; os.remove('old')"`,
  `py -3 -c "import os; os.remove('old')"`,
  `python3 -c "import os; os.remove('old')"`,
  `deno eval "Deno.rm('old')"`,
  `bun -e "require('fs').rm('old')"`,
])('classifies inline deletion and refuses Reader execution: %s', async (command) => {
  directory = await temporaryDirectory();
  const reader = testBot(directory, { sandbox: 'read-only', writeScope: [] });
  expect(commandMayWrite(command)).toBe(true);
  expect(await allowClaudeTool(reader, 'Bash', { command })).toBe(false);
});
it('checks inline copy sources as reads and both rename paths as writes', async () => {
  directory = await temporaryDirectory();
  const work = join(directory, 'work');
  const read = join(directory, 'read');
  const outside = join(directory, 'outside');
  for (const path of [work, read, outside]) await mkdir(path);
  const bot = testBot(work, { readScope: [work, read] });
  const run = (code: string) => allowClaudeTool(bot, 'Bash', { command: `node -e "${code}"` });
  expect(await run("fs.copyFile('../read/input', 'output', () => {})")).toBe(true);
  expect(await run("fs.copyFile('../outside/input', 'output', () => {})")).toBe(false);
  expect(await run("fs.rename('../read/input', 'output', () => {})")).toBe(false);
});

it('strips legacy vault read paths and ancestors at runtime without mutating the saved bot', async () => {
  directory = await temporaryDirectory();
  const project = join(directory, 'project');
  const vault = join(directory, 'vault');
  const bot = testBot(project, { readScope: [project, directory, vault, join(vault, 'nested')] });
  expect((await withoutKnowledge(bot, vault)).readScope).toEqual([project]);
  expect(bot.readScope).toHaveLength(4);
  const chief = { ...bot, id: 'chief', system: true };
  expect(await withoutKnowledge(chief, vault)).toBe(chief);
});
