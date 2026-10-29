import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatService } from '../src/main/chat';
import { Repository } from '../src/main/db';
import { BotStore, chiefBot } from '../src/main/bots/store';
import { roomPrompt } from '../src/main/rooms';
import { roomMentions } from '../src/shared/room-helpers';
import { notificationDecision } from '../src/main/notifications';
import { settingsSchema } from '../src/shared/settings';
import type { EngineAdapter, RunInput } from '../src/main/engines/types';
import type { Room, RoomActivity, RoomMessage } from '../src/shared/rooms';
import type { EventEnvelope } from '../src/shared/events';
import { removeTemporary, temporaryDirectory } from './helpers';

let directory: string;
let bots: BotStore;
let db: Repository;
let chat: ChatService;
let room: Room;
let workerId: string;
let contentId: string;
let inputs: RunInput[];
let events: EventEnvelope[];
let handler: (input: RunInput) => Promise<string>;
let releases: (() => void)[];
let secrets: string[];
let running: number;
let maxRunning: number;
const makeChat = () => {
  const engine: EngineAdapter = {
    id: 'claude',
    cancel() {},
    models: async () => [],
    checkAuth: async () => ({ mode: 'local-cli', state: 'unverified', messageKey: '' }),
    async *run(input) {
      inputs.push(input);
      running++;
      maxRunning = Math.max(running, maxRunning);
      try {
        yield { type: 'status', status: 'thinking' };
        const text = await handler(input);
        yield {
          type: 'tool.start',
          toolId: 'step',
          kind: 'mcp',
          title: 'team/list_bots',
          argsSummary: '{}',
        };
        yield { type: 'tool.end', toolId: 'step', resultSummary: 'Done', error: false };
        yield { type: 'message.done', messageId: 'answer', text };
        yield {
          type: 'run.done',
          durationMs: 1,
          resumeToken: 'session-' + input.bot.id,
          cancelled: input.signal.aborted,
        };
      } finally {
        running--;
      }
    },
  };
  return new ChatService(
    () => bots,
    db,
    { claude: engine, codex: { ...engine, id: 'codex' } },
    () => secrets,
    (event) => events.push(event),
  );
};
function hold(input: RunInput): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      input.signal.removeEventListener('abort', finish);
      resolve();
    };
    releases.push(finish);
    input.signal.addEventListener('abort', finish, { once: true });
    if (input.signal.aborted) finish();
  });
}
async function idle(id = room.id) {
  await expect
    .poll(() => chat.rooms.activity(id), { timeout: 5000 })
    .toEqual({ roomId: id, active: undefined, queue: [] });
}
const replies = (id = room.id) =>
  chat.rooms.messages(id).filter((message) => message.author.kind === 'bot');

it('masks freshly registered MCP secrets before team tools persist memory, reports and room notifications', async () => {
  const first = 'fixture-mcp-secret-one';
  const second = 'fixture-mcp-secret-two';
  const notifications: unknown[] = [];
  const config = settingsSchema.parse({ botsDir: 'bots', engines: { claude: {}, codex: {} } });
  config.notifications.rooms = true;
  chat.rooms.on('message', (message: RoomMessage) =>
    notifications.push(
      notificationDecision(
        {
          type: 'room.message',
          id: message.id,
          botName: bots.get(workerId).name,
          target: { roomId: room.id },
          text: message.text,
          author: 'bot',
        },
        config,
        {},
        false,
      ),
    ),
  );
  handler = async (input) => {
    input.addRedactionSecret!(first);
    await input.callTool!('remember', { text: 'Memo ' + first });
    input.addRedactionSecret!(second);
    const text = first + ' ' + second;
    await input.callTool!('report_to_chief', {
      summary: text,
      decisions: [text],
      files: [text],
      open: [text],
    });
    await input.callTool!('post_to_room', { roomId: room.id, text });
    return 'Done';
  };
  const run = await chat.send(workerId, 'Work');
  await chat.waitForRun(run.conversationId, { signal: new AbortController().signal });
  expect(db.runInfo(run.runId).status).toBe('done');
  expect(await bots.getMemory(workerId)).toContain('Memo [REDACTED]');
  expect(replies()[0].text).toBe('[REDACTED] [REDACTED]');
  expect(db.reports()[0]).toMatchObject({
    summary: '[REDACTED] [REDACTED]',
    decisions: ['[REDACTED] [REDACTED]'],
    files: ['[REDACTED] [REDACTED]'],
    open: ['[REDACTED] [REDACTED]'],
  });
  expect(notifications[0]).toMatchObject({ body: '[REDACTED] [REDACTED]' });
  const persisted = JSON.stringify({
    messages: chat.rooms.messages(room.id),
    events,
    notifications,
    reports: db.reports(),
    memory: await bots.getMemory(workerId),
    conversation: db.get(run.conversationId),
  });
  expect(persisted).not.toContain(first);
  expect(persisted).not.toContain(second);
});

