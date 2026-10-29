import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { BotStore, chiefBot, parseBot } from '../src/main/bots/store';
import { legacyChiefInstructions } from '../src/main/bots/legacy-chief';
import { removeTemporary, temporaryDirectory, testBot } from './helpers';

let directory: string;
let store: BotStore | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
  if (directory) await removeTemporary(directory);
});
describe('bot Markdown', () => {
  it('parses metadata and instructions and rejects unsafe IDs, relative paths and invalid fields', () => {
    const { instructions, ...metadata } = testBot();
    expect(parseBot(matter.stringify(instructions, metadata))).toEqual(testBot());
    for (const patch of [
      { id: '../escape' },
      { engine: 'unknown' },
      { workdir: 'relative' },
      { id: 'chief', system: false },
      { avatar: { color: 'url(x)' } },
    ]) {
      expect(() => parseBot(matter.stringify(instructions, { ...metadata, ...patch }))).toThrow();
    }
  });
  it('defaults new bots and Chief to the configured engine model and accepts empty models', () => {
    const { instructions, ...metadata } = testBot();
    expect(chiefBot(metadata.workdir, 'tr').model).toBe('default');
    const source = matter.stringify(instructions, metadata);
    expect(parseBot(source.replace(/^model:.*\n/m, '')).model).toBe('default');
    expect(parseBot(matter.stringify(instructions, { ...metadata, model: '' })).model).toBe('');
  });
  it('seeds Chief once, sorts it first, preserves edits, and prevents deletion/demotion', async () => {
    directory = await temporaryDirectory();
    store = new BotStore(directory, chiefBot(directory, 'tr'));
    await store.init();
    expect(store.list()[0]).toMatchObject({ id: 'chief', system: true, name: 'Şef' });
    await store.save(testBot(directory, { name: 'AAA' }));
    await expect(store.delete('chief')).rejects.toThrow('errors.chiefProtected');
    await expect(store.save({ ...store.get('chief'), system: false })).rejects.toThrow();
    await store.save({ ...store.get('chief'), model: 'opus' });
    await store.close();
    store = new BotStore(directory, chiefBot(directory, 'en'));
    await store.init();
    expect(store.list()[0].model).toBe('opus');
    expect(store.get('chief').instructions).toBe('');
    expect(store.forRun('chief').instructions).toBe(chiefBot(directory, 'en').instructions);
  });
  it('reflects external changes and restores externally deleted Chief', async () => {
    directory = await temporaryDirectory();
    store = new BotStore(directory, chiefBot(directory, 'en'));
    await store.init();
    await store.save(testBot(directory));
    const path = join(directory, 'helper.md');
    const source = await readFile(path, 'utf8');
    await writeFile(path, source.replace('name: Helper', 'name: Updated'));
    await expect.poll(() => store!.get('helper').name).toBe('Updated');
    await unlink(join(directory, 'chief.md'));
    await expect
      .poll(async () => (await readFile(join(directory, 'chief.md'), 'utf8')).includes('id: chief'))
      .toBe(true);
    await store.delete('helper');
    expect(store.list()).toHaveLength(1);
  });
});

