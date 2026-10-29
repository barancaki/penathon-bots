import { afterEach, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { atomicWrite, SettingsStore, type SecretStorage } from '../src/main/settings';
import { redact, engineEnv } from '../src/main/engines/common';
import { removeTemporary, temporaryDirectory } from './helpers';

let directory: string;
afterEach(async () => {
  if (directory) await removeTemporary(directory);
});
const key = randomBytes(32);
const storage: SecretStorage = {
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptStringAsync: async (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  },
  decryptStringAsync: async (value) => {
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return {
      result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        'utf8',
      ),
      shouldReEncrypt: false,
    };
  },
};
it('writes concurrently without sharing temporary files or leaving partial content', async () => {
  directory = await temporaryDirectory();
  const path = join(directory, 'bot.md');
  await Promise.all([atomicWrite(path, 'first'), atomicWrite(path, 'second')]);
  expect(['first', 'second']).toContain(await readFile(path, 'utf8'));
  expect(await readdir(directory)).toEqual(['bot.md']);
});
it('stores only encrypted secrets, does not expose keys, supports replacement/removal and reloads', async () => {
  directory = await temporaryDirectory();
  const store = new SettingsStore(directory, storage);
  await store.init();
  const saved = await store.set({
    engines: { claude: { authMode: 'api-key', apiKey: 'test-secret-123' } },
  });
  expect(saved.engines.claude).toEqual({ authMode: 'api-key', hasApiKey: true });
  expect(JSON.stringify(saved)).not.toContain('test-secret-123');
  expect(await readFile(join(directory, 'settings.json'), 'utf8')).not.toContain('test-secret-123');
  expect(await readFile(join(directory, 'secrets.json'), 'utf8')).not.toContain('test-secret-123');
  const reloaded = new SettingsStore(directory, storage);
  await reloaded.init();
  expect(await reloaded.apiKey('claude')).toBe('test-secret-123');
  await reloaded.set({ engines: { claude: { apiKey: 'replacement' } } });
  expect(await reloaded.apiKey('claude')).toBe('replacement');
  await reloaded.set({ engines: { claude: { apiKey: null } } });
  expect(reloaded.get().engines.claude.hasApiKey).toBe(false);
});
it('fails closed when OS encryption is unavailable and validates paths', async () => {
  directory = await temporaryDirectory();
  const store = new SettingsStore(directory, {
    ...storage,
    isAsyncEncryptionAvailable: async () => false,
  });
  await store.init();
  await expect(store.set({ engines: { codex: { apiKey: 'never-write-this' } } })).rejects.toThrow(
    'errors.encryptionUnavailable',
  );
  await expect(store.set({ botsDir: 'relative' })).rejects.toThrow('errors.absolutePath');
  expect(store.get().engines.codex.hasApiKey).toBe(false);
});
it('redacts secrets including escaped characters and never inherits API keys in local mode', () => {
  const secret = 'secret"\\value';
  expect(redact({ text: `error ${secret}` }, [secret])).toEqual({ text: 'error [REDACTED]' });
  const env = engineEnv({ mode: 'local-cli' }, 'claude');
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.CODEX_API_KEY).toBeUndefined();
  expect(() => engineEnv({ mode: 'api-key' }, 'codex')).toThrow('errors.apiKeyMissing');
});