beforeEach(async () => {
  directory = await temporaryDirectory();
  bots = new BotStore(join(directory, 'bots'), chiefBot(directory, 'en'));
  await bots.init();
  workerId = (await bots.create({ name: 'Lead Takibi', engine: 'codex', instructions: 'Help' })).id;
  contentId = (
    await bots.create({ name: 'İçerik Stüdyosu', engine: 'claude', instructions: 'Write' })
  ).id;
  db = new Repository(join(directory, 'rooms.sqlite'));
  inputs = [];
  events = [];
  releases = [];
  secrets = [];
  running = 0;
  maxRunning = 0;
  handler = async (input) => 'Answer from ' + input.bot.name;
  chat = makeChat();
  room = chat.rooms.create({ name: 'Acme lansmanı', members: [workerId, 'chief', contentId] });
});
afterEach(async () => {
  await chat?.close();
  db?.close();
  await bots?.close();
  if (directory) await removeTemporary(directory);
});

it('resolves Turkish, quoted, underscore and compact mentions in message order without email or duplicate matches', () => {
  const members = bots.list();
  expect(
    roomMentions('@Lead_Takibi sonra @"İçerik Stüdyosu" @LeadTakibi @İÇERİK_STÜDYOSU', members),
  ).toEqual([workerId, contentId]);
  expect(roomMentions('foo@LeadTakibi @@Chief @Unknown @"Lead Takibi Extra"', members)).toEqual([]);
  expect(roomMentions('@"Lead Takibi", @Chief!', members)).toEqual([workerId, 'chief']);
  expect(roomMentions('@ŞEF @Şef', [{ id: 'chief', name: 'Şef' }])).toEqual(['chief']);
});

it('chooses Chief or the first member by default, validates membership and updates the lead when removed', async () => {
  expect(room.lead).toBe('chief');
  expect(chat.rooms.create({ name: 'Small', members: [contentId, workerId] }).lead).toBe(contentId);
  expect(() => chat.rooms.create({ name: 'Bad', members: ['missing'] })).toThrow();
  expect(() => chat.rooms.create({ name: 'Bad', members: [workerId], lead: 'chief' })).toThrow(
    'errors.invalidInput',
  );
  expect(() => chat.rooms.create({ name: 'Bad', members: [] })).toThrow();
  expect(
    (await chat.rooms.update(room.id, { members: [contentId, workerId, workerId] })).lead,
  ).toBe(contentId);
  expect(db.room(room.id).members).toEqual([contentId, workerId]);
  await chat.rooms.send(room.id, 'No mention');
  await idle();
  expect(inputs.map((input) => input.bot.id)).toEqual([contentId]);
});

it('publishes the user first, runs mentioned members in order and links final replies to hidden event histories', async () => {
  const published: RoomMessage[] = [];
  chat.rooms.on('message', (message) => published.push(message));
  await chat.rooms.send(room.id, '@Lead_Takibi @"İçerik Stüdyosu" hazırlayalım');
  expect(published[0].author).toEqual({ kind: 'user' });
  await idle();
  expect(inputs.map((input) => input.bot.id)).toEqual([workerId, contentId]);
  expect(maxRunning).toBe(1);
  expect(replies()).toHaveLength(2);
  for (const message of replies()) {
    const detail = db.get(message.conversationId!);
    expect(
      detail.events.some(
        (event) => event.runId === message.runId && event.event.type === 'tool.start',
      ),
    ).toBe(true);
    expect(events.some((event) => event.conversationId === message.conversationId)).toBe(true);
    expect(db.list(detail.conversation.botId)).toEqual([]);
  }
  expect(inputs[1].prompt).toContain('Lead Takibi: Answer from Lead Takibi');
  expect(inputs[0].prompt).toContain('Bu bir ekip odası');
  await chat.rooms.send(room.id, 'Mention yok');
  await idle();
  expect(inputs.at(-1)?.bot.id).toBe('chief');
});

