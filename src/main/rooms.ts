import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Bot } from '../shared/bots';
import type { Room, RoomActivity, RoomMessage } from '../shared/rooms';
import {
  roomDraftSchema,
  roomPatchSchema,
  roomTextSchema,
  roomMentions,
} from '../shared/room-helpers';
import type { BotStore } from './bots/store';
import type { Repository } from './db';
import type { ChatService } from './chat';
import type { Execution } from './bots/tools';
import { redact } from './engines/common';

type Turn = { botId: string; depth: number; chain: { responses: number; rootRunId?: string } };
type Pending = {
  controller: AbortController;
  queue: Turn[];
  active?: string;
  conversationId?: string;
  task: Promise<void>;
};

export function roomPrompt(
  room: Room,
  bots: Pick<Bot, 'id' | 'name'>[],
  messages: RoomMessage[],
): string {
  const header = `Bu bir ekip odası: ${room.name}. Üyeler: ${room.members.map((id) => bots.find((bot) => bot.id === id)?.name ?? id).join(', ')}. Başka üyeyi çağırmak için @Ad yaz; boşluklu adları @"Ad Soyad" biçiminde yaz.\n\nSon oda mesajları:\n`;
  let remaining = 12_000 - header.length;
  const lines: string[] = [];
  for (const message of messages.slice(-30).reverse()) {
    const author = message.author;
    const name =
      author.kind === 'user'
        ? 'Kullanıcı'
        : (bots.find((bot) => bot.id === author.botId)?.name ?? author.botId);
    const prefix = name + ': ';
    if (remaining <= prefix.length + 1) break;
    const text = message.text.slice(-(remaining - prefix.length - 1));
    lines.unshift(prefix + text);
    remaining -= prefix.length + text.length + 1;
    if (text.length < message.text.length) break;
  }
  return header + lines.join('\n');
}

export class Rooms extends EventEmitter {
  private pending = new Map<string, Pending>();
  private closing = false;
  private changing = new Set<string>();
  constructor(
    private bots: () => BotStore,
    private db: Repository,
    private chat: ChatService,
    private secrets: () => string[] | Promise<string[]>,
  ) {
    super();
  }