it('redacts only string values while preserving keys, numbers, booleans and undefined', () => {
  const value = {
    '1': 1,
    active: true,
    disabled: false,
    empty: null,
    missing: undefined,
    text: '1 true false',
    nested: [{ text: 'secret"\\value', count: 123 }],
    token: 'secret"\\value',
  };
  expect(redact(value, ['1', 'true', 'false', 'secret"\\value'])).toEqual({
    '1': 1,
    active: true,
    disabled: false,
    empty: null,
    missing: undefined,
    text: '[REDACTED] [REDACTED] [REDACTED]',
    nested: [{ text: '[REDACTED]', count: 123 }],
    token: '[REDACTED]',
  });
  expect(value.text).toBe('1 true false');
});
it('persists Telegram settings with safeStorage secrets and refuses unencrypted storage', async () => {
  directory = await temporaryDirectory();
  const store = new SettingsStore(directory, storage);
  await store.init();
  expect(store.get().telegram).toEqual({
    enabled: false,
    routeTo: 'chief',
    notifyRoutines: true,
    hasToken: false,
  });
  await store.setTelegramToken('123:fake_telegram_secret');
  await store.setTelegram({
    enabled: true,
    pairedChatId: 42,
    pairedName: 'Alex',
    conversationId: 'conversation',
  });
  const reloaded = new SettingsStore(directory, storage);
  await reloaded.init();
  expect(reloaded.get().telegram).toMatchObject({
    hasToken: true,
    pairedChatId: 42,
    conversationId: 'conversation',
  });
  expect(await reloaded.apiKey('telegram')).toBe('123:fake_telegram_secret');
  expect(await readFile(join(directory, 'secrets.json'), 'utf8')).not.toContain(
    '123:fake_telegram_secret',
  );
  expect(JSON.stringify(reloaded.get())).not.toContain('123:fake_telegram_secret');
  const unavailable = new SettingsStore(directory, {
    ...storage,
    isAsyncEncryptionAvailable: async () => false,
  });
  await unavailable.init();
  expect(() => unavailable.redactionSecrets()).toThrow('errors.encryptionUnavailable');
  await expect(unavailable.setTelegramToken('never_write')).rejects.toThrow(
    'errors.encryptionUnavailable',
  );
  await store.setTelegramToken(null);
  await store.setTelegram({
    pairedChatId: undefined,
    pairedName: undefined,
    conversationId: undefined,
  });
  expect(store.get().telegram).toMatchObject({ hasToken: false });
  expect(store.get().telegram.pairedChatId).toBeUndefined();
});

it('updates redaction credentials on rotation and keeps in-flight keys masked', async () => {
  directory = await temporaryDirectory();
  const store = new SettingsStore(directory, storage);
  await store.init();
  await store.set({ engines: { claude: { apiKey: 'old-api-key' } } });
  await store.setTelegramToken('123:old-token');
  const reloaded = new SettingsStore(directory, storage);
  await reloaded.init();
  expect(reloaded.redactionSecrets()).toEqual(
    expect.arrayContaining(['old-api-key', '123:old-token']),
  );
  await store.set({ engines: { claude: { apiKey: 'new-api-key' } } });
  await store.setTelegramToken('123:new-token');
  await store.set({ engines: { claude: { apiKey: null } } });
  await store.setTelegramToken(null);
  expect(store.redactionSecrets()).toEqual(
    expect.arrayContaining(['old-api-key', 'new-api-key', '123:old-token', '123:new-token']),
  );
  expect(JSON.stringify(store.get())).not.toContain('new-api-key');
});

it('defaults background/notifications for existing settings and persists partial notification patches', async () => {
  directory = await temporaryDirectory();
  const store = new SettingsStore(directory, storage);
  await store.init();
  const defaults = {
    enabled: true,
    done: true,
    approval: true,
    error: true,
    routine: true,
    rooms: false,
  };
  expect(store.get().runInBackground).toBe(true);
  expect(store.get().notifications).toEqual(defaults);
  await store.set({ language: 'en', theme: 'dark', profile: { name: 'Alex', address: 'Alex' } });
  await store.set({ runInBackground: false, notifications: { done: false, rooms: true } });
  await store.set({ notifications: { enabled: false } });
  const reloaded = new SettingsStore(directory, storage);
  await reloaded.init();
  expect(reloaded.get().runInBackground).toBe(false);
  expect(reloaded.get()).toMatchObject({
    language: 'en',
    theme: 'dark',
    profile: { name: 'Alex', address: 'Alex' },
  });
  expect(reloaded.get().notifications).toEqual({
    ...defaults,
    done: false,
    rooms: true,
    enabled: false,
  });
  await expect(store.set({ notifications: { enabled: 'no' } } as never)).rejects.toThrow();
  await expect(store.set({ notifications: { unknown: true } } as never)).rejects.toThrow();
  await expect(store.set({ notifications: { enabled: undefined } })).rejects.toThrow();
  expect(store.get().notifications).toEqual(reloaded.get().notifications);
});
