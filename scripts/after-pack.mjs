// @ts-check
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Arch } from 'app-builder-lib';
import { validateEnginePackages } from './engine-arch.mjs';

/** @param {import('app-builder-lib').AfterPackContext} context */
export default function afterPack({ electronPlatformName, arch, appOutDir, packager }) {
  const resources =
    electronPlatformName === 'darwin'
      ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(appOutDir, 'resources');
  const modules = join(resources, 'app.asar.unpacked', 'node_modules');
  const packages = ['@anthropic-ai', '@openai'].flatMap((scope) => {
    try {
      return readdirSync(join(modules, scope), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${scope}/${entry.name}`);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
      throw error;
    }
  });
  try {
    validateEnginePackages(electronPlatformName, Arch[arch], packages);
  } catch (error) {
    throw new Error(
      `Invalid unpacked engines at ${modules}: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
}