it('publishes the active hidden conversation for each turn and clears it after cancellation', async () => {
  const activities: RoomActivity[] = [];
  chat.rooms.on('activity', (activity) => activities.push(activity));
  handler = async (input) => {
    await hold(input);
    return 'Done';
  };
  await chat.rooms.send(room.id, '@LeadTakibi @Chief');
  await expect.poll(() => inputs.length).toBe(1);
  expect(chat.rooms.activity(room.id)).toMatchObject({
    active: workerId,
    activeConversationId: inputs[0].conversationId,
    queue: ['chief'],
  });
  expect(activities.at(-1)).toEqual(chat.rooms.activity(room.id));
  expect(db.roomConversation(room.id, workerId)).toBe(inputs[0].conversationId);
  releases[0]();
  await expect.poll(() => inputs.length).toBe(2);
  expect(inputs[1].conversationId).not.toBe(inputs[0].conversationId);
  expect(activities.at(-1)).toMatchObject({
    active: 'chief',
    activeConversationId: inputs[1].conversationId,
    queue: [],
  });
  await chat.rooms.cancel(room.id);
  expect(chat.rooms.activity(room.id).activeConversationId).toBeUndefined();
  expect(activities.at(-1)?.activeConversationId).toBeUndefined();
});

it('preserves one engine session per room and bot across restarts, isolated from other rooms and direct chats', async () => {
  await chat.rooms.send(room.id, '@LeadTakibi first');
  await idle();
  const first = replies()[0];
  const other = chat.rooms.create({ name: 'Other', members: [workerId] });
  await chat.rooms.send(other.id, 'Separate');
  await idle(other.id);
  expect(inputs[1].resumeToken).toBeUndefined();
  expect(replies(other.id)[0].conversationId).not.toBe(first.conversationId);
  await chat.close();
  db.close();
  db = new Repository(join(directory, 'rooms.sqlite'));
  chat = makeChat();
  expect(chat.rooms.messages(room.id)).toHaveLength(2);
  await chat.rooms.send(room.id, '@LeadTakibi again');
  await idle();
  expect(inputs.at(-1)?.resumeToken).toBe('session-' + workerId);
  expect(replies().at(-1)?.conversationId).toBe(first.conversationId);
  const direct = await chat.send(workerId, 'Direct');
  await expect.poll(() => chat.isBotActive(workerId)).toBe(false);
  expect(direct.conversationId).not.toBe(first.conversationId);
  expect(inputs.at(-1)?.resumeToken).toBeUndefined();
  expect(db.list(workerId)).toHaveLength(1);
});

it('limits the context to the latest 30 messages and 12k characters while retaining author names and the latest text', () => {
  const messages: RoomMessage[] = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    roomId: room.id,
    author: { kind: 'user' },
    text: `message-${i}: ` + 'x'.repeat(600),
    createdAt: new Date().toISOString(),
  }));
  const prompt = roomPrompt(room, bots.list(), messages);
  expect(prompt.length).toBeLessThanOrEqual(12_000);
  expect(prompt).toContain('Kullanıcı: message-39:');
  expect(prompt).not.toContain('message-9:');
  expect(prompt).toContain('Başka üyeyi çağırmak için @Ad');
  messages.at(-1)!.text = 'x'.repeat(20_000) + 'LATEST';
  const long = roomPrompt(room, bots.list(), messages);
  expect(long.length).toBeLessThanOrEqual(12_000);
  expect(long).toContain('Kullanıcı: ');
  expect(long.endsWith('LATEST')).toBe(true);
  const short = roomPrompt(
    room,
    bots.list(),
    messages.map((message, i) => ({ ...message, text: 'short-' + i })),
  );
  expect(short).toContain('short-10');
  expect(short).not.toContain('short-9');
  expect(short.split('Kullanıcı: ')).toHaveLength(31);
});
it('keeps historical author names after a member leaves while listing only current members in the prompt', () => {
  const current = { ...room, members: ['chief'], lead: 'chief' };
  const prompt = roomPrompt(current, bots.list(), [
    {
      id: 'old',
      roomId: room.id,
      author: { kind: 'bot', botId: workerId },
      text: 'Earlier work',
      createdAt: new Date().toISOString(),
    },
  ]);
  expect(prompt).toContain('Üyeler: Chief.');
  expect(prompt).toContain('Lead Takibi: Earlier work');
});

