import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { botSchema, type Bot } from '../src/shared/bots';
import type { BotEvent } from '../src/shared/events';

export async function temporaryDirectory(): Promise<string> {
  const root = resolve('.tmp/tests');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'case-'));
}
export async function removeTemporary(path: string): Promise<void> {
  const root = resolve('.tmp/tests');
  if (!path.startsWith(root + '/') && !path.startsWith(root + '\\'))
    throw new Error('Refusing removal outside test workspace');
  await rm(path, { recursive: true, force: true });
}
export function testBot(workdir = process.cwd(), patch: Partial<Bot> = {}): Bot {
  return botSchema.parse({
    id: 'helper',
    name: 'Helper',
    engine: 'claude',
    model: 'sonnet',
    workdir,
    readScope: [workdir],
    writeScope: [workdir],
    instructions: 'Help with the task.',
    ...patch,
  });
}
export async function collect(stream: AsyncIterable<BotEvent>): Promise<BotEvent[]> {
  const events: BotEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
