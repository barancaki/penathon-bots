// @ts-check
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const engines = ['@anthropic-ai/claude-agent-sdk', '@openai/codex'];
const optionalPackages = engines.map((name) =>
  Object.keys(
    JSON.parse(
      readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'),
    ).optionalDependencies,
  ),
);

/** @param {string} platform @param {string} arch */
export function expectedEnginePackages(platform, arch) {
  return engines.map((engine, index) => {
    const name = `${engine}-${platform}-${arch}`;
    if (!optionalPackages[index].includes(name)) {
      throw new Error(`Engine architecture guard: ${engine} does not support ${platform}-${arch}`);
    }
    return name;
  });
}

/** @param {string} platform @param {string} arch @param {string[]} packages */
export function validateEnginePackages(platform, arch, packages) {
  const expected = expectedEnginePackages(platform, arch);
  const missing = expected.filter((name) => !packages.includes(name));
  const unexpected = packages.filter(
    (name) =>
      name !== '@openai/codex-sdk' &&
      engines.some((engine) => name.startsWith(`${engine}-`)) &&
      !expected.includes(name),
  );
  if (missing.length || unexpected.length) {
    throw new Error(
      `Engine architecture guard (${platform}-${arch}): missing [${missing.join(', ')}]; unexpected [${unexpected.join(', ')}]. Install dependencies on the target OS/architecture before packaging.`,
    );
  }
}
