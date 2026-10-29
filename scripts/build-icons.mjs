import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { Resvg } from '@resvg/resvg-js';

const directory = resolve('build');
const svg = await readFile(resolve(directory, 'icon.svg'));
const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
await writeFile(resolve(directory, 'icon.png'), render(1024));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const layers = sizes.map(render);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [i, size] of sizes.entries()) {
  const entry = 6 + i * 16;
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(layers[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += layers[i].length;
}
await writeFile(resolve(directory, 'icon.ico'), Buffer.concat([header, ...layers]));
