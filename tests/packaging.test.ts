import { expect, it } from 'vitest';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { sdkUrl } from '../src/main/engines/sdk';

it('loads SDKs from real unpacked paths while leaving development paths intact', () => {
  const relative = 'node_modules/@openai/codex-sdk/dist/index.js';
  const packed = pathToFileURL(resolve('.tmp/app.asar', relative)).href;
  const unpacked = pathToFileURL(resolve('.tmp/app.asar.unpacked', relative)).href;
  expect(sdkUrl(packed)).toBe(unpacked);
  expect(sdkUrl(unpacked)).toBe(unpacked);
  for (const name of [
    '@openai/codex-sdk',
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex/package.json',
  ]) {
    const url = sdkUrl(name);
    expect(url).not.toContain('app.asar/');
    expect(existsSync(fileURLToPath(url))).toBe(true);
  }
});
