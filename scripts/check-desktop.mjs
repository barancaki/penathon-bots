import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

const directory = resolve('.tmp', `desktop-${Date.now()}`);
mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
app.setPath('sessionData', directory);
app.disableHardwareAcceleration();
app.on('browser-window-created', (_event, window) => {
  window.hide();
});
async function check() {
  try {
    await import('../out/main/index.js');
    await app.whenReady();
    let window;
    for (let attempt = 0; attempt < 100; attempt++) {
      window = BrowserWindow.getAllWindows()[0];
      if (
        window &&
        !window.webContents.isLoading() &&
        window.webContents.getURL().startsWith('file:')
      )
        break;
      await setTimeout(100);
    }
    assert.ok(window, 'main created a window');
    const evaluate = (code) => window.webContents.executeJavaScript(code);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('!!window.api && document.body.innerText.includes("Şef")')) break;
      await setTimeout(100);
    }
    assert.equal(await evaluate('typeof window.require'), 'undefined');
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
    assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true);
    assert.equal(window.webContents.getLastWebPreferences().nodeIntegration, false);
    const bots = await evaluate('window.api.bots.list()');
    assert.equal(bots[0].id, 'chief');
    assert.equal(bots[0].system, true);
    assert.equal(
      await evaluate('window.api.bots.delete("chief").then(() => false, () => true)'),
      true,
    );
    assert.equal(
      await evaluate('window.api.chat.send("chief", "").then(() => false, () => true)'),
      true,
    );
    await evaluate(
      'window.api.bots.get("chief").then(bot => window.api.bots.save({...bot, engine: "codex", model: "offline-test-model"}))',
    );
    assert.match(await readFile(join(directory, 'bots/chief.md'), 'utf8'), /offline-test-model/);
    const chiefPath = join(directory, 'bots/chief.md');
    await writeFile(
      chiefPath,
      (await readFile(chiefPath, 'utf8')).replace('name: Şef', 'name: External edit'),
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate('document.body.innerText.includes("External edit")')) break;
      await setTimeout(100);
    }
    assert.equal(await evaluate('document.body.innerText.includes("External edit")'), true);
    const status = await evaluate('window.api.engines.status()');
    assert.equal(status.claude.state, 'unverified');
    assert.equal(status.codex.state, 'unverified');
    const saved = await evaluate(
      'window.api.settings.set({engines:{claude:{authMode:"api-key",apiKey:"offline-check-sentinel"}}})',
    );
    assert.equal(saved.engines.claude.hasApiKey, true);
    assert.equal(JSON.stringify(saved).includes('offline-check-sentinel'), false);
    assert.equal(
      (await readFile(join(directory, 'secrets.json'), 'utf8')).includes('offline-check-sentinel'),
      false,
    );
    const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    window.webContents.reload();
    await reloaded;
    assert.equal((await evaluate('window.api.bots.get("chief")')).model, 'offline-test-model');
    assert.equal((await evaluate('window.api.engines.status()')).claude.state, 'configured');
    process.stdout.write(
      'Desktop check passed: sandbox, preload IPC, Chief protection, persisted engine/model, external edits, safeStorage. No engine run.\n',
    );
    app.quit();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Desktop check failed'}\n`);
    app.exit(1);
  }
}
void check();
