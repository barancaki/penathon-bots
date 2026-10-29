import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { EngineId } from '../shared/bots';
import {
  settingsPatchSchema,
  notificationsSchema,
  settingsSchema,
  telegramSettingsSchema,
  type Settings,
  type SettingsPatch,
} from '../shared/settings';
import { z } from 'zod';
import { setTimeout } from 'node:timers/promises';
import { assertProjectKnowledge } from './projects';
import type { Project } from '../shared/projects';

export interface SecretStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
}
const writes = new Map<string, Promise<void>>();
export async function atomicWrite(path: string, data: string): Promise<void> {
  const operation = (writes.get(path) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, data, { mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
          try {
            await rename(temporary, path);
            break;
          } catch (error) {
            // Windows scanners can briefly hold the destination open during replacement.
            if (
              process.platform !== 'win32' ||
              attempt >= 4 ||
              !['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
            )
              throw error;
            await setTimeout(25 * (attempt + 1));
          }
        }
      } finally {
        await rm(temporary, { force: true });
      }
    });
  writes.set(path, operation);
  try {
    await operation;
  } finally {
    if (writes.get(path) === operation) writes.delete(path);
  }
}
export class SettingsStore {
  private settings!: Settings;
  private secrets: Partial<Record<EngineId | 'telegram', string>> = {};
  private redactions = new Set<string>();
  private redactionsAvailable = true;
  constructor(
    private dir: string,
    private storage: SecretStorage,
  ) {}
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      this.settings = settingsSchema.parse(
        JSON.parse(await readFile(join(this.dir, 'settings.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('errors.settingsInvalid');
      this.settings = settingsSchema.parse({
        botsDir: join(this.dir, 'bots'),
        engines: { claude: {}, codex: {} },
      });
    }
    try {
      this.secrets = z
        .object({
          claude: z.string().optional(),
          codex: z.string().optional(),
          telegram: z.string().optional(),
        })
        .strict()
        .parse(JSON.parse(await readFile(join(this.dir, 'secrets.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('errors.secretsInvalid');
    }
    this.validatePaths(this.settings);
    if (!Object.values(this.secrets).some(Boolean)) return;
    if (!(await this.canEncrypt())) {
      this.redactionsAvailable = false;
      return;
    }
    for (const engine of ['claude', 'codex', 'telegram'] as const) {
      const secret = await this.apiKey(engine);
      if (secret) this.redactions.add(secret);
    }
  }
  redactionSecrets(): string[] {
    if (!this.redactionsAvailable) throw new Error('errors.encryptionUnavailable');
    // Active runs can still use a replaced or removed key until they finish.
    return [...this.redactions];
  }
  get(): Settings {
    const settings = structuredClone(this.settings);
    for (const engine of ['claude', 'codex'] as const)
      settings.engines[engine].hasApiKey = !!this.secrets[engine];
    settings.telegram.hasToken = !!this.secrets.telegram;
    return settings;
  }
  private validatePaths(settings: Settings): void {
    if (
      ![
        settings.botsDir,
        settings.knowledgeDir,
        ...settings.projects.flatMap((project) => project.folders),
      ].every((path) => !path || isAbsolute(path))
    )
      throw new Error('errors.absolutePath');
  }
  private async canEncrypt(): Promise<boolean> {
    return (
      (await this.storage.isAsyncEncryptionAvailable()) &&
      !(
        process.platform === 'linux' &&
        ['basic_text', 'unknown'].includes(this.storage.getSelectedStorageBackend?.() ?? 'unknown')
      )
    );
  }
  private queue = Promise.resolve();
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  changeProjects(change: (projects: Project[]) => Project[]): Promise<void> {
    return this.mutate(async () => {
      const next = settingsSchema.parse({ ...this.get(), projects: change(this.get().projects) });
      await assertProjectKnowledge(next.projects, next.knowledgeDir);
      await atomicWrite(join(this.dir, 'settings.json'), JSON.stringify(next, null, 2));
      this.settings = next;
    });
  }
  set(input: SettingsPatch): Promise<Settings> {
    return this.mutate(() => this.apply(input));
  }
  private async apply(input: SettingsPatch): Promise<Settings> {
    const patch = settingsPatchSchema.parse(input);
    const next = this.get();
    for (const key of ['botsDir', 'language', 'theme', 'profile', 'runInBackground'] as const) {
      if (patch[key] !== undefined) Object.assign(next, { [key]: patch[key] });
    }
    if (patch.notifications)
      next.notifications = notificationsSchema.parse({
        ...next.notifications,
        ...patch.notifications,
      });
    if (patch.knowledgeDir === null) delete next.knowledgeDir;
    else if (patch.knowledgeDir !== undefined) next.knowledgeDir = patch.knowledgeDir;
    this.validatePaths(next);
    await assertProjectKnowledge(next.projects, next.knowledgeDir);
    const secrets = { ...this.secrets };
    for (const engine of ['claude', 'codex'] as const) {
      const auth = patch.engines?.[engine];
      if (auth?.authMode) next.engines[engine].authMode = auth.authMode;
      if (auth?.apiKey === null) delete secrets[engine];
      else if (auth?.apiKey !== undefined) {
        if (!(await this.canEncrypt())) throw new Error('errors.encryptionUnavailable');
        secrets[engine] = (await this.storage.encryptStringAsync(auth.apiKey)).toString('base64');
        this.redactions.add(auth.apiKey);
      }
      next.engines[engine].hasApiKey = !!secrets[engine];
    }
    await atomicWrite(join(this.dir, 'secrets.json'), JSON.stringify(secrets));
    this.secrets = secrets;
    await atomicWrite(join(this.dir, 'settings.json'), JSON.stringify(next, null, 2));
    this.settings = next;
    return this.get();
  }
  setTelegram(patch: Partial<Settings['telegram']>): Promise<void> {
    return this.mutate(async () => {
      const next = this.get();
      next.telegram = telegramSettingsSchema.parse({ ...next.telegram, ...patch });
      await atomicWrite(join(this.dir, 'settings.json'), JSON.stringify(next, null, 2));
      this.settings = next;
    });
  }
  setTelegramToken(token: string | null): Promise<void> {
    return this.mutate(async () => {
      const secrets = { ...this.secrets };
      if (token === null) delete secrets.telegram;
      else {
        if (!(await this.canEncrypt())) throw new Error('errors.encryptionUnavailable');
        secrets.telegram = (await this.storage.encryptStringAsync(token)).toString('base64');
        this.redactions.add(token);
      }
      await atomicWrite(join(this.dir, 'secrets.json'), JSON.stringify(secrets));
      this.secrets = secrets;
    });
  }
  async apiKey(engine: EngineId | 'telegram'): Promise<string | undefined> {
    const encrypted = this.secrets[engine];
    if (!encrypted) return undefined;
    if (!(await this.canEncrypt())) throw new Error('errors.encryptionUnavailable');
    try {
      return (await this.storage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result;
    } catch {
      throw new Error('errors.secretsInvalid');
    }
  }
}
