import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Conversation, ConversationDetail } from '../shared/api';
import type { Bot } from '../shared/bots';
import type { EventEnvelope } from '../shared/events';
import { EventEmitter } from 'node:events';
import type { RoutineRun, WorkReport } from '../shared/routines';
import { commandMayWrite } from './engines/scopes';
import type { Room, RoomMessage } from '../shared/rooms';

export class Repository extends EventEmitter {
  private db: DatabaseSync;
  constructor(path: string) {
    super();
    this.db = new DatabaseSync(path);
    try {
      this.init();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private init(): void {
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const version = this.db.prepare('SELECT version FROM schema_version').get() as
      { version: number } | undefined;
    if (version && version.version > 3) throw new Error('errors.schemaVersion');
    if (!version)
      this.transaction(() => {
        this.db.exec(`
        CREATE TABLE conversations (id TEXT PRIMARY KEY, botId TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL CHECK(role IN ('user', 'assistant')), text TEXT NOT NULL, createdAt TEXT NOT NULL);
        CREATE TABLE runs (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), engine TEXT NOT NULL, model TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT, durationMs INTEGER, resumeToken TEXT, usage TEXT, status TEXT NOT NULL);
        CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversationId TEXT NOT NULL REFERENCES conversations(id), runId TEXT NOT NULL REFERENCES runs(id), createdAt TEXT NOT NULL, event TEXT NOT NULL);
        CREATE INDEX conversations_bot ON conversations(botId, createdAt);
        CREATE INDEX messages_conversation ON messages(conversationId);
        CREATE INDEX events_conversation ON events(conversationId, sequence);
        CREATE INDEX runs_conversation ON runs(conversationId, startedAt);
        INSERT INTO schema_version VALUES (1);
      `);
      });
    if (!version || version.version < 2)
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE routine_runs (id TEXT PRIMARY KEY, routineId TEXT NOT NULL, botId TEXT NOT NULL, conversationId TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT, durationMs INTEGER, status TEXT NOT NULL, summary TEXT);
          CREATE INDEX routine_runs_routine ON routine_runs(botId, routineId, startedAt);
          CREATE TABLE work_reports (id TEXT PRIMARY KEY, botId TEXT NOT NULL, conversationId TEXT NOT NULL, runId TEXT, createdAt TEXT NOT NULL, summary TEXT NOT NULL, decisions TEXT NOT NULL, files TEXT NOT NULL, open TEXT NOT NULL, source TEXT NOT NULL, processedAt TEXT, processedInto TEXT);
          CREATE INDEX work_reports_pending ON work_reports(processedAt, createdAt);
          UPDATE schema_version SET version = 2;
        `);
      });
    if (!version || version.version < 3)
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, members TEXT NOT NULL, lead TEXT NOT NULL, createdAt TEXT NOT NULL);
          ALTER TABLE conversations ADD COLUMN roomId TEXT REFERENCES rooms(id);
          CREATE UNIQUE INDEX conversations_room_bot ON conversations(roomId, botId) WHERE roomId IS NOT NULL;
          CREATE TABLE room_messages (id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, author TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL, conversationId TEXT REFERENCES conversations(id) ON DELETE SET NULL, runId TEXT REFERENCES runs(id) ON DELETE SET NULL);
          CREATE INDEX room_messages_room ON room_messages(roomId);
          UPDATE schema_version SET version = 3;
        `);
      });
    // Only old automatic report-processing titles are migrated; user titles stay intact.
    this.db
      .prepare(
        `
      UPDATE conversations SET title = 'routines.reportProcessing'
      WHERE botId = 'chief' AND title = 'Vault güncelleme' AND (
        EXISTS (SELECT 1 FROM routine_runs r WHERE r.conversationId = conversations.id
          AND r.botId = 'chief' AND r.routineId = 'vault-update')
        OR EXISTS (SELECT 1 FROM messages m WHERE m.conversationId = conversations.id
          AND m.role = 'user' AND m.text LIKE 'list_reports ile bekleyen raporları al.%'
          AND instr(m.text, 'Yalnız şu raporu işle; diğer raporlara dokunma: ') > 0)
      )
    `,
      )
      .run();
    this.db.exec(`
      UPDATE routine_runs SET summary = 'errors.botBusy' WHERE status = 'skipped' AND summary = 'bot meşguldü';
      UPDATE routine_runs SET summary = 'errors.appClosed' WHERE status = 'cancelled' AND summary IN ('Uygulama kapandı', 'Uygulama kapandÄ±');
      UPDATE routine_runs SET summary = 'errors.runCancelled' WHERE status = 'cancelled' AND summary IN ('Koşu iptal edildi', 'KoÅŸu iptal edildi');
    `);
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE routine_runs SET status = 'cancelled', finishedAt = ?, durationMs = MAX(0, CAST((julianday(?) - julianday(startedAt)) * 86400000 AS INTEGER)), summary = 'errors.appClosed' WHERE status = 'running'",
      )
      .run(now, now);
    const unresolved = this.db
      .prepare(
        "SELECT e.runId, e.conversationId, json_extract(e.event, '$.approvalId') AS approvalId FROM events e WHERE json_extract(e.event, '$.type') = 'approval.request' AND NOT EXISTS (SELECT 1 FROM events r WHERE r.runId = e.runId AND json_extract(r.event, '$.type') = 'approval.resolved' AND json_extract(r.event, '$.approvalId') = json_extract(e.event, '$.approvalId'))",
      )
      .all() as { runId: string; conversationId: string; approvalId: string }[];
    this.transaction(() => {
      for (const request of unresolved)
        this.db
          .prepare(
            'INSERT INTO events (conversationId, runId, createdAt, event) VALUES (?, ?, ?, ?)',
          )
          .run(
            request.conversationId,
            request.runId,
            new Date().toISOString(),
            JSON.stringify({
              type: 'approval.resolved',
              approvalId: request.approvalId,
              decision: 'expired',
            }),
          );
    });
    this.db
      .prepare("UPDATE runs SET status = 'interrupted', finishedAt = ? WHERE status = 'running'")
      .run(new Date().toISOString());
  }
  list(botId: string): Conversation[] {
    return this.db
      .prepare(
        'SELECT id, botId, title, createdAt FROM conversations WHERE botId = ? AND roomId IS NULL ORDER BY createdAt DESC, rowid DESC',
      )
      .all(botId) as Conversation[];
  }
  get(id: string): ConversationDetail {
    const conversation = this.db
      .prepare('SELECT id, botId, title, createdAt FROM conversations WHERE id = ?')
      .get(id) as Conversation | undefined;
    if (!conversation) throw new Error('errors.conversationMissing');
    const rows = this.db
      .prepare('SELECT * FROM events WHERE conversationId = ? ORDER BY sequence')
      .all(id) as unknown as (Omit<EventEnvelope, 'event'> & { event: string })[];
    return {
      conversation,
      messages: this.db
        .prepare('SELECT * FROM messages WHERE conversationId = ? ORDER BY rowid')
        .all(id) as ConversationDetail['messages'],
      events: rows.map((row) => ({ ...row, event: JSON.parse(row.event) })),
    };
  }
  delete(id: string): void {
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(id))
        throw new Error('errors.conversationMissing');
      this.deleteConversation(id);
    });
  }
  private deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM events WHERE conversationId = ?').run(id);
    this.db.prepare('DELETE FROM messages WHERE conversationId = ?').run(id);
    this.db.prepare('DELETE FROM runs WHERE conversationId = ?').run(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }
  rooms(): Room[] {
    return (
      this.db.prepare('SELECT * FROM rooms ORDER BY createdAt, rowid').all() as unknown as (Room & {
        members: string;
      })[]
    ).map((row) => ({ ...row, members: JSON.parse(row.members) }));
  }
  room(id: string): Room {
    const room = this.rooms().find((room) => room.id === id);
    if (!room) throw new Error('errors.roomMissing');
    return room;
  }
  saveRoom(room: Room): Room {
    this.db
      .prepare(
        'INSERT INTO rooms VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, members = excluded.members, lead = excluded.lead',
      )
      .run(room.id, room.name, JSON.stringify(room.members), room.lead, room.createdAt);
    return room;
  }
  roomConversation(roomId: string, botId: string): string | undefined {
    return (
      this.db
        .prepare('SELECT id FROM conversations WHERE roomId = ? AND botId = ?')
        .get(roomId, botId) as { id: string } | undefined
    )?.id;
  }
  roomConversations(roomId: string): string[] {
    return (
      this.db.prepare('SELECT id FROM conversations WHERE roomId = ?').all(roomId) as {
        id: string;
      }[]
    ).map((row) => row.id);
  }
  roomMessages(roomId: string, limit = 100): RoomMessage[] {
    this.room(roomId);
    const rows = this.db
      .prepare('SELECT * FROM room_messages WHERE roomId = ? ORDER BY rowid DESC LIMIT ?')
      .all(roomId, limit) as unknown as (RoomMessage & { author: string })[];
    return rows.reverse().map((row) => ({
      ...row,
      author: JSON.parse(row.author),
      conversationId: row.conversationId ?? undefined,
      runId: row.runId ?? undefined,
    }));
  }
  addRoomMessage(message: Omit<RoomMessage, 'id' | 'createdAt'>): RoomMessage {
    const saved = { ...message, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO room_messages VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        saved.id,
        saved.roomId,
        JSON.stringify(saved.author),
        saved.text,
        saved.createdAt,
        saved.conversationId ?? null,
        saved.runId ?? null,
      );
    return saved;
  }
  deleteRoom(id: string): void {
    this.room(id);
    this.transaction(() => {
      this.db.prepare('DELETE FROM room_messages WHERE roomId = ?').run(id);
      const conversations = this.db
        .prepare('SELECT id FROM conversations WHERE roomId = ?')
        .all(id) as { id: string }[];
      for (const conversation of conversations) this.deleteConversation(conversation.id);
      this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    });
  }
  start(
    bot: Bot,
    text: string,
    conversationId?: string,
    options?: { title?: string; routineId?: string; roomId?: string },
  ): { conversationId: string; runId: string; resumeToken?: string } {
    return this.transaction(() => {
      const id = conversationId ?? randomUUID();
      const now = new Date().toISOString();
      if (conversationId) {
        if (this.get(id).conversation.botId !== bot.id) throw new Error('errors.conversationBot');
      } else
        this.db
          .prepare(
            'INSERT INTO conversations (id, botId, title, createdAt, roomId) VALUES (?, ?, ?, ?, ?)',
          )
          .run(id, bot.id, options?.title ?? text.slice(0, 80), now, options?.roomId ?? null);
      const previous = this.db
        .prepare(
          'SELECT engine, model, resumeToken FROM runs WHERE conversationId = ? ORDER BY rowid DESC LIMIT 1',
        )
        .get(id) as { engine: string; model: string; resumeToken: string | null } | undefined;
      const runId = randomUUID();
      this.db
        .prepare(
          'INSERT INTO runs (id, conversationId, engine, model, startedAt, status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(runId, id, bot.engine, bot.model, now, 'running');
      this.db
        .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), id, 'user', text, now);
      if (options?.routineId)
        this.db
          .prepare(
            'INSERT INTO routine_runs (id, routineId, botId, conversationId, startedAt, status) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(runId, options.routineId, bot.id, id, now, 'running');
      return {
        conversationId: id,
        runId,
        resumeToken:
          previous?.engine === bot.engine && previous.model === bot.model
            ? (previous.resumeToken ?? undefined)
            : undefined,
      };
    });
  }
  append(runId: string, event: EventEnvelope['event']): EventEnvelope | undefined {
    let reportAdded = false;
    let routineBot: string | undefined;
    const envelope = this.transaction(() => {
      const run = this.db
        .prepare('SELECT conversationId, status FROM runs WHERE id = ?')
        .get(runId) as { conversationId: string; status: string } | undefined;
      if (!run) return;
      if (run.status !== 'running') throw new Error('errors.runMissing');
      const createdAt = new Date().toISOString();
      const inserted = this.db
        .prepare('INSERT INTO events (conversationId, runId, createdAt, event) VALUES (?, ?, ?, ?)')
        .run(run.conversationId, runId, createdAt, JSON.stringify(event));
      if (event.type === 'message.done')
        this.db
          .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
          .run(randomUUID(), run.conversationId, 'assistant', event.text, createdAt);
      if (event.type === 'run.done')
        this.db
          .prepare(
            'UPDATE runs SET finishedAt = ?, durationMs = ?, resumeToken = ?, usage = ?, status = ? WHERE id = ?',
          )
          .run(
            createdAt,
            event.durationMs,
            event.resumeToken ?? null,
            event.usage ? JSON.stringify(event.usage) : null,
            event.cancelled ? 'cancelled' : 'done',
            runId,
          );
      if (event.type === 'run.error')
        this.db
          .prepare(
            "UPDATE runs SET finishedAt = ?, durationMs = CAST((julianday(?) - julianday(startedAt)) * 86400000 AS INTEGER), status = 'error' WHERE id = ?",
          )
          .run(createdAt, createdAt, runId);
      if (event.type === 'run.done' || event.type === 'run.error') {
        const routine = this.db
          .prepare('SELECT botId FROM routine_runs WHERE id = ?')
          .get(runId) as { botId: string } | undefined;
        routineBot = routine?.botId;
        const events = this.get(run.conversationId)
          .events.filter((value) => value.runId === runId)
          .map((value) => value.event);
        const text = events.filter((value) => value.type === 'message.done').at(-1)?.text ?? '';
        this.db
          .prepare(
            'UPDATE routine_runs SET finishedAt = ?, durationMs = ?, status = ?, summary = ? WHERE id = ?',
          )
          .run(
            createdAt,
            event.type === 'run.done' ? event.durationMs : this.runDuration(runId, createdAt),
            event.type === 'run.error' ? 'error' : event.cancelled ? 'cancelled' : 'done',
            (event.type === 'run.error'
              ? event.message
              : event.cancelled
                ? 'errors.runCancelled'
                : text
            ).slice(0, 300),
            runId,
          );
        const botId = this.get(run.conversationId).conversation.botId;
        if (botId !== 'chief' && event.type === 'run.done' && !event.cancelled) {
          const files = new Set<string>();
          let changed = false;
          const requests = events.filter((value) => value.type === 'approval.request');
          for (const value of events) {
            if (value.type === 'diff' && value.unifiedDiff) {
              changed = true;
              files.add(value.file);
            }
            if (
              value.type === 'tool.start' &&
              (value.kind === 'file_write' || value.kind === 'command')
            ) {
              const end = events.find(
                (end) => end.type === 'tool.end' && end.toolId === value.toolId,
              );
              if (end?.type === 'tool.end' && !end.error) {
                if (value.kind === 'command') {
                  let command = value.argsSummary;
                  try {
                    const args = JSON.parse(command);
                    if (typeof args?.command === 'string') command = args.command;
                  } catch {
                    /* Codex and current Claude events carry the raw command. */
                  }
                  changed ||= commandMayWrite(command);
                  continue;
                }
                changed = true;
                for (const file of value.files ?? []) files.add(file);
                try {
                  if (value.files?.length) continue;
                  const args = JSON.parse(value.argsSummary);
                  if (Array.isArray(args))
                    for (const item of args) {
                      if (typeof item.path === 'string') files.add(item.path);
                    }
                  else if (typeof args.file_path === 'string') files.add(args.file_path);
                  else if (typeof args.path === 'string') files.add(args.path);
                } catch {
                  /* The engine may truncate tool arguments; full paths travel in files. */
                }
              }
            }
            if (value.type === 'card' && value.kind === 'work.changed') changed = true;
            if (
              value.type === 'approval.resolved' &&
              ['approved', 'edited'].includes(value.decision)
            ) {
              const request = requests.find((request) => request.approvalId === value.approvalId);
              if (
                request?.kind &&
                [
                  'bot.create',
                  'bot.update',
                  'project.grant',
                  'routine.create',
                  'routine.update',
                ].includes(request.kind)
              )
                changed = true;
            }
          }
          if (changed) {
            this.insertReport({
              id: randomUUID(),
              botId,
              conversationId: run.conversationId,
              runId,
              createdAt,
              summary: text.slice(0, 600),
              files: [...files],
              decisions: [],
              open: [],
              source: 'auto',
            });
            reportAdded = true;
          }
        }
      }
      return {
        conversationId: run.conversationId,
        runId,
        createdAt,
        sequence: Number(inserted.lastInsertRowid),
        event,
      };
    });
    if (routineBot) {
      this.emit('routinesChanged', routineBot);
      const routine = this.db.prepare('SELECT * FROM routine_runs WHERE id = ?').get(runId);
      this.emit('routineFinished', routine);
    }
    if (reportAdded) this.emit('reportsChanged');
    return envelope;
  }
  private runDuration(runId: string, now: string): number {
    const row = this.db.prepare('SELECT startedAt FROM runs WHERE id = ?').get(runId) as {
      startedAt: string;
    };
    return Math.max(0, new Date(now).getTime() - new Date(row.startedAt).getTime());
  }
  runInfo(runId: string): {
    botId: string;
    conversationId: string;
    status: string;
    roomId?: string;
    routineId?: string;
  } {
    const run = this.db
      .prepare(
        'SELECT c.botId, r.conversationId, r.status, c.roomId, rr.routineId FROM runs r JOIN conversations c ON c.id = r.conversationId LEFT JOIN routine_runs rr ON rr.id = r.id WHERE r.id = ?',
      )
      .get(runId) as
      | {
          botId: string;
          conversationId: string;
          status: string;
          roomId: string | null;
          routineId: string | null;
        }
      | undefined;
    if (!run) throw new Error('errors.runMissing');
    return { ...run, roomId: run.roomId ?? undefined, routineId: run.routineId ?? undefined };
  }
  routineRuns(botId: string, routineId: string, limit = 50): RoutineRun[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM routine_runs WHERE botId = ? AND routineId = ? ORDER BY startedAt DESC, rowid DESC LIMIT ?',
      )
      .all(botId, routineId, limit) as unknown as RoutineRun[];
    return rows.map((row) => ({
      ...row,
      finishedAt: row.finishedAt ?? undefined,
      durationMs: row.durationMs ?? undefined,
      summary: row.summary ?? undefined,
    }));
  }
  skipRoutine(
    botId: string,
    routineId: string,
    summary: string,
    now = new Date(),
    status: 'skipped' | 'error' = 'skipped',
  ): void {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO routine_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        routineId,
        botId,
        '',
        now.toISOString(),
        now.toISOString(),
        0,
        status,
        summary.slice(0, 300),
      );
    this.emit('routinesChanged', botId);
    if (status === 'error')
      this.emit('routineFinished', { id, botId, routineId, conversationId: '', status, summary });
  }
  addReport(
    input: Omit<WorkReport, 'id' | 'createdAt' | 'processedAt' | 'processedInto'>,
  ): WorkReport {
    const report = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.insertReport(report);
    this.emit('reportsChanged');
    return report;
  }
  private insertReport(report: WorkReport): void {
    this.db
      .prepare(
        'INSERT INTO work_reports (id, botId, conversationId, runId, createdAt, summary, decisions, files, open, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        report.id,
        report.botId,
        report.conversationId,
        report.runId ?? null,
        report.createdAt,
        report.summary,
        JSON.stringify(report.decisions),
        JSON.stringify(report.files),
        JSON.stringify(report.open),
        report.source,
      );
  }
  reports(filter: { pending?: boolean; botId?: string; limit?: number } = {}): WorkReport[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM work_reports WHERE (? IS NULL OR (processedAt IS NULL) = ?) AND (? IS NULL OR botId = ?) ORDER BY createdAt DESC, rowid DESC LIMIT ?',
      )
      .all(
        filter.pending === undefined ? null : Number(filter.pending),
        filter.pending === undefined ? null : Number(filter.pending),
        filter.botId ?? null,
        filter.botId ?? null,
        filter.limit ?? 100,
      ) as unknown as (Omit<WorkReport, 'decisions' | 'files' | 'open'> & {
      decisions: string;
      files: string;
      open: string;
    })[];
    return rows.map((row) => ({
      ...row,
      runId: row.runId ?? undefined,
      processedAt: row.processedAt ?? undefined,
      processedInto: row.processedInto ?? undefined,
      decisions: JSON.parse(row.decisions),
      files: JSON.parse(row.files),
      open: JSON.parse(row.open),
    }));
  }
  report(id: string): WorkReport {
    const row = this.db.prepare('SELECT * FROM work_reports WHERE id = ?').get(id) as unknown as
      (WorkReport & { decisions: string; files: string; open: string }) | undefined;
    if (!row) throw new Error('Report missing');
    return {
      ...row,
      runId: row.runId ?? undefined,
      processedAt: row.processedAt ?? undefined,
      processedInto: row.processedInto ?? undefined,
      decisions: JSON.parse(row.decisions),
      files: JSON.parse(row.files),
      open: JSON.parse(row.open),
    };
  }
  markReportsProcessed(ids: string[], into: string): void {
    this.transaction(() => {
      for (const id of ids) {
        this.report(id);
        this.db
          .prepare(
            'UPDATE work_reports SET processedAt = ?, processedInto = ? WHERE id = ? AND processedAt IS NULL',
          )
          .run(new Date().toISOString(), into, id);
      }
    });
    this.emit('reportsChanged');
  }
  search(
    query: string,
    botId?: string,
    limit = 10,
  ): { botId: string; title: string; date: string; excerpt: string }[] {
    const pattern = '%' + query.replace(/[\\%_]/g, (char) => '\\' + char) + '%';
    const rows = this.db
      .prepare(
        "SELECT c.botId, c.title, m.createdAt AS date, m.text FROM messages m JOIN conversations c ON c.id = m.conversationId WHERE m.text LIKE ? ESCAPE '\\' AND (? IS NULL OR c.botId = ?) ORDER BY m.rowid DESC LIMIT ?",
      )
      .all(pattern, botId ?? null, botId ?? null, limit) as {
      botId: string;
      title: string;
      date: string;
      text: string;
    }[];
    return rows.map(({ text, ...row }) => {
      const start = Math.max(0, text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 80);
      return { ...row, excerpt: text.slice(start, start + 300) };
    });
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.db.close();
    }
  }
}