it('stops mention loops at depth four', async () => {
  handler = async () => '@Chief devam';
  await chat.rooms.send(room.id, 'Start');
  await idle();
  expect(inputs).toHaveLength(4);
  expect(replies()).toHaveLength(4);
});

it('caps branching chains at six replies per user message and gives the next user message its own budget', async () => {
  handler = async () => '@Chief @LeadTakibi @İçerikStüdyosu devam';
  await chat.rooms.send(room.id, '@Chief @LeadTakibi @İçerikStüdyosu');
  await idle();
  expect(inputs).toHaveLength(6);
  expect(replies()).toHaveLength(6);
  await chat.rooms.send(room.id, 'Next');
  await idle();
  expect(inputs).toHaveLength(12);
  expect(replies()).toHaveLength(12);
  expect(maxRunning).toBe(1);
});

it('waits for a busy bot and preserves queued member and user message order', async () => {
  handler = async (input) => {
    if (input.prompt === 'Direct busy') await hold(input);
    return 'Done';
  };
  await chat.send(workerId, 'Direct busy');
  await expect.poll(() => inputs.length).toBe(1);
  await chat.rooms.send(room.id, '@LeadTakibi @Chief');
  await chat.rooms.send(room.id, '@İçerikStüdyosu');
  expect(chat.rooms.activity(room.id)).toEqual({
    roomId: room.id,
    active: undefined,
    queue: [workerId, 'chief', contentId],
  });
  expect(inputs).toHaveLength(1);
  releases[0]();
  await idle();
  expect(inputs.map((input) => input.bot.id)).toEqual([workerId, workerId, 'chief', contentId]);
  expect(maxRunning).toBe(1);
});

it('cancels a waiting queue without cancelling the unrelated run occupying the bot', async () => {
  handler = async (input) => {
    await hold(input);
    return 'Done';
  };
  await chat.send(workerId, 'Direct busy');
  await expect.poll(() => inputs.length).toBe(1);
  await chat.rooms.send(room.id, '@LeadTakibi @Chief');
  await chat.rooms.cancel(room.id);
  await idle();
  expect(inputs).toHaveLength(1);
  expect(inputs[0].signal.aborted).toBe(false);
  expect(chat.isBotActive(workerId)).toBe(true);
  expect(replies()).toEqual([]);
  releases[0]();
});

it('cancels the room run and its remaining queue, then accepts a new user turn', async () => {
  handler = async (input) => {
    await hold(input);
    return '@Chief must not run';
  };
  await chat.rooms.send(room.id, '@LeadTakibi @Chief');
  await expect.poll(() => inputs.length).toBe(1);
  await chat.rooms.cancel(room.id);
  await idle();
  expect(inputs[0].signal.aborted).toBe(true);
  await expect.poll(() => chat.isBotActive(workerId)).toBe(false);
  expect(replies()).toEqual([]);
  handler = async () => 'Fresh answer';
  await chat.rooms.send(room.id, 'Fresh');
  await idle();
  expect(inputs).toHaveLength(2);
  expect(replies().map((message) => message.text)).toEqual(['Fresh answer']);
});

it('allows Chief to create rooms without approval, requires existing bots and rejects creation by other bots', async () => {
  handler = async (input) => {
    if (input.bot.id === 'chief') {
      await expect(
        input.callTool!('create_room', { name: 'Missing', members: ['missing'] }),
      ).rejects.toThrow();
      await input.callTool!('create_room', { name: 'Tool room', members: [workerId, contentId] });
    } else
      await expect(
        input.callTool!('create_room', { name: 'Forbidden', members: [workerId] }),
      ).rejects.toThrow('Only Chief may do this.');
    return 'Done';
  };
  await chat.rooms.send(room.id, '@Chief @LeadTakibi');
  await idle();
  expect(chat.rooms.list().find((room) => room.name === 'Tool room')?.lead).toBe(workerId);
  expect(events.some(({ event }) => event.type === 'approval.request')).toBe(false);
});

