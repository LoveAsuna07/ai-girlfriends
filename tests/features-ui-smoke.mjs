// Explicit UI integration; real OpenClaw and Ollama metadata, loopback API, no WeChat sends.
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { init, load, paths, atomicWrite } from '../src/config.mjs';
import { serveDesktop } from '../src/desktop-server.mjs';
import { stop } from '../src/runtime.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.COMPANION_PLAYWRIGHT || 'playwright');
const base = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(base, { recursive: true });
const home = await fs.mkdtemp(path.join(base, 'features-ui-'));
const portProbe = http.createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r)); const gatewayPort = portProbe.address().port; await new Promise(r => portProbe.close(r));
const c = await init(home); c.gatewayPort = gatewayPort; await atomicWrite(paths(home).config, c);
const requests = [];
const mock = http.createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; requests.push(JSON.parse(raw)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '图片测试：蓝色方块与红色圆形。' } }] })); });
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const app = await serveDesktop({ home });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); page.setDefaultTimeout(180000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
async function click(id, route) { const wait = page.waitForResponse(r => r.url() === `${app.origin}/api/${route}` && r.request().method() === 'POST', { timeout: 240000 }); await page.locator('#' + id).click(); const r = await wait, result = await r.json(); assert.equal(r.ok(), true, result.error); return result; }
try {
  await page.goto(`${app.origin}/#session=${app.token}`); await page.waitForLoadState('networkidle');
  await page.locator('nav [data-page="together"]').click();
  await page.locator('#vision-enabled').check(); await page.locator('#vision-local-model').selectOption('qwen3.5:2b');
  await page.locator('#proactive-enabled').check(); await page.locator('#proactive-limit').fill('5'); await page.locator('#proactive-idle').fill('120');
  await click('save-features', 'features');
  assert.equal((await load(home)).vision.enabled, true); assert.equal((await load(home)).proactive.dailyLimit, 5);
  console.log('PASS new feature page, local image capability selection and persisted contact settings');
  if (process.env.COMPANION_PREVIEW) await page.screenshot({ path: process.env.COMPANION_PREVIEW, fullPage: true });
  await page.locator('nav [data-page="home"]').click(); await click('start-button', 'start');
  await page.locator('nav [data-page="together"]').click(); await page.locator('#proactive-interval').fill('150'); await click('save-features', 'features');
  assert.equal((await app.service.snapshot()).gateway.ready, true); console.log('PASS saving features restarts real Gateway and remains ready');
  await page.locator('nav [data-page="models"]').click(); await page.locator('#choose-api').click();
  await page.locator('#api-url').fill(`http://127.0.0.1:${mock.address().port}/v1`); await page.locator('#api-model').fill('fixture-text'); await page.locator('#api-key').fill('loopback-ui-fixture'); await click('save-model', 'model');
  await page.locator('nav [data-page="together"]').click(); await page.locator('#vision-api-model').fill('fixture-vision'); await click('save-features', 'features');
  await page.locator('#vision-file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9L8AAAAASUVORK5CYII=', 'base64') });
  await click('test-vision', 'vision-test'); await page.locator('#vision-result').filter({ hasText: '蓝色方块' }).waitFor();
  assert.equal(requests.length, 1); assert.equal(requests[0].model, 'fixture-vision'); assert.match(requests[0].messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  console.log('PASS image file upload UI and actual image bytes to configured mock API');
  assert.deepEqual(errors, []); console.log('PASS no browser JavaScript errors; no actual WeChat or cloud calls');
} finally { await stop(home).catch(() => {}); await browser.close(); await app.close(); mock.closeAllConnections(); await new Promise(r => mock.close(r)); }
