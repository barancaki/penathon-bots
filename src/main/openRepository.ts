import { mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from './db';

export async function openRepository(
  userData: string,
): Promise<{ db: Repository; backupDirectory?: string }> {
  const filename = 'penathon.sqlite';
  const path = join(userData, filename);
  const files = await readdir(userData, { withFileTypes: true });
  // SQLite can rebuild shared memory even on a read-only connection.
  const shm = files.some((file) => file.isFile() && file.name === filename + '-shm')
    ? await readFile(path + '-shm')
    : undefined;
  try {
    if (files.some((file) => file.name === filename)) {
      // A failed writable open can delete WAL/SHM on close, before we can preserve them.
      const check = new DatabaseSync(path, { readOnly: true });
      try {
        if (
          check
            .prepare('PRAGMA quick_check')
            .all()
            .some((row) => row.quick_check !== 'ok')
        )
          throw new Error('database disk image is malformed');
      } finally {
        check.close();
      }
    }
    return { db: new Repository(path) };
  } catch (error) {
    if (!(error instanceof Error) || !/malformed|not a database/i.test(error.message)) throw error;
    if (shm) await writeFile(path + '-shm', shm);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDirectory = await mkdtemp(join(userData, `db-corrupt-${timestamp}-`));
    for (const file of await readdir(userData, { withFileTypes: true }))
      if (file.isFile() && file.name.startsWith(filename))
        await rename(join(userData, file.name), join(backupDirectory, file.name));
    return { db: new Repository(path), backupDirectory };
  }
}