it('posts member messages through the tool and queues their mentions within the same chain', async () => {
  handler = async (input) => {
    if (input.bot.id === 'chief')
      await input.callTool!('post_to_room', { roomId: room.id, text: '@LeadTakibi bu kısmı al' });
    return input.bot.name + ' final';
  };
  await chat.rooms.send(room.id, 'Start');
  await idle();
  expect(inputs.map((input) => input.bot.id)).toEqual(['chief', workerId]);
  expect(replies().map((message) => message.text)).toEqual([
    '@LeadTakibi bu kısmı al',
    'Chief final',
    'Lead Takibi final',
  ]);
  const outsider = await bots.create({ name: 'Outsider', engine: 'claude', instructions: 'Help' });
  const denied = vi.fn();
  handler = async (input) => {
    await expect(
      input.callTool!('post_to_room', { roomId: room.id, text: 'Forbidden' }),
    ).rejects.toThrow('Room membership is required.');
    denied();
    return 'Done';
  };
  await chat.send(outsider.id, 'Post');
  await expect.poll(() => denied.mock.calls.length).toBe(1);
  expect(replies()).toHaveLength(3);
});

it('counts explicit posts and the final answer toward the same six-message budget', async () => {
  let rejected = 0;
  handler = async (input) => {
    for (let i = 0; i < 8; i++) {
      try {
        await input.callTool!('post_to_room', { roomId: room.id, text: 'Post ' + i });
      } catch {
        rejected++;
      }
    }
    return 'Final answer';
  };
  await chat.rooms.send(room.id, 'Start');
  await idle();
  expect(replies()).toHaveLength(6);
  expect(replies().at(-1)?.text).toBe('Final answer');
  expect(rejected).toBe(3);
});

it('redacts room user messages, posted messages, final answers and stored prompts before persistence and broadcasts', async () => {
  secrets = ['ROOM_TEST_SECRET'];
  const published: RoomMessage[] = [];
  chat.rooms.on('message', (message) => published.push(message));
  handler = async (input) => {
    await input.callTool!('post_to_room', { roomId: room.id, text: 'Post ROOM_TEST_SECRET' });
    return 'Answer ROOM_TEST_SECRET';
  };
  await chat.rooms.send(room.id, 'User ROOM_TEST_SECRET');
  await idle();
  expect(JSON.stringify(published)).not.toContain('ROOM_TEST_SECRET');
  expect(JSON.stringify(chat.rooms.messages(room.id))).not.toContain('ROOM_TEST_SECRET');
  expect(JSON.stringify(db.get(replies()[0].conversationId!))).not.toContain('ROOM_TEST_SECRET');
  expect(published.every((message) => message.text.includes('[REDACTED]'))).toBe(true);
});

it('deletes room messages and all hidden conversations while preserving other rooms and direct chats', async () => {
  await chat.rooms.send(room.id, '@LeadTakibi @Chief');
  await idle();
  const hidden = replies().map((message) => message.conversationId!);
  await chat.rooms.update(room.id, { members: [contentId] });
  const other = chat.rooms.create({ name: 'Keep room', members: [contentId] });
  await chat.rooms.send(other.id, 'Keep');
  await idle(other.id);
  const direct = await chat.send(workerId, 'Keep direct');
  await expect.poll(() => chat.isBotActive(workerId)).toBe(false);
  await chat.rooms.delete(room.id);
  expect(() => chat.rooms.messages(room.id)).toThrow('errors.roomMissing');
  for (const id of hidden) expect(() => db.get(id)).toThrow('errors.conversationMissing');
  expect(replies(other.id)).toHaveLength(1);
  expect(db.get(direct.conversationId).messages[0].text).toBe('Keep direct');
  const raw = new DatabaseSync(join(directory, 'rooms.sqlite'));
  try {
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM room_messages WHERE roomId = ?').get(room.id)?.n,
    ).toBe(0);
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    raw.close();
  }
});

it('cancels an active room before deleting it and prevents late events from recreating its history', async () => {
  handler = async (input) => {
    await hold(input);
    return 'Late';
  };
  await chat.rooms.send(room.id, '@LeadTakibi @Chief');
  await expect.poll(() => inputs.length).toBe(1);
  const conversationId = inputs[0].conversationId;
  await chat.rooms.delete(room.id);
  expect(inputs[0].signal.aborted).toBe(true);
  expect(() => db.get(conversationId)).toThrow('errors.conversationMissing');
  expect(chat.rooms.list()).toEqual([]);
  expect(inputs).toHaveLength(1);
});
