import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import {
  accessRank,
  projectGrantSchema,
  type AccessLevel,
  type Project,
  type ProjectGrant,
} from '../../shared/projects';
import { watch, type FSWatcher } from 'chokidar';
import {
  botSchema,
  botDraftSchema,
  botPatchSchema,
  type Bot,
  type BotDraft,
  type BotPatch,
} from '../../shared/bots';
import { chiefAvatar, randomAvatar } from '../../shared/avatars';
import {
  assertProjectCeiling,
  assertCeiling,
  assertKnowledgeScope,
  assertNetworkCeiling,
  effectiveAccess,
  isChief,
  inScope,
} from '../engines/scopes';
import { atomicWrite } from '../settings';
import { redact } from '../engines/common';
import chiefTemplate from './chief.md?raw';
import { legacyChiefInstructions } from './legacy-chief';
import {
  routineDraftSchema,
  routineSchema,
  type Routine,
  type RoutineDraft,
} from '../../shared/routines';
import { vaultRoutine } from '../routines';

export function parseBot(source: string): Bot {
  const reject = () => {
    throw new Error('errors.botInvalid');
  };
  const { data, content } = matter(source, { engines: { javascript: reject, json: reject } });
  if (Array.isArray(data.routines))
    data.routines = data.routines.filter((routine: unknown) => {
      if (
        routine &&
        typeof routine === 'object' &&
        'schedule' in routine &&
        typeof routine.schedule === 'string'
      ) {
        console.warn('Skipped legacy routine:', data.id);
        return false;
      }
      return true;
    });
  const bot = botSchema.parse({
    ...(data.id === 'chief' ? { avatar: chiefAvatar, connections: ['*'], network: true } : {}),
    ...data,
    instructions: content.trim(),
  });
  if (![bot.workdir, ...bot.readScope, ...bot.writeScope].every(isAbsolute))
    throw new Error('errors.absolutePath');
  if (bot.id === 'chief' && !bot.system) throw new Error('errors.chiefProtected');
  return bot;
}
export function chiefBot(workdir: string, language: 'tr' | 'en'): Bot {
  const instructions =
    language === 'tr'
      ? chiefTemplate.split('<!-- tr -->')[1].split('<!-- en -->')[0].trim()
      : chiefTemplate.split('<!-- en -->')[1].trim();
  return botSchema.parse({
    id: 'chief',
    name: language === 'tr' ? 'Şef' : 'Chief',
    engine: 'claude',
    avatar: chiefAvatar,
    connections: ['*'],
    network: true,
    workdir,
    readScope: [workdir],
    writeScope: [workdir],
    system: true,
    routines: [vaultRoutine],
    instructions,
  });
}
export class BotStore extends EventEmitter {
  private bots = new Map<string, Bot>();
  private watcher?: FSWatcher;
  private queue = Promise.resolve();
  constructor(
    readonly dir: string,
    private seed: Bot,
    private knowledgeDir: () => string | undefined = () => undefined,
    private secrets: () => string[] | Promise<string[]> = () => [],
    private projects: () => Project[] = () => [],
  ) {
    super();
  }
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      this.projectApprovals = z
        .record(botSchema.shape.id, z.array(projectGrantSchema))
        .parse(JSON.parse(await readFile(join(this.dir, 'project-grants.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const entries = await readdir(this.dir);
    for (const file of entries.filter((file) => file.endsWith('.md'))) await this.load(file);
    if (!this.bots.has('chief')) {
      if (entries.includes('chief.md')) throw new Error('errors.botInvalid');
      await this.save({
        ...this.seed,
        routines: this.seed.routines.map((routine) =>
          routine.id === vaultRoutine.id ? { ...routine, enabled: !!this.knowledgeDir() } : routine,
        ),
        instructions: '',
      });
    }
    const chief = this.get(this.seed.id);
    if (legacyChiefInstructions.includes(chief.instructions))
      await this.save({ ...chief, instructions: '' });
    await this.syncVaultRoutine(false);
    this.watcher = watch(this.dir, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.watcher.on('all', (event, path) => {
      if (!path.endsWith('.md') || resolve(dirname(path)) !== resolve(this.dir)) return;
      this.queue = this.queue
        .then(() =>
          this.mutate(async () => {
            const id = basename(path, '.md');
            if (event === 'unlink') {
              try {
                await lstat(path);
                return this.load(basename(path));
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
              if (id === 'chief')
                await this.persist(this.bots.get('chief') ?? { ...this.seed, instructions: '' });
              else {
                this.bots.delete(id);
                this.emit('changed');
              }
            } else if (event === 'add' || event === 'change') await this.load(basename(path));
          }),
        )
        .catch(() => {
          this.emit('invalid', 'errors.botInvalid');
        });
    });
    this.watcher.on('error', () => this.emit('invalid', 'errors.botInvalid'));
    await new Promise<void>((resolve) => this.watcher!.once('ready', resolve));
  }
  private async load(file: string): Promise<void> {
    try {
      const path = join(this.dir, file);
      if ((await lstat(path)).isSymbolicLink()) throw new Error('errors.botInvalid');
      const source = await readFile(path, 'utf8');
      const bot = parseBot(source);
      if (bot.id !== basename(file, '.md')) throw new Error('errors.botInvalid');
      if (isChief(bot)) {
        const { data, content } = matter(source);
        if (data.network === undefined)
          await atomicWrite(path, matter.stringify(content, { ...data, network: true }));
      }
      this.bots.set(bot.id, bot);
      this.emit('changed');
    } catch {
      this.emit('invalid', 'errors.botInvalid');
    }
  }
  list(): Bot[] {
    return [...this.bots.values()].sort((a, b) =>
      a.id === 'chief' ? -1 : b.id === 'chief' ? 1 : a.name.localeCompare(b.name),
    );
  }
  get(id: string): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw new Error('errors.botMissing');
    return structuredClone(bot);
  }
  setLanguage(language: 'tr' | 'en'): void {
    this.seed = chiefBot(this.seed.workdir, language);
  }
  forRun(id: string): Bot {
    const bot = this.get(id);
    if (bot.system && bot.id === this.seed.id)
      bot.instructions = [this.seed.instructions, bot.instructions].filter(Boolean).join('\n\n');
    return bot;
  }
  save(input: Bot): Promise<Bot> {
    return this.mutate(() => this.persist(input));
  }
  private projectApprovals: Record<string, ProjectGrant[]> = {};
  private async ceiling(bot: Bot, parent: Bot): Promise<void> {
    const workspace = join(this.dir, 'workspaces', bot.id);
    if (bot.workdir === workspace && (await inScope(workspace, [this.dir]))) {
      // A bot keeps its own managed workspace after a project is revoked.
      parent = {
        ...parent,
        readScope: [...parent.readScope, workspace],
        writeScope: [...parent.writeScope, ...(parent.sandbox === 'read-only' ? [] : [workspace])],
      };
    }
    return assertCeiling(
      bot,
      parent,
      this.projects(),
      this.bots.has(bot.id) ? (this.projectApprovals[bot.id] ?? []) : [],
    );
  }
  private async validateProjects(bot: Bot): Promise<void> {
    if (!isChief(bot)) assertNetworkCeiling(bot, this.get(bot.parent ?? 'chief'));
    else
      for (const child of this.list().filter((child) => !isChief(child) && !child.parent))
        assertNetworkCeiling(child, bot);
    const seen = new Set<string>();
    for (const grant of bot.projects) {
      if (
        seen.has(grant.project) ||
        !this.projects().some((project) => project.id === grant.project)
      )
        throw new Error('errors.projectMissing');
      seen.add(grant.project);
    }
    await assertKnowledgeScope(bot, this.knowledgeDir(), this.projects());
  }
  private async persist(input: Bot, enforceCeiling = true): Promise<Bot> {
    const { instructions, ...metadata } = botSchema.parse(input);
    if (
      metadata.id === 'chief' &&
      (!metadata.system || metadata.parent !== null || metadata.temporary)
    )
      throw new Error('errors.chiefProtected');
    if (metadata.id !== 'chief' && metadata.system) throw new Error('errors.chiefProtected');
    const previousBot = this.bots.get(metadata.id);
    for (const routine of metadata.routines) {
      if (routine.model === undefined) delete routine.model;
      this.checkRoutineName({ ...metadata, instructions }, routine.name);
      const before = previousBot?.routines.find((value) => value.id === routine.id);
      if (routine.system && !(metadata.id === 'chief' && routine.id === vaultRoutine.id))
        throw new Error('System routine protected');
      if (
        before?.system &&
        (routine.name !== before.name || routine.model !== before.model || !routine.system)
      )
        throw new Error('System routine protected');
    }
    if (new Set(metadata.routines.map((routine) => routine.id)).size !== metadata.routines.length)
      throw new Error('Duplicate routine ID');
    if (
      previousBot?.routines.some(
        (routine) => routine.system && !metadata.routines.some((value) => value.id === routine.id),
      )
    )
      throw new Error('System routine protected');
    await this.validateProjects({ ...metadata, instructions });
    const ceilings: [Bot, Bot][] = this.list()
      .filter((bot) => bot.parent === metadata.id)
      .map((child) => [child, { ...metadata, instructions }]);
    if (metadata.parent) {
      if (
        metadata.parent === metadata.id ||
        this.descendants(metadata.id).some((bot) => bot.id === metadata.parent)
      )
        throw new Error('Bot hiyerarşisi döngü içeremez.');
      ceilings.unshift([{ ...metadata, instructions }, this.get(metadata.parent)]);
    }
    if (enforceCeiling) for (const [child, parent] of ceilings) await this.ceiling(child, parent);
    const source = matter.stringify({ content: instructions }, metadata);
    const bot = parseBot(source);
    const previous = this.projectApprovals[bot.id];
    const approved = (previous ?? []).flatMap((grant) => {
      const current = bot.projects.find((value) => value.project === grant.project);
      return current
        ? [
            {
              project: grant.project,
              level:
                accessRank[current.level] < accessRank[grant.level] ? current.level : grant.level,
            },
          ]
        : [];
    });
    if (previous && JSON.stringify(previous) !== JSON.stringify(approved)) {
      this.projectApprovals[bot.id] = approved;
      await atomicWrite(
        join(this.dir, 'project-grants.json'),
        JSON.stringify(this.projectApprovals),
      );
    }
    await atomicWrite(join(this.dir, bot.id + '.md'), source);
    this.bots.set(bot.id, bot);
    this.emit('changed');
    return bot;
  }
  delete(id: string): Promise<void> {
    return this.mutate(() => this.remove(id));
  }
  private checkRoutineName(bot: Bot, name: string): void {
    const normalize = (value: string) =>
      value.trim().normalize('NFKC').toLocaleLowerCase('tr').replace(/ı/g, 'i');
    if (
      normalize(name) === normalize(bot.name) ||
      (bot.role && normalize(name) === normalize(bot.role))
    )
      throw new Error('Rutin adı rol değil işin adı olmalı.');
  }
  previewRoutine(botId: string, input: RoutineDraft, callerId?: string): Routine {
    if (callerId && !this.canManage(callerId, botId))
      throw new Error('Bu botun rutinlerini düzenleme iznin yok.');
    const bot = this.get(botId);
    const draft = routineDraftSchema.parse(input);
    const before = bot.routines.find((routine) => routine.id === draft.id);
    if (draft.id && !before) throw new Error('Routine missing');
    this.checkRoutineName(bot, draft.name);
    if (before?.system && (draft.name !== before.name || draft.model !== before.model))
      throw new Error('System routine protected');
    return routineSchema.parse({
      ...draft,
      id: before?.id ?? 'routine-' + randomUUID(),
      system: before?.system ?? false,
    });
  }
  saveRoutine(
    botId: string,
    input: RoutineDraft,
    callerId?: string,
    expected?: Routine,
  ): Promise<Routine> {
    return this.mutate(async () => {
      const bot = this.get(botId);
      if (
        expected &&
        JSON.stringify(bot.routines.find((routine) => routine.id === expected.id)) !==
          JSON.stringify(expected)
      )
        throw new Error('Routine changed while awaiting approval');
      const routine = this.previewRoutine(botId, input, callerId);
      bot.routines = [...bot.routines.filter((value) => value.id !== routine.id), routine];
      await this.persist(bot);
      return routine;
    });
  }
  createRoutine(botId: string, routine: Routine, callerId: string): Promise<Routine> {
    return this.mutate(async () => {
      if (!this.canManage(callerId, botId)) throw new Error('Routine permission denied');
      const bot = this.get(botId);
      if (bot.routines.some((value) => value.id === routine.id) || routine.system)
        throw new Error('Routine protected');
      await this.persist({ ...bot, routines: [...bot.routines, routine] });
      return routine;
    });
  }
  deleteRoutine(
    botId: string,
    routineId: string,
    callerId?: string,
    expected?: Routine,
  ): Promise<void> {
    return this.mutate(async () => {
      if (callerId && !this.canManage(callerId, botId))
        throw new Error('Routine permission denied');
      const bot = this.get(botId);
      const routine = bot.routines.find((value) => value.id === routineId);
      if (!routine || routine.system) throw new Error('Routine protected or missing');
      if (expected && JSON.stringify(routine) !== JSON.stringify(expected))
        throw new Error('Routine changed while awaiting approval');
      await this.persist({
        ...bot,
        routines: bot.routines.filter((value) => value.id !== routineId),
      });
    });
  }
  syncVaultRoutine(settingsChanged = true): Promise<void> {
    return this.mutate(async () => {
      const bot = this.get('chief');
      const existing = bot.routines.find((routine) => routine.id === vaultRoutine.id);
      const routine = existing ? { ...existing, system: true } : { ...vaultRoutine };
      if (!existing || settingsChanged || !this.knowledgeDir())
        routine.enabled = !!this.knowledgeDir();
      if (JSON.stringify(existing) !== JSON.stringify(routine))
        await this.persist({
          ...bot,
          routines: [...bot.routines.filter((value) => value.id !== routine.id), routine],
        });
    });
  }
  private reportRoots(): string[] {
    const knowledge = this.knowledgeDir();
    const grants = this.get('chief').projects;
    return [
      ...(knowledge ? [knowledge] : []),
      ...this.projects()
        .filter((project) =>
          grants.some((grant) => grant.project === project.id && grant.level !== 'read'),
        )
        .flatMap((project) => project.folders),
    ];
  }
  hasReportDestination(): boolean {
    return this.reportRoots().length > 0;
  }
  async validateReportDestination(into: string): Promise<string> {
    const roots = this.reportRoots();
    const candidates = isAbsolute(into)
      ? [into]
      : [...roots, this.get('chief').workdir].map((root) => resolve(root, into));
    const matches = new Map<string, string>();
    for (const candidate of new Set(candidates)) {
      try {
        if (!(await inScope(candidate, roots)) || !(await stat(candidate)).isFile()) continue;
        const path = await realpath(candidate);
        matches.set(process.platform === 'win32' ? path.toLowerCase() : path, path);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
    }
    if (matches.size > 1) throw new Error('Ambiguous report destination; use an absolute path');
    const [path] = matches.values();
    if (!path) throw new Error('Report destination must be a written note in an authorized folder');
    return path;
  }
  private async remove(id: string): Promise<void> {
    const bot = this.get(id);
    if (bot.id === 'chief' || bot.system) throw new Error('errors.chiefProtected');
    for (const child of this.list().filter((child) => child.parent === id))
      await this.remove(child.id);
    const memory = await this.memoryPath(id);
    await unlink(join(this.dir, `${bot.id}.md`));
    try {
      await unlink(memory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.bots.delete(id);
    delete this.projectApprovals[id];
    await atomicWrite(join(this.dir, 'project-grants.json'), JSON.stringify(this.projectApprovals));
    this.emit('changed');
  }
  descendants(id: string): Bot[] {
    const found = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const bot of this.bots.values())
        if (bot.parent && found.has(bot.parent) && !found.has(bot.id)) {
          found.add(bot.id);
          changed = true;
        }
    }
    return this.list().filter((bot) => bot.id !== id && found.has(bot.id));
  }
  canManage(callerId: string, id: string): boolean {
    return (
      isChief(this.get(callerId)) ||
      callerId === id ||
      this.descendants(callerId).some((bot) => bot.id === id)
    );
  }
  async draft(input: BotDraft, callerId = 'chief'): Promise<Bot> {
    const draft = botDraftSchema.parse(input);
    const caller = this.get(callerId);
    const parent = isChief(caller) ? (draft.parent ?? null) : callerId;
    if (!isChief(caller) && draft.parent !== undefined && draft.parent !== callerId)
      throw new Error('Alt botun üstü çağıran bot olmalı.');
    const superior = parent ? this.get(parent) : caller;
    const slug =
      draft.name
        .toLocaleLowerCase('tr')
        .replace(/ı/g, 'i')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 56) || 'bot';
    let id = slug;
    for (let n = 2; this.bots.has(id); n++) id = slug + '-' + n;
    const bot = botSchema.parse({
      ...draft,
      id,
      parent,
      avatar: draft.avatar ?? randomAvatar(this.list().map((bot) => bot.avatar)),
      workdir: draft.workdir ?? superior.workdir,
      readScope: draft.readScope ?? superior.readScope,
      writeScope: draft.writeScope ?? superior.writeScope,
      sandbox:
        draft.sandbox ?? (superior.sandbox === 'read-only' ? 'read-only' : 'workspace-write'),
      connections: draft.connections ?? [],
    });
    await this.validateProjects(bot);
    await this.ceiling(bot, superior);
    if (superior.id !== callerId) await this.ceiling(bot, caller);
    return bot;
  }
  private mutations = Promise.resolve();
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutations.then(operation);
    this.mutations = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  create(input: BotDraft | Bot, callerId = 'chief'): Promise<Bot> {
    return this.mutate(async () => {
      if (!('id' in input)) return this.persist(await this.draft(input, callerId));
      const bot = botSchema.parse(input);
      if (this.bots.has(bot.id))
        throw new Error('Onaylanan bot kimliği artık kullanımda; yeni bir oluşturma isteyin.');
      const caller = this.get(callerId);
      if (!isChief(caller) && bot.parent !== callerId)
        throw new Error('Alt botun üstü çağıran bot olmalı.');
      await this.ceiling(bot, caller);
      return this.persist(bot);
    });
  }
  async previewUpdate(id: string, input: BotPatch, callerId?: string): Promise<Bot> {
    const requester = callerId;
    callerId ??= 'chief';
    if (!this.canManage(callerId, id)) throw new Error('Bu botu düzenleme iznin yok.');
    const before = this.get(id);
    const patch = botPatchSchema.parse(input);
    const after = botSchema.parse({ ...before, ...patch });
    if (requester && patch.projects !== undefined)
      assertProjectCeiling(after, this.get(callerId), this.projectApprovals[id] ?? []);
    await this.validateProjects(after);
    if (id === 'chief' && (after.parent !== null || after.temporary))
      throw new Error('errors.chiefProtected');
    if (!isChief(this.get(callerId)))
      await this.ceiling(
        after,
        this.get(id === callerId && before.parent ? before.parent : callerId),
      );
    if (after.parent) {
      if (after.parent === id || this.descendants(id).some((bot) => bot.id === after.parent))
        throw new Error('Bot hiyerarşisi döngü içeremez.');
      await this.ceiling(after, this.get(after.parent));
    }
    for (const child of this.list().filter((bot) => bot.parent === id))
      await this.ceiling(child, after);
    return after;
  }
  update(id: string, patch: BotPatch, callerId?: string): Promise<Bot> {
    return this.mutate(async () => this.persist(await this.previewUpdate(id, patch, callerId)));
  }
  async checkProjectGrant(
    callerId: string,
    botId: string,
    projectId: string,
    level: AccessLevel | null,
  ): Promise<void> {
    const caller = this.get(callerId);
    const bot = this.get(botId);
    if (!this.projects().some((project) => project.id === projectId))
      throw new Error('errors.projectMissing');
    if (!isChief(caller)) {
      if (!this.descendants(callerId).some((bot) => bot.id === botId))
        throw new Error('Yalnız alt soyuna proje izni verebilirsin.');
      const grant = caller.projects.find((grant) => grant.project === projectId);
      if (!grant || (level !== null && accessRank[level] > accessRank[grant.level]))
        throw new Error('Proje izni kendi seviyeni aşamaz.');
    }
    if (level !== null)
      await assertKnowledgeScope(
        {
          ...bot,
          projects: [
            ...bot.projects.filter((grant) => grant.project !== projectId),
            { project: projectId, level },
          ],
        },
        this.knowledgeDir(),
        this.projects(),
      );
  }
  grantProject(
    callerId: string,
    botId: string,
    projectId: string,
    level: AccessLevel | null,
  ): Promise<Bot> {
    return this.mutate(async () => {
      await this.checkProjectGrant(callerId, botId, projectId, level);
      const bot = this.get(botId);
      const projects = bot.projects.filter((grant) => grant.project !== projectId);
      if (level !== null) projects.push({ project: projectId, level });
      const previous = this.projectApprovals[botId];
      try {
        if (isChief(this.get(callerId))) {
          this.projectApprovals[botId] = (previous ?? []).filter(
            (grant) => grant.project !== projectId,
          );
          if (level !== null) this.projectApprovals[botId].push({ project: projectId, level });
          await atomicWrite(
            join(this.dir, 'project-grants.json'),
            JSON.stringify(this.projectApprovals),
          );
        }
        const after = { ...bot, projects };
        const before = bot.projects.find((grant) => grant.project === projectId);
        if (before && (level === null || accessRank[level] < accessRank[before.level])) {
          await this.trimScopes(this.list().map((value) => (value.id === botId ? after : value)));
          return this.get(botId);
        }
        return await this.persist(after);
      } catch (error) {
        if (previous) this.projectApprovals[botId] = previous;
        else delete this.projectApprovals[botId];
        await atomicWrite(
          join(this.dir, 'project-grants.json'),
          JSON.stringify(this.projectApprovals),
        );
        throw error;
      }
    });
  }
  private async trimScopes(bots: Bot[]): Promise<void> {
    const planned = new Map<string, Bot>();
    bots.sort((a, b) => this.descendants(b.id).length - this.descendants(a.id).length);
    for (const before of bots) {
      const bot = structuredClone(before);
      const parent = bot.parent ? planned.get(bot.parent) : undefined;
      if (parent) {
        const ceiling = effectiveAccess(parent, this.projects());
        const levels = ['read-only', 'workspace-write', 'danger-full-access'] as const;
        if (levels.indexOf(bot.sandbox) > levels.indexOf(parent.sandbox))
          bot.sandbox = parent.sandbox;
        const filter = async (paths: string[], roots: string[]) => {
          const keep = await Promise.all(paths.map((path) => inScope(path, roots)));
          return paths.filter((_, index) => keep[index]);
        };
        bot.readScope = await filter(bot.readScope, ceiling.readRoots);
        bot.writeScope = await filter(bot.writeScope, ceiling.writeRoots);
        if (!(await inScope(bot.workdir, ceiling.readRoots))) {
          const workspace = join(this.dir, 'workspaces', bot.id);
          if (!(await inScope(workspace, [this.dir]))) throw new Error('errors.botInvalid');
          await mkdir(workspace, { recursive: true });
          for (const path of [dirname(workspace), workspace])
            if ((await lstat(path)).isSymbolicLink()) throw new Error('errors.botInvalid');
          bot.workdir = workspace;
          if (bot.sandbox !== 'read-only') bot.writeScope.push(workspace);
        }
        const ownWorkspace = bot.workdir === join(this.dir, 'workspaces', bot.id);
        if (bot.sandbox === 'danger-full-access') {
          if (!ownWorkspace && !(await inScope(bot.workdir, ceiling.fullRoots)))
            bot.sandbox = ceiling.writeRoots.length ? 'workspace-write' : 'read-only';
          else bot.writeScope = await filter(bot.writeScope, ceiling.fullRoots);
        }
        bot.projects = bot.projects.flatMap((grant) => {
          const approved = this.projectApprovals[bot.id]?.find(
            (value) => value.project === grant.project,
          );
          const superior = parent.projects.find((value) => value.project === grant.project);
          const max = [approved, superior]
            .filter((value) => value !== undefined)
            .sort((a, b) => accessRank[b.level] - accessRank[a.level])[0];
          return max
            ? [
                {
                  ...grant,
                  level: accessRank[grant.level] <= accessRank[max.level] ? grant.level : max.level,
                },
              ]
            : [];
        });
        await this.ceiling(bot, parent);
        if (JSON.stringify(bot) !== JSON.stringify(before))
          console.warn('Trimmed bot scope after project removal:', bot.id);
      }
      planned.set(bot.id, bot);
    }
    // Save descendants first so no persisted parent loses its grant before its children are trimmed.
    for (const bot of [...planned.values()].reverse())
      if (JSON.stringify(bot) !== JSON.stringify(this.get(bot.id))) await this.persist(bot, false);
  }
  removeProject(projectId: string, remove: () => Promise<void>): Promise<void> {
    return this.mutate(async () => {
      await this.trimScopes(
        this.list().map((bot) => ({
          ...bot,
          projects: bot.projects.filter((grant) => grant.project !== projectId),
        })),
      );
      for (const id of Object.keys(this.projectApprovals))
        this.projectApprovals[id] = this.projectApprovals[id].filter(
          (grant) => grant.project !== projectId,
        );
      await atomicWrite(
        join(this.dir, 'project-grants.json'),
        JSON.stringify(this.projectApprovals),
      );
      await remove();
    });
  }
  changeMemory(id: string, change: (memory: string) => string): Promise<void> {
    return this.mutate(async () => this.writeMemory(id, change(await this.getMemory(id))));
  }
  private async memoryPath(id: string): Promise<string> {
    this.get(id);
    const dir = join(this.dir, 'memory');
    await mkdir(dir, { recursive: true });
    if ((await lstat(dir)).isSymbolicLink() || !(await inScope(dir, [this.dir])))
      throw new Error('errors.botInvalid');
    const path = join(dir, id + '.md');
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('errors.botInvalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return path;
  }
  async getMemory(id: string): Promise<string> {
    const path = await this.memoryPath(id);
    try {
      return redact(await readFile(path, 'utf8'), await this.secrets());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return '';
    }
  }
  setMemory(id: string, text: string): Promise<void> {
    return this.mutate(() => this.writeMemory(id, text));
  }
  private async writeMemory(id: string, text: string): Promise<void> {
    await atomicWrite(await this.memoryPath(id), redact(text, await this.secrets()));
  }
  async close(): Promise<void> {
    await this.watcher?.close();
    await this.queue;
    await this.mutations;
  }
}
