import { z } from 'zod';
import { botSchema, type Bot } from './bots';

export const roomDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    members: z.array(botSchema.shape.id).min(1).max(100),
    lead: botSchema.shape.id.optional(),
  })
  .strict();
export const roomPatchSchema = roomDraftSchema.partial();
export const roomTextSchema = z.string().trim().min(1).max(100_000);

const mentionKey = (text: string) =>
  text
    .toLocaleLowerCase('tr')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[\s_]/g, '');

export function roomMentions(text: string, members: Pick<Bot, 'id' | 'name'>[]): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(
    /(?<![\p{L}\p{M}\p{N}_@])@(?:"([^"\r\n]+)"|([\p{L}\p{M}\p{N}_-]+))/gu,
  )) {
    const key = mentionKey(match[1] ?? match[2]);
    for (const bot of members)
      if (mentionKey(bot.name) === key || mentionKey(bot.id) === key) ids.add(bot.id);
  }
  return [...ids];
}
