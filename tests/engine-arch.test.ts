import { expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Arch, type AfterPackContext } from 'app-builder-lib';
import { expectedEnginePackages, validateEnginePackages } from '../scripts/engine-arch.mjs';
import afterPack from '../scripts/after-pack.mjs';
import { removeTemporary, temporaryDirectory } from './helpers';

it.each([
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['win32', 'arm64'],
  ['win32', 'x64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
])('maps the real optional dependency directory names for %s-%s', (platform, arch) => {
  const packages = [
    `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
    `@openai/codex-${platform}-${arch}`,
  ];
  expect(expectedEnginePackages(platform, arch)).toEqual(packages);
  expect(() =>
    validateEnginePackages(platform, arch, [
      ...packages,
      '@anthropic-ai/claude-agent-sdk',
      '@openai/codex',
      '@openai/codex-sdk',
      '@anthropic-ai/sdk',
    ]),
  ).not.toThrow();
});

it.each([0, 1])('rejects a missing engine directory (%s)', (index) => {
  const packages = expectedEnginePackages('darwin', 'arm64');
  const [missing] = packages.splice(index, 1);
  expect(() => validateEnginePackages('darwin', 'arm64', packages)).toThrow(`missing [${missing}]`);
});

it.each([
  '@anthropic-ai/claude-agent-sdk-darwin-x64',
  '@anthropic-ai/claude-agent-sdk-win32-arm64',
  '@openai/codex-darwin-x64',
  '@openai/codex-linux-arm64',
])('rejects an extra wrong-target engine even when both expected packages exist: %s', (name) => {
  expect(() =>
    validateEnginePackages('darwin', 'arm64', [...expectedEnginePackages('darwin', 'arm64'), name]),
  ).toThrow(`unexpected [${name}]`);
});

it('rejects the original arm64 engines in an x64 application', () => {
  expect(() =>
    validateEnginePackages('darwin', 'x64', expectedEnginePackages('darwin', 'arm64')),
  ).toThrow(/darwin-x64.*missing \[.+darwin-x64.*unexpected \[.+darwin-arm64/);
});

it.each([
  ['darwin', 'universal'],
  ['win32', 'ia32'],
  ['freebsd', 'x64'],
])('fails clearly for unsupported targets: %s-%s', (platform, arch) => {
  expect(() => expectedEnginePackages(platform, arch)).toThrow(
    `does not support ${platform}-${arch}`,
  );
});

it.each(['darwin', 'win32', 'linux'])(
  'checks unpacked directories in the %s app layout using the builder Arch enum',
  async (platform) => {
    const directory = await temporaryDirectory();
    const resources =
      platform === 'darwin'
        ? join(directory, 'Penathon Bots.app', 'Contents', 'Resources')
        : join(directory, 'resources');
    const modules = join(resources, 'app.asar.unpacked', 'node_modules');
    const packages = expectedEnginePackages(platform, 'arm64');
    const context = {
      electronPlatformName: platform,
      arch: Arch.arm64,
      appOutDir: directory,
      packager: { appInfo: { productFilename: 'Penathon Bots' } },
    } as AfterPackContext;
    try {
      expect(() => afterPack(context)).toThrow(`Invalid unpacked engines at ${modules}`);
      for (const name of packages) await mkdir(join(modules, name), { recursive: true });
      expect(() => afterPack(context)).not.toThrow();
      await mkdir(join(modules, '@openai/codex-darwin-x64'), { recursive: true });
      expect(() => afterPack(context)).toThrow('unexpected [@openai/codex-darwin-x64]');
      await rm(join(modules, '@openai/codex-darwin-x64'), { recursive: true });
      await rm(join(modules, packages[0]), { recursive: true });
      expect(() => afterPack(context)).toThrow(`missing [${packages[0]}]`);
    } finally {
      await removeTemporary(directory);
    }
  },
);
