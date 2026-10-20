// Browser flow with isolated state and stubbed runtime; no cloud or WeChat calls.
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { serveDesktop } from '../src/desktop-server.mjs';
import { load } from '../src/config.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.COMPANION_PLAYWRIGHT || 'playwright');
const base = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(base, { recursive: true });
const home = await fs.mkdtemp(path.join(base, 'chat-ui-'));
const app = await serveDesktop({ home, hooks: {
  status: async () => ({ running: false }), runOC: async () => ({}),
  localModels: async () => ['qwen3:8b', 'qwen3.5:9b'], localVisionModels: async () => [],
  installRuntime: async () => {}
} });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
const errors = []; page.on('pageerror', e => errors.push(e.message));
async function click(id, route) {
  const response = page.waitForResponse(r => r.url() === app.origin + '/api/' + route && r.request().method() === 'POST');
  await page.locator('#' + id).click(); const r = await response; const body = await r.json(); assert.equal(r.ok(), true, body.error);
  await page.locator('body').evaluate(el => new Promise(resolve => { const check = () => el.classList.contains('busy') ? setTimeout(check, 50) : resolve(); check(); }));
}
try {
  await page.goto(`${app.origin}/#session=${app.token}`); await page.waitForLoadState('networkidle');
  assert.equal(await page.title(), 'AI 陪伴 · Companion');
  await page.locator('nav [data-page="models"]').click();
  await page.locator('#local-model').selectOption('qwen3.5:9b');
  await page.locator('#local-fields details summary').click();
  await page.locator('#local-temperature').fill('0.65'); await page.locator('#local-max').fill('384'); await click('save-model', 'model');
  await page.locator('#choose-api').click();
  await page.locator('#api-url').fill('https://fixture-provider.test/v1'); await page.locator('#api-model').fill('fixture-chat'); await page.locator('#api-key').fill('ui-fixture-only');
  await page.locator('#api-fields details summary').click(); await page.locator('#api-temperature').fill('0.8'); await click('save-model', 'model');
  const firstProfile = (await app.service.snapshot()).apiProfiles.activeId;
  await page.locator('#new-api-profile').click();
  await page.locator('#api-profile-name').fill('备用接口'); await page.locator('#api-url').fill('https://backup-fixture.test/v1');
  await page.locator('#api-model').fill('backup-chat'); await page.locator('#api-key').fill('backup-ui-fixture'); await click('save-model', 'model');
  const secondProfile = (await app.service.snapshot()).apiProfiles.activeId;
  assert.notEqual(firstProfile, secondProfile);
  await page.locator('#api-profile').selectOption(firstProfile);
  assert.equal(await page.locator('#api-key').inputValue(), '');
  assert.equal(await page.locator('#api-url').inputValue(), 'https://fixture-provider.test/v1');
  await page.locator('#api-profile-name').fill('主接口');
  await click('save-model', 'model');
  assert.equal(process.env.COMPANION_API_KEY, 'ui-fixture-only');
  assert.equal((await app.service.snapshot()).apiProfiles.items.find(p => p.id === firstProfile).name, '主接口');
  if (process.env.COMPANION_PROFILE_PREVIEW) {
    await page.locator('#dismiss-toast').click(); await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: process.env.COMPANION_PROFILE_PREVIEW, fullPage: true });
  }
  await page.locator('#api-profile').selectOption(secondProfile); await click('delete-api-profile', 'profile-delete');
  assert.equal((await app.service.snapshot()).apiProfiles.items.length, 1);
  console.log('PASS saved API selection, key-free switch-back and inactive profile deletion');
  await page.locator('#choose-local').click(); await click('save-model', 'model');
  let c = await load(home); assert.equal(c.local.temperature, 0.65); assert.equal(c.local.maxTokens, 384); assert.equal(c.api.temperature, 0.8);
  await page.locator('nav [data-page="together"]').click();
  await page.locator('#chat-debounce').fill('1.2'); await page.locator('#chat-delay').fill('0.6'); await click('save-features', 'features');
  c = await load(home); assert.equal(c.chat.debounceMs, 1200); assert.equal(c.chat.delayMs, 600);
  await page.reload(); await page.goto(`${app.origin}/#session=${app.token}`); await page.waitForLoadState('networkidle');
  await page.locator('nav [data-page="together"]').click(); assert.equal(await page.locator('#chat-debounce').inputValue(), '1.2');
  assert.deepEqual(errors, []);
  if (process.env.COMPANION_PREVIEW) await page.screenshot({ path: process.env.COMPANION_PREVIEW, fullPage: true });
  console.log('PASS UI brand, independent local/API parameters, chat pacing save and reload; no browser errors');
} finally { await browser.close(); await app.close(); delete process.env.COMPANION_API_KEY; }
