import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { init, atomicWrite, paths, load, openclawConfig, ROOT } from '../src/config.mjs';
import { defaultProactive, validateFeatures } from '../src/features.mjs';
import { proactiveDecision, createProactiveRunner, ownerContext } from '../src/proactive.mjs';
import { normalizeImage, testVision } from '../src/providers.mjs';
import { createDesktopService } from '../src/desktop-service.mjs';

const at = Date.parse('2026-10-19T06:00:00Z'); // 14:00 Taipei
const settings = { ...defaultProactive, enabled: true };
const owner = { accountId: 'fixture-im-bot', userId: 'fixture@im.wechat', ready: true, lastInboundAt: at - 180 * 60000, fingerprint: 'fixture-session' };
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(process.env.COMPANION_TEST_ROOT || os.tmpdir(), 'features-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const c = await init(home); c.proactive = settings; await atomicWrite(paths(home).config, c); return { home, c };
}
test('vision config keeps the text model and declares a separate image-capable model', async t => {
  const { home, c } = await fixture(t); c.vision = { enabled: true, localModel: 'qwen3.5:2b', apiModel: '' };
  const config = openclawConfig(c, home, 'fixture-token');
  assert.equal(config.agents.defaults.model.primary, 'ollama/qwen3:8b');
  assert.deepEqual(config.models.providers.ollama.models.map(m => m.input), [['text'], ['text', 'image']]);
  assert.equal(config.tools.media.models[0].type, 'cli'); assert.match(config.tools.media.models[0].args[0], /vision-cli\.mjs$/); assert.equal(config.tools.media.models[0].args[1], '{{AttachmentPath}}');
  assert.equal(config.tools.media.audio.enabled, false); assert.deepEqual(config.tools.deny, ['*']);
});
test('feature validation rejects malformed hours, zones and unreasonable message frequency', () => {
  for (const extra of [{ start: '25:00' }, { timeZone: 'not/a-zone' }, { dailyLimit: 99 }, { intervalMinutes: 1 }, { start: '09:00', end: '09:00' }]) assert.throws(() => validateFeatures({ proactive: { ...settings, ...extra } }));
});
test('quiet hours, recent conversation, daily limit and failed session suppress proactive sends', () => {
  assert.equal(proactiveDecision(settings, {}, owner, at).due, true);
  assert.match(proactiveDecision(settings, {}, owner, Date.parse('2026-10-19T15:00:00Z')).reason, /免打扰/);
  assert.match(proactiveDecision(settings, {}, { ...owner, lastInboundAt: at - 60000 }, at).reason, /刚聊过/);
  assert.match(proactiveDecision(settings, { day: '2026-10-19', attempts: 5 }, owner, at).reason, /上限/);
  assert.match(proactiveDecision(settings, { blockedFingerprint: owner.fingerprint }, owner, at).reason, /等你/);
  assert.match(proactiveDecision(settings, {}, null, at).reason, /微信发一句/);
});
test('cross-midnight active window and daily accounting use the selected timezone', () => {
  const evening = { ...settings, start: '22:00', end: '03:00' };
  assert.equal(proactiveDecision(evening, {}, owner, Date.parse('2026-10-19T17:00:00Z')).due, true);
  assert.equal(proactiveDecision(evening, {}, owner, Date.parse('2026-10-19T17:00:00Z')).date, '2026-10-20');
  assert.equal(proactiveDecision(evening, {}, owner, at).due, undefined);
});
test('proactive runner reserves its attempt before generation and prevents repeats after restart', async t => {
  const { home } = await fixture(t); const calls = [];
  const command = async args => { calls.push(args); const stored = JSON.parse(await fs.readFile(path.join(home, 'proactive-state.json'), 'utf8')); assert.equal(stored.attempts, 1); return args[0] === 'agent' ? { result: { payloads: [{ text: '想到你了，今天怎么样？' }] } } : { messageId: 'fixture-delivery' }; };
  const options = { home, command, ready: async () => true, now: () => at, random: () => 0, getOwner: async () => owner };
  await createProactiveRunner(options).tick(); await createProactiveRunner(options).tick();
  assert.equal(calls.length, 2);
  const params = JSON.parse(calls[1].at(-1)); assert.equal(params.to, owner.userId); assert.equal(params.accountId, owner.accountId); assert.ok(params.idempotencyKey);
  const state = await fs.readFile(path.join(home, 'proactive-state.json'), 'utf8'); assert.doesNotMatch(state, /fixture@im.wechat|fixture-session|想到你/); assert.equal(JSON.parse(state).lastSentAt, at);
});
test('uncertain delivery is never retried until a new inbound conversation arrives', async t => {
  const { home } = await fixture(t); let time = at, count = 0, currentOwner = owner;
  const runner = createProactiveRunner({ home, ready: async () => true, now: () => time, random: () => 0, getOwner: async () => currentOwner, command: async args => { count++; if (args[0] === 'agent') return { payloads: [{ text: '一条问候' }] }; throw new Error('delivery uncertain'); } });
  await runner.tick(); time += 180 * 60000; await runner.tick(); assert.equal(count, 2);
  currentOwner = { ...owner, fingerprint: 'fresh-session' }; await runner.tick(); assert.equal(count, 4);
});
test('new user message during generation cancels the pending proactive send', async t => {
  const { home } = await fixture(t); let currentOwner = owner; const calls = [];
  const runner = createProactiveRunner({ home, ready: async () => true, now: () => at, getOwner: async () => currentOwner, command: async args => { calls.push(args); currentOwner = { ...owner, fingerprint: 'new-message', lastInboundAt: at }; return { payloads: [{ text: '问候' }] }; } });
  await runner.tick(); assert.equal(calls.length, 1);
});
test('stopping the worker during generation prevents delivery', async t => {
  const { home } = await fixture(t); const calls = [];
  let runner; runner = createProactiveRunner({ home, ready: async () => true, now: () => at, getOwner: async () => owner, command: async args => { calls.push(args); runner.close(); return { payloads: [{ text: '问候' }] }; } });
  await runner.tick(); assert.equal(calls.length, 1);
});
test('owner context only uses the bound owner and never exposes the actual token', async t => {
  const { home } = await fixture(t), root = path.join(paths(home).state, 'openclaw-weixin'); await fs.mkdir(path.join(root, 'accounts'), { recursive: true });
  await atomicWrite(path.join(root, 'accounts.json'), [owner.accountId]);
  await atomicWrite(path.join(root, 'accounts', `${owner.accountId}.json`), { userId: owner.userId });
  await atomicWrite(path.join(root, 'accounts', `${owner.accountId}.context-tokens.json`), { other: 'unrelated-fixture-token' });
  assert.equal((await ownerContext(home)).ready, false);
  await atomicWrite(path.join(root, 'accounts', `${owner.accountId}.context-tokens.json`), { [owner.userId]: 'private-fixture-session-token' });
  const actual = await ownerContext(home); assert.equal(actual.ready, true); assert.doesNotMatch(JSON.stringify(actual), /private-fixture-session-token/);
});
test('text-only local model cannot be applied as an image model or stop an existing service', async t => {
  const { home, c } = await fixture(t); const events = [];
  const service = await createDesktopService(home, { hooks: { localModelInfo: async () => ({ capabilities: ['completion'] }), status: async () => ({ running: true }), stop: async () => events.push('stop') } });
  await assert.rejects(service.saveFeatures({ vision: { enabled: true, localModel: 'qwen3:8b', apiModel: '' }, proactive: c.proactive }), /不支持图片/);
  assert.deepEqual(events, []); assert.equal((await load(home)).vision, undefined);
});
test('image validation rejects fake types, oversized content and noncanonical base64', () => {
  assert.throws(() => normalizeImage({ base64: Buffer.from('not an image').toString('base64') }));
  assert.throws(() => normalizeImage({ base64: 'A'.repeat(13981020) }));
  assert.throws(() => normalizeImage({ base64: '<script>' }));
});
test('image preprocessor refuses an attachment outside its private instance directory', async t => {
  const { home } = await fixture(t);
  const other = await fs.mkdtemp(path.join(process.env.COMPANION_TEST_ROOT || os.tmpdir(), 'outside-image-'));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  const file = path.join(other, 'outside.png'); await fs.writeFile(file, Buffer.from('iVBORw0KGgo=', 'base64'));
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(ROOT, 'src', 'vision-cli.mjs'), file], { cwd: ROOT, env: { ...process.env, OPENCLAW_HOME: home } }), error => error.code === 1 && /图片未能识别/.test(error.stderr));
});
test('local and API image tests send actual bytes in the appropriate transport', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const data of req) raw += data; const body = JSON.parse(raw); requests.push({ path: req.url, body }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/api/show' ? { capabilities: ['vision'] } : req.url === '/api/chat' ? { message: { content: '本机图片描述' } } : { choices: [{ message: { content: 'API 图片描述' } }] })); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const { c } = await fixture(t), base = `http://127.0.0.1:${server.address().port}`;
  const image = { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9L8AAAAASUVORK5CYII=' };
  c.vision = { enabled: true, localModel: 'fixture-vision', apiModel: 'api-vision' }; c.local.baseUrl = base;
  assert.equal((await testVision(c, image)).reply, '本机图片描述'); assert.equal(requests[1].body.messages[0].images[0], image.base64);
  c.mode = 'api'; c.api = { baseUrl: base, model: 'text-chat', keyEnv: 'COMPANION_IMAGE_TEST_KEY', contextWindow: 32768, maxTokens: 128, timeoutMs: 1000 };
  process.env.COMPANION_IMAGE_TEST_KEY = 'loopback-fixture-only'; t.after(() => { delete process.env.COMPANION_IMAGE_TEST_KEY; });
  assert.equal((await testVision(c, image)).reply, 'API 图片描述'); assert.match(requests[2].body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/); assert.equal(requests[2].body.model, 'api-vision');
});