  list(): Room[] {
    return this.db.rooms();
  }
  private validate(room: Room): Room {
    room.members = [...new Set(room.members)];
    for (const id of room.members) this.bots().get(id);
    if (!room.members.includes(room.lead)) throw new Error('errors.invalidInput');
    return room;
  }
  create(input: unknown): Room {
    if (this.closing) throw new Error('App closing');
    const draft = roomDraftSchema.parse(input);
    const room = this.db.saveRoom(
      this.validate({
        ...draft,
        lead: draft.lead ?? (draft.members.includes('chief') ? 'chief' : draft.members[0]),
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      }),
    );
    this.emit('changed');
    return room;
  }
  async update(id: string, input: unknown): Promise<Room> {
    if (this.closing || this.changing.has(id)) throw new Error('errors.operationFailed');
    const patch = roomPatchSchema.parse(input);
    const before = this.db.room(id);
    const members = patch.members ?? before.members;
    const room = this.validate({
      ...before,
      ...patch,
      members,
      lead:
        patch.lead ??
        (members.includes(before.lead)
          ? before.lead
          : members.includes('chief')
            ? 'chief'
            : members[0]),
    });
    this.changing.add(id);
    try {
      if (patch.members || patch.lead) await this.cancel(id);
      this.db.saveRoom(room);
      this.emit('changed');
      return room;
    } finally {
      this.changing.delete(id);
    }
  }
  messages(id: string, limit?: number): RoomMessage[] {
    return this.db.roomMessages(id, limit);
  }
  activity(id: string): RoomActivity {
    this.db.room(id);
    const pending = this.pending.get(id);
    return {
      roomId: id,
      active: pending?.active,
      activeConversationId: pending?.conversationId,
      queue: pending?.queue.map((turn) => turn.botId) ?? [],
    };
  }
  private activityChanged(id: string): void {
    this.emit('activity', this.activity(id));
  }
  private message(input: Omit<RoomMessage, 'id' | 'createdAt'>): RoomMessage {
    const message = this.db.addRoomMessage(input);
    this.emit('message', message);
    return message;
  }
  private members(room: Room): Bot[] {
    return this.bots()
      .list()
      .filter((bot) => room.members.includes(bot.id));
  }
  private enqueue(
    room: Room,
    text: string,
    depth: number,
    chain: Turn['chain'],
    fallback = false,
  ): void {
    if (depth > 4 || chain.responses >= 6 || this.changing.has(room.id)) return;
    let targets = roomMentions(text, this.members(room));
    if (!targets.length && fallback) targets = [room.lead];
    if (!targets.length) return;
    let pending = this.pending.get(room.id);
    if (pending?.controller.signal.aborted) return;
    if (!pending) {
      pending = { controller: new AbortController(), queue: [], task: Promise.resolve() };
      this.pending.set(room.id, pending);
      const state = pending;
      state.task = Promise.resolve().then(() => this.drain(room.id, state));
    }
    pending.queue.push(...targets.map((botId) => ({ botId, depth, chain })));
    this.activityChanged(room.id);
  }
  async send(id: string, input: string): Promise<void> {
    if (this.closing) throw new Error('App closing');
    const text = redact(roomTextSchema.parse(input), await this.secrets());
    const pending = this.pending.get(id);
    if (pending?.controller.signal.aborted) await pending.task;
    if (this.closing || this.changing.has(id)) throw new Error('errors.operationFailed');
    const room = this.db.room(id);
    this.message({ roomId: id, author: { kind: 'user' }, text });
    this.enqueue(room, text, 1, { responses: 0 }, true);
  }
  async post(
    botId: string,
    id: string,
    input: string,
    runId: string,
    execution: Execution,
  ): Promise<RoomMessage> {
    const text = redact(roomTextSchema.parse(input), await this.secrets());
    const room = this.db.room(id);
    if (this.closing || this.changing.has(id) || execution.signal.aborted)
      throw new Error('Run cancelled');
    if (!room.members.includes(botId)) throw new Error('Room membership required');
    execution.room ??= { roomId: id, depth: 0, chain: { responses: 0 } };
    const { chain, depth } = execution.room;
    if (chain.responses >= 6 || depth > 4) throw new Error('Room reply limit reached');
    const run = this.db.runInfo(runId);
    if (run.botId !== botId || run.status !== 'running') throw new Error('Run cancelled');
    chain.responses++;
    const message = this.message({
      roomId: id,
      author: { kind: 'bot', botId },
      text,
      conversationId: run.conversationId,
      runId,
    });
    chain.rootRunId ??= execution.rootRunId;
    this.enqueue(room, text, depth + 1, chain);
    return message;
  }
  private async drain(id: string, pending: Pending): Promise<void> {
    const signal = pending.controller.signal;
    try {
      while (pending.queue.length && !signal.aborted) {
        const turn = pending.queue[0];
        if (turn.chain.responses >= 6 || !this.db.room(id).members.includes(turn.botId)) {
          pending.queue.shift();
          this.activityChanged(id);
          continue;
        }
        try {
          await this.chat.waitForBot(turn.botId, signal);
          if (signal.aborted) break;
          if (turn.chain.responses >= 6) continue;
          const room = this.db.room(id);
          const prompt = roomPrompt(room, this.bots().list(), this.messages(id, 30));
          turn.chain.responses++;
          let run;
          try {
            run = await this.chat.send(
              turn.botId,
              prompt,
              this.db.roomConversation(id, turn.botId),
              undefined,
              {
                rootRunId: turn.chain.rootRunId,
                title: room.name,
                signal,
                room: { roomId: id, depth: turn.depth, chain: turn.chain },
              },
            );
          } catch (error) {
            turn.chain.responses--;
            throw error;
          }
          pending.queue.shift();
          pending.active = turn.botId;
          pending.conversationId = run.conversationId;
          this.activityChanged(id);
          await this.chat.waitForRun(run.conversationId, { signal });
          if (signal.aborted) break;
          const events = this.db
            .get(run.conversationId)
            .events.filter((event) => event.runId === run.runId)
            .map((event) => event.event);
          const answer = events.filter((event) => event.type === 'message.done').at(-1)?.text;
          if (answer) {
            this.message({
              roomId: id,
              author: { kind: 'bot', botId: turn.botId },
              text: answer,
              ...run,
            });
            if (
              !events.some(
                (event) =>
                  event.type === 'run.error' || (event.type === 'run.done' && event.cancelled),
              )
            )
              this.enqueue(this.db.room(id), answer, turn.depth + 1, turn.chain);
          }
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof Error && error.message === 'errors.botBusy') continue;
          if (pending.queue[0] === turn) pending.queue.shift();
        } finally {
          pending.active = undefined;
          pending.conversationId = undefined;
          this.activityChanged(id);
        }
      }
    } finally {
      if (this.pending.get(id) === pending) this.pending.delete(id);
      this.activityChanged(id);
    }
  }
  async cancel(id: string): Promise<void> {
    this.db.room(id);
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.queue.length = 0;
    pending.controller.abort();
    if (pending.conversationId) this.chat.cancel(pending.conversationId);
    this.activityChanged(id);
    await pending.task;
  }
  async delete(id: string): Promise<void> {
    if (this.changing.has(id)) throw new Error('errors.operationFailed');
    this.changing.add(id);
    try {
      await this.cancel(id);
      for (const conversationId of this.db.roomConversations(id))
        await this.chat.stopConversation(conversationId);
      this.db.deleteRoom(id);
      this.emit('changed');
    } finally {
      this.changing.delete(id);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.pending.keys()].map((id) => this.cancel(id)));
  }
}