describe('YAML-only bot front matter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['javascript', 'js', 'JavaScript', 'coffee', 'coffeescript', 'json'])(
    'rejects %s files without executing their front matter',
    async (language) => {
      const effect = vi.fn();
      vi.stubGlobal('__penathonFrontMatterEffect', effect);
      directory = await temporaryDirectory();
      const frontMatter =
        language === 'json'
          ? JSON.stringify(testBot())
          : '(globalThis.__penathonFrontMatterEffect(), {})';
      const source = '---' + language + '\n' + frontMatter + '\n---\nInvalid bot';
      await writeFile(join(directory, 'hostile.md'), source);
      expect(() => parseBot(source)).toThrow();
      expect(effect).not.toHaveBeenCalled();
      store = new BotStore(directory, chiefBot(directory, 'en'));
      const invalid = vi.fn();
      store.on('invalid', invalid);
      await store.init();
      expect(invalid).toHaveBeenCalledWith('errors.botInvalid');
      expect(store.list().map((bot) => bot.id)).toEqual(['chief']);
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it.each(['yaml', 'yml'])('accepts %s metadata', (language) => {
    const { instructions, ...metadata } = testBot();
    const source = matter
      .stringify(instructions, metadata)
      .replace('---\n', '---' + language + '\n');
    expect(parseBot(source)).toEqual(testBot());
  });

  it('saves instruction text as literal content without executing embedded front matter', async () => {
    const effect = vi.fn();
    vi.stubGlobal('__penathonFrontMatterEffect', effect);
    directory = await temporaryDirectory();
    store = new BotStore(directory, chiefBot(directory, 'en'));
    await store.init();
    const instructions =
      '---javascript\n(globalThis.__penathonFrontMatterEffect(), {})\n---\nHelp.';
    await expect(store.save(testBot(directory, { instructions }))).resolves.toMatchObject({
      instructions,
    });
    expect(effect).not.toHaveBeenCalled();
    expect(parseBot(await readFile(join(directory, 'helper.md'), 'utf8')).instructions).toBe(
      instructions,
    );
  });
});

describe('Chief runtime template and migration', () => {
  it('stores only user notes and applies the current language template without duplicating it on save', async () => {
    directory = await temporaryDirectory();
    store = new BotStore(directory, chiefBot(directory, 'tr'));
    await store.init();
    expect(parseBot(await readFile(join(directory, 'chief.md'), 'utf8')).instructions).toBe('');
    await store.save({ ...store.get('chief'), instructions: 'Keep answers practical.' });
    expect(store.forRun('chief').instructions).toBe(
      chiefBot(directory, 'tr').instructions + '\n\nKeep answers practical.',
    );
    store.setLanguage('en');
    expect(store.forRun('chief').instructions).toBe(
      chiefBot(directory, 'en').instructions + '\n\nKeep answers practical.',
    );
    expect(store.get('chief').instructions).toBe('Keep answers practical.');
    expect(store.list()[0].instructions).toBe('Keep answers practical.');
    await store.save(testBot(directory));
    expect(store.forRun('helper')).toEqual(store.get('helper'));
  });
  it.each(legacyChiefInstructions)(
    'clears the exact shipped legacy template: %s',
    async (instructions) => {
      directory = await temporaryDirectory();
      const { instructions: template, ...metadata } = chiefBot(directory, 'en');
      expect(template).toContain('You are the chief');
      await writeFile(
        join(directory, 'chief.md'),
        matter.stringify({ content: instructions }, { ...metadata, model: 'opus' }),
      );
      store = new BotStore(directory, chiefBot(directory, 'tr'));
      await store.init();
      expect(store.get('chief')).toMatchObject({ instructions: '', model: 'opus' });
      expect(parseBot(await readFile(join(directory, 'chief.md'), 'utf8')).instructions).toBe('');
      expect(store.forRun('chief').instructions).toBe(chiefBot(directory, 'tr').instructions);
    },
  );
  it.each(['My own instructions.', legacyChiefInstructions[0] + '\nKeep this custom note.'])(
    'preserves a user-edited body byte for byte: %s',
    async (instructions) => {
      directory = await temporaryDirectory();
      const { instructions: template, ...metadata } = chiefBot(directory, 'en');
      expect(template).toContain('You are the chief');
      const source = matter.stringify({ content: instructions }, metadata);
      await writeFile(join(directory, 'chief.md'), source);
      store = new BotStore(directory, chiefBot(directory, 'en'));
      await store.init();
      expect(await readFile(join(directory, 'chief.md'), 'utf8')).toBe(source);
      expect(store.get('chief').instructions).toBe(instructions);
    },
  );
});
