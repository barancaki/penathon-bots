import { afterEach, expect, it, vi } from 'vitest';
import { readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../src/main/settings';
import { removeTemporary, temporaryDirectory } from './helpers';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
let dir: string;
afterEach(async () => {
  vi.mocked(rename).mockClear();
  if (dir) await removeTemporary(dir);
});
it.runIf(process.platform === 'win32')(
  'retries a transient Windows replacement lock without losing the destination',
  async () => {
    dir = await temporaryDirectory();
    const file = join(dir, 'settings.json');
    await atomicWrite(file, 'before');
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EPERM' }));
    await atomicWrite(file, 'after');
    expect(await readFile(file, 'utf8')).toBe('after');
    expect(await readdir(dir)).toEqual(['settings.json']);
  },
);
it('keeps the old destination and cleans its temporary file on a permanent write failure', async () => {
  dir = await temporaryDirectory();
  const file = join(dir, 'settings.json');
  await atomicWrite(file, 'before');
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(atomicWrite(file, 'after')).rejects.toThrow('denied');
  expect(await readFile(file, 'utf8')).toBe('before');
  expect(await readdir(dir)).toEqual(['settings.json']);
});
