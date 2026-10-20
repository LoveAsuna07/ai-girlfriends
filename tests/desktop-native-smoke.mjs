// Optional native Electron smoke: validates the real Windows secure vault and reopening.
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ROOT } from '../src/config.mjs';
const require = createRequire(import.meta.url), { _electron: electron } = require(process.env.COMPANION_PLAYWRIGHT || 'playwright');
const root = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(root, { recursive: true });
const home = await fs.mkdtemp(path.join(root, 'desktop-native-'));
const options = { executablePath: process.env.COMPANION_ELECTRON, args: process.env.COMPANION_PACKAGED === '1' ? [] : [ROOT], env: { ...process.env, COMPANION_HOME: home, COMPANION_NODE: process.execPath, COMPANION_API_KEY: '' }, timeout: 60000 };
if (process.env.COMPANION_PACKAGED === '1') delete options.env.COMPANION_NODE;
let app;
try {
  app = await electron.launch(options); let page = await app.firstWindow(); page.setDefaultTimeout(120000); await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: '今天，也在这里。' }).waitFor();
  console.log('PASS native Electron window and isolated renderer');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await new Promise((resolve, reject) => {
    const second = spawn(options.executablePath, options.args, { env: options.env, windowsHide: true, stdio: 'ignore' });
    second.once('error', reject); second.once('exit', code => code === 0 ? resolve() : reject(new Error('Second instance failed: ' + code)));
  });
  const deadline = Date.now() + 10000;
  while (!await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())) {
    if (Date.now() > deadline) throw new Error('Second launch did not restore hidden window');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log('PASS a second launch restores a hidden existing window');
  await page.locator('nav [data-page="models"]').click(); await page.locator('#choose-api').click();
  await page.locator('#api-url').fill('https://desktop-vault-fixture.test/v1'); await page.locator('#api-model').fill('fixture-no-network'); await page.locator('#api-key').fill('native-vault-fixture-not-real');
  assert.equal(await page.locator('#remember-key').isEnabled(), true); await page.locator('#remember-key').check();
  await page.locator('#save-model').click(); await page.getByText('模型设置已生效，人物与记忆已保留。', { exact: true }).waitFor();
  const cipher = await fs.readFile(path.join(home, 'desktop-key.enc.json'), 'utf8'); assert.doesNotMatch(cipher, /native-vault-fixture-not-real/);
  console.log('PASS real Windows encrypted key storage; no remote model request made');
  await app.close(); app = null;
  app = await electron.launch(options); page = await app.firstWindow(); page.setDefaultTimeout(60000); await page.waitForLoadState('networkidle');
  await page.locator('nav [data-page="models"]').click(); await page.locator('#api-key').waitFor();
  assert.equal(await page.locator('#api-key').getAttribute('placeholder'), '密钥已就绪，留空继续使用');
  assert.equal(await page.locator('#remember-key').isChecked(), true); console.log('PASS key restoration after actual desktop reopen');
} finally { if (app) await app.close(); }
