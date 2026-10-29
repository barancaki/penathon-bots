import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { botSchema } from '../src/shared/bots';
import { ClaudeEngine } from '../src/main/engines/claude';
import { CodexEngine } from '../src/main/engines/codex';
import type { EngineContext } from '../src/main/engines/types';

// This command intentionally contacts real accounts. It is never part of tests/build.
const context: EngineContext = {
  auth: () => ({ mode: 'local-cli' }),
  knowledgeDir: () => undefined,
};
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
let failed = false;
for (const engine of [new ClaudeEngine(context), new CodexEngine(context)]) {
  const workdir = resolve(process.env.PENATHON_SMOKE_WORKDIR ?? process.cwd());
  const bot = botSchema.parse({
    id: `smoke-${engine.id}`,
    name: 'Smoke',
    engine: engine.id,
    model:
      process.env[
        engine.id === 'claude' ? 'PENATHON_SMOKE_CLAUDE_MODEL' : 'PENATHON_SMOKE_CODEX_MODEL'
      ] ?? 'default',
    workdir,
    readScope: [workdir],
    writeScope: [],
    sandbox: 'read-only',
    instructions: 'Answer briefly. Do not use tools.',
  });
  for await (const event of engine.run({
    bot,
    conversationId: randomUUID(),
    prompt: 'Merhaba, tek kelimeyle cevap ver',
    signal: controller.signal,
  })) {
    console.log(JSON.stringify({ engine: engine.id, event }));
    if (event.type === 'run.error') failed = true;
  }
  if (controller.signal.aborted) break;
}
process.exitCode = failed ? 1 : 0;
