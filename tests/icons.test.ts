import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { removeTemporary, temporaryDirectory } from './helpers';

it('renders a 1024 PNG and a seven-layer PNG ICO with valid offsets and dimensions', async () => {
  const directory = await temporaryDirectory();
  try {
    await mkdir(join(directory, 'build'));
    await copyFile(resolve('build/icon.svg'), join(directory, 'build/icon.svg'));
    await promisify(execFile)(process.execPath, [resolve('scripts/build-icons.mjs')], {
      cwd: directory,
      windowsHide: true,
    });
    const png = await readFile(join(directory, 'build/icon.png'));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    const ico = await readFile(join(directory, 'build/icon.ico'));
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(7);
    let offset = 6 + 16 * sizes.length;
    for (const [i, size] of sizes.entries()) {
      const entry = 6 + 16 * i;
      expect(ico[entry] || 256).toBe(size);
      expect(ico[entry + 1] || 256).toBe(size);
      expect(ico.readUInt16LE(entry + 4)).toBe(1);
      expect(ico.readUInt16LE(entry + 6)).toBe(32);
      expect(ico.readUInt32LE(entry + 12)).toBe(offset);
      const length = ico.readUInt32LE(entry + 8);
      const layer = ico.subarray(offset, offset + length);
      expect(layer.subarray(0, 8)).toEqual(png.subarray(0, 8));
      expect(layer.readUInt32BE(16)).toBe(size);
      expect(layer.readUInt32BE(20)).toBe(size);
      offset += length;
    }
    expect(offset).toBe(ico.length);
  } finally {
    await removeTemporary(directory);
  }
}, 20_000);
