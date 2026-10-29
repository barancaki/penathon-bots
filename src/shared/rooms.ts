/**
 * Team rooms: one stream, several bots. The user (or a bot) calls a member
 * with `@Name`; without a mention the room's lead answers.
 */
export type Room = {
  id: string;
  name: string;
  /** Bot ids; the lead is always a member. */
  members: string[];
  lead: string;
  createdAt: string;
};

export type RoomAuthor = { kind: 'user' } | { kind: 'bot'; botId: string };

export type RoomMessage = {
  id: string;
  roomId: string;
  author: RoomAuthor;
  text: string;
  createdAt: string;
  /** For bot messages: the bot's hidden room conversation, where steps and cards live. */
  conversationId?: string;
  runId?: string;
};

/** Live state of a room, for the typing row and the cancel button. */
export type RoomActivity = {
  roomId: string;
  /** Bot currently answering, if any. */
  active?: string;
  /** The answering bot's hidden room conversation, so its approval cards show in the room. */
  activeConversationId?: string;
  /** Bots waiting their turn, in order. */
  queue: string[];
};
