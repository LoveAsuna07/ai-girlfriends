// Explicit real-integration UI test; requires Playwright, Chrome, installed OpenClaw and Ollama.
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { serveDesktop } from '../src/desktop-server.mjs';
import { paths, load } from '../src/config.mjs';
import { stop } from '../src/runtime.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.COMPANION_PLAYWRIGHT || 'playwright');
const base = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(base, { recursive: true });
const home = await fs.mkdtemp(path.join(base, 'desktop-ui-'));
const requests = [];
const mock = http.createServer(async (req, res) => { let raw = ''; for await (const p of req) raw += p; requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '你好，界面连接成功。' } }] })); });
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const app = await serveDesktop({ home });
const browser = await chromium.launch({ executablePath: process.env.COMPANION_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(120000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
async function clickAction(id, route) {
  const done = page.waitForResponse(r => r.url() === `${app.origin}/api/${route}` && r.request().method() === 'POST', { timeout: 240000 });
  await page.locator(`#${id}`).click(); const response = await done; const result = await response.json();
  assert.equal(response.ok(), true, result.error); return result;
}
try {
  await page.goto(`${app.origin}/#session=${app.token}`); await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { name: '今天，也在这里。' }).waitFor();
  console.log('PASS desktop initial render');
  if (process.env.COMPANION_PREVIEW) await page.screenshot({ path: process.env.COMPANION_PREVIEW, fullPage: true });
  // Derive the app icon from the native SVG mark, without adding image dependencies.
  const svg = await fs.readFile(new URL('../desktop/ui/mark.svg', import.meta.url), 'utf8');
  const iconPage = await browser.newPage({ viewport: { width: 256, height: 256 } }); await iconPage.setContent(svg.replace('viewBox=', 'width="256" height="256" viewBox='));
  await iconPage.locator('svg').screenshot({ path: new URL('../desktop/ui/icon.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), omitBackground: true }); await iconPage.close();
  await page.locator('nav [data-page="models"]').click();
  await page.locator('#local-model').selectOption('qwen3.5:2b'); await clickAction('save-model', 'model');
  assert.equal((await load(home)).local.model, 'qwen3.5:2b'); console.log('PASS real local model selection');
  await page.locator('nav [data-page="persona"]').click(); await page.locator('#role-name').fill('小晴'); await page.locator('#role-user').fill('虚构测试偏好：桂花乌龙。'); await clickAction('save-persona', 'persona');
  assert.match(await fs.readFile(path.join(paths(home).workspace, 'IDENTITY.md'), 'utf8'), /小晴/); console.log('PASS real role persistence');
  await page.locator('nav [data-page="home"]').click(); await clickAction('start-button', 'start'); await page.getByText('陪伴正在运行', { exact: true }).first().waitFor(); console.log('PASS real one-click Gateway start');
  await page.locator('nav [data-page="models"]').click(); await page.locator('#choose-api').click();
  await page.locator('#api-url').fill(`http://127.0.0.1:${mock.address().port}/v1`); await page.locator('#api-model').fill('mock-desktop-chat'); await page.locator('#api-key').fill('desktop-ui-fixture-key');
  await clickAction('save-model', 'model');
  assert.equal((await load(home)).mode, 'api'); assert.match(await fs.readFile(path.join(paths(home).workspace, 'USER.md'), 'utf8'), /桂花乌龙/); console.log('PASS API apply with running Gateway restart');
  await clickAction('test-model', 'test'); await page.getByText('你好，界面连接成功。', { exact: false }).waitFor();
  assert.equal(requests.length, 1); assert.equal(requests[0].path, '/v1/chat/completions'); assert.equal(requests[0].auth, 'Bearer desktop-ui-fixture-key'); console.log('PASS UI API test and correct credentials');
  await page.locator('#choose-local').click(); await page.locator('#local-model').selectOption('qwen3:8b'); await clickAction('save-model', 'model');
  assert.equal((await load(home)).mode, 'local'); console.log('PASS switch back local and retain role');
  await page.locator('nav [data-page="home"]').click(); await clickAction('stop-button', 'stop'); await page.getByText('陪伴尚未启动', { exact: true }).waitFor(); console.log('PASS real UI stop');
  assert.deepEqual(errors, []); console.log('PASS no browser JS errors');
} finally { await stop(home).catch(() => {}); await browser.close(); await app.close(); mock.closeAllConnections(); await new Promise(r => mock.close(r)); }
