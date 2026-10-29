import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { Repository } from '../src/main/db';
import { openRepository } from '../src/main/openRepository';
import { removeTemporary, temporaryDirectory, testBot } from './helpers';

let directory: string;
let db: Repository | undefined;
it('preserves a malformed SQLite image and creates a usable replacement', async () => {
  directory = await temporaryDirectory();
  const path = join(directory, 'penathon.sqlite');
  db = new Repository(path);
  db.start(testBot(), 'Old history');
  db.close();
  db = undefined;
  const bytes = await readFile(path);
  bytes[100] = 0xff;
  await writeFile(path, bytes);
  const opened = await openRepository(directory);
  db = opened.db;
  expect(await readFile(join(opened.backupDirectory!, 'penathon.sqlite'))).toEqual(bytes);
  expect(db.list('helper')).toEqual([]);
});
it('leaves a database from a newer application version in place', async () => {
  directory = await temporaryDirectory();
  const path = join(directory, 'penathon.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec(
    'CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (99)',
  );
  raw.close();
  await expect(openRepository(directory)).rejects.toThrow('errors.schemaVersion');
  expect((await readdir(directory)).some((name) => name.startsWith('db-corrupt-'))).toBe(false);
  const check = new DatabaseSync(path);
  try {
    expect(check.prepare('SELECT version FROM schema_version').get()?.version).toBe(99);
  } finally {
    check.close();
  }
});
it('checkpoints the WAL before closing even with another database connection open', async () => {
  directory = await temporaryDirectory();
  const path = join(directory, 'checkpoint.sqlite');
  db = new Repository(path);
  const reader = new DatabaseSync(path);
  try {
    reader.prepare('SELECT COUNT(*) FROM conversations').get();
    db.start(testBot(), 'Persist');
    expect((await stat(path + '-wal')).size).toBeGreaterThan(0);
    db.close();
    db = undefined;
    expect((await stat(path + '-wal')).size).toBe(0);
    expect(reader.prepare('SELECT title FROM conversations').get()?.title).toBe('Persist');
  } finally {
    reader.close();
  }
});
it('migrates a version 1 database to version 3 without losing existing rows', async () => {
  directory = await temporaryDirectory();
  const path = join(directory, 'v1.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (1);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, botId TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), engine TEXT NOT NULL, model TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT, durationMs INTEGER, resumeToken TEXT, usage TEXT, status TEXT NOT NULL);
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversationId TEXT NOT NULL REFERENCES conversations(id), runId TEXT NOT NULL REFERENCES runs(id), createdAt TEXT NOT NULL, event TEXT NOT NULL);
    INSERT INTO conversations VALUES ('old', 'helper', 'Old title', '2026-10-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('message', 'old', 'user', 'Preserved text', '2026-10-01T00:00:00.000Z');
    INSERT INTO runs (id, conversationId, engine, model, startedAt, status) VALUES ('run', 'old', 'claude', 'sonnet', '2026-10-01T00:00:00.000Z', 'done');
  `);
  old
    .prepare('INSERT INTO events (conversationId, runId, createdAt, event) VALUES (?, ?, ?, ?)')
    .run(
      'old',
      'run',
      '2026-10-01T00:00:00.000Z',
      JSON.stringify({ type: 'run.done', durationMs: 1 }),
    );
  old.close();
  db = new Repository(path);
  expect(db.get('old')).toMatchObject({
    conversation: { title: 'Old title' },
    messages: [{ text: 'Preserved text' }],
    events: [{ event: { type: 'run.done' } }],
  });
  expect(db.routineRuns('helper', 'none')).toEqual([]);
  expect(db.reports()).toEqual([]);
  const raw = new DatabaseSync(path);
  expect(raw.prepare('SELECT version FROM schema_version').get()?.version).toBe(3);
  expect(raw.prepare('SELECT COUNT(*) AS count FROM runs').get()?.count).toBe(1);
  raw.close();
});
afterEach(async () => {
  db?.close();
  db = undefined;
  if (directory) await removeTemporary(directory);
});
it('migrates a version 2 database to room schema without changing conversations, routines or reports', async () => {
  directory = await temporaryDirectory();
  const path = join(directory, 'v2.sqlite');
  db = new Repository(path);
  const run = db.start(testBot(), 'Keep transcript');
  db.append(run.runId, { type: 'run.done', durationMs: 1, resumeToken: 'keep-session' });
  db.skipRoutine('helper', 'summary', 'Keep routine');
  db.addReport({
    botId: 'helper',
    conversationId: run.conversationId,
    runId: run.runId,
    summary: 'Keep report',
    files: [],
    decisions: [],
    open: [],
    source: 'bot',
  });
  const before = db.get(run.conversationId);
  db.close();
  db = undefined;
  const raw = new DatabaseSync(path);
  raw.exec(
    'DROP TABLE room_messages; DROP INDEX conversations_room_bot; ALTER TABLE conversations DROP COLUMN roomId; DROP TABLE rooms; UPDATE schema_version SET version = 2;',
  );
  raw.close();
  db = new Repository(path);
  expect(db.get(run.conversationId)).toEqual(before);
  expect(db.routineRuns('helper', 'summary')[0].summary).toBe('Keep routine');
  expect(db.reports()[0].summary).toBe('Keep report');
  expect(db.rooms()).toEqual([]);
  expect(db.start(testBot(), 'Resume', run.conversationId).resumeToken).toBe('keep-session');
});

it('rolls back room deletion as one transaction when a conversation cannot be deleted', () => {
  db = new Repository(':memory:');
  const room = db.saveRoom({
    id: 'room',
    name: 'Keep',
    members: ['helper'],
    lead: 'helper',
    createdAt: new Date().toISOString(),
  });
  const run = db.start(testBot(), 'Prompt', undefined, { roomId: room.id });
  db.append(run.runId, { type: 'message.done', messageId: 'answer', text: 'Answer' });
  db.append(run.runId, { type: 'run.done', durationMs: 1 });
  db.addRoomMessage({
    roomId: room.id,
    author: { kind: 'bot', botId: 'helper' },
    text: 'Answer',
    conversationId: run.conversationId,
    runId: run.runId,
  });
  const sqlite = (db as unknown as { db: DatabaseSync }).db;
  sqlite.exec(
    "CREATE TRIGGER prevent_room_delete BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'blocked'); END",
  );
  expect(() => db!.deleteRoom(room.id)).toThrow('blocked');
  expect(db.roomMessages(room.id)).toHaveLength(1);
  expect(db.get(run.conversationId).messages).toHaveLength(2);
  sqlite.exec('DROP TRIGGER prevent_room_delete');
  db.deleteRoom(room.id);
  expect(() => db!.get(run.conversationId)).toThrow('errors.conversationMissing');
  expect(db.rooms()).toEqual([]);
});
it('migrates, persists transcript/events/usage and resumes only the latest matching engine/model', async () => {
  directory = await temporaryDirectory();
  const path = join(directory, 'test.sqlite');
  db = new Repository(path);
  const bot = testBot(directory);
  const first = db.start(bot, 'Hello');
  db.append(first.runId, { type: 'message.delta', messageId: 'answer', text: 'Hi' });
  db.append(first.runId, { type: 'message.done', messageId: 'answer', text: 'Hi' });
  db.append(first.runId, {
    type: 'run.done',
    resumeToken: 'session-1',
    durationMs: 23,
    usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 },
  });
  expect(db.get(first.conversationId).messages.map((message) => message.text)).toEqual([
    'Hello',
    'Hi',
  ]);
  const second = db.start(bot, 'Again', first.conversationId);
  expect(second.resumeToken).toBe('session-1');
  db.append(second.runId, { type: 'run.done', resumeToken: 'session-1', durationMs: 1 });
  expect(
    db.start({ ...bot, engine: 'codex' }, 'Switch', first.conversationId).resumeToken,
  ).toBeUndefined();
  expect(() => db!.start({ ...bot, id: 'other' }, 'Wrong bot', first.conversationId)).toThrow(
    'errors.conversationBot',
  );
  db.close();
  db = new Repository(path);
  expect(db.list(bot.id)).toHaveLength(1);
  const detail = db.get(first.conversationId);
  expect(detail.events).toHaveLength(4);
  expect(detail.events[2].event).toMatchObject({ type: 'run.done', usage: { costUsd: 0.001 } });
  const raw = new DatabaseSync(path);
  expect(raw.prepare('SELECT version FROM schema_version').get()?.version).toBe(3);
  expect(raw.prepare('SELECT status FROM runs ORDER BY rowid DESC LIMIT 1').get()?.status).toBe(
    'interrupted',
  );
  expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(4);
  raw.close();
});
it('rolls back failed writes and rejects appends after a terminal result', () => {
  db = new Repository(':memory:');
  expect(() => db!.start(testBot(), 'bad', 'missing')).toThrow();
  expect(db.list('helper')).toEqual([]);
  const run = db.start(testBot(), 'test');
  db.append(run.runId, { type: 'run.error', code: 'test', message: 'failure' });
  expect(() => db!.append(run.runId, { type: 'status', status: 'done' })).toThrow(
    'errors.runMissing',
  );
});

it('deletes all conversation records atomically, preserving other conversations and ignoring late events', async () => {
  directory = await temporaryDirectory();
  const file = join(directory, 'delete.sqlite');
  db = new Repository(file);
  const bot = testBot(directory);
  const first = db.start(bot, 'Delete');
  db.append(first.runId, { type: 'message.done', messageId: 'a', text: 'Answer' });
  db.append(first.runId, { type: 'run.done', durationMs: 1 });
  db.start(bot, 'Second turn', first.conversationId);
  const other = db.start(bot, 'Keep');
  const raw = new DatabaseSync(file);
  try {
    raw.exec(
      "CREATE TRIGGER prevent_delete BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    expect(() => db!.delete(first.conversationId)).toThrow('blocked');
    expect(db.get(first.conversationId).messages).toHaveLength(3);
    expect(db.get(first.conversationId).events).toHaveLength(2);
    expect(
      raw
        .prepare('SELECT COUNT(*) AS n FROM runs WHERE conversationId = ?')
        .get(first.conversationId)?.n,
    ).toBe(2);
    raw.exec('DROP TRIGGER prevent_delete');
    db.delete(first.conversationId);
    for (const table of ['conversations', 'messages', 'events', 'runs']) {
      const column = table === 'conversations' ? 'id' : 'conversationId';
      expect(
        raw
          .prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE ' + column + ' = ?')
          .get(first.conversationId)?.n,
      ).toBe(0);
    }
    expect(db.get(other.conversationId).messages[0].text).toBe('Keep');
    expect(db.append(first.runId, { type: 'run.done', durationMs: 1 })).toBeUndefined();
    expect(() => db!.delete(first.conversationId)).toThrow('errors.conversationMissing');
    expect(() => db!.get(first.conversationId)).toThrow('errors.conversationMissing');
  } finally {
    raw.close();
  }
});

it('identifies plain, routine and room runs for desktop notification routing', () => {
  db = new Repository(':memory:');
  const bot = testBot();
  const plain = db.start(bot, 'Plain');
  expect(db.runInfo(plain.runId)).toEqual({
    botId: bot.id,
    conversationId: plain.conversationId,
    status: 'running',
    roomId: undefined,
    routineId: undefined,
  });
  const routine = db.start(bot, 'Scheduled', undefined, { routineId: 'morning' });
  expect(db.runInfo(routine.runId)).toMatchObject({ routineId: 'morning', roomId: undefined });
  const room = db.saveRoom({
    id: 'room',
    name: 'Room',
    members: [bot.id],
    lead: bot.id,
    createdAt: '',
  });
  const reply = db.start(bot, 'Reply', undefined, { roomId: room.id });
  expect(db.runInfo(reply.runId)).toMatchObject({ roomId: room.id, routineId: undefined });
  expect(() => db!.runInfo('missing')).toThrow('errors.runMissing');
});
