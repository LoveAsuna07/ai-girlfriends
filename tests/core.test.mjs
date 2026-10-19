import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { init, paths, load, atomicWrite, switchMode, openclawConfig, validateConfig, validateEndpoint, ROOT } from '../src/config.mjs';
import { testModel, cleanReply } from '../src/providers.mjs';
import { memories, updateMemory } from '../src/memory.mjs';
import { childEnv, redact, verifyWechatOwner } from '../src/runtime.mjs';
import { releaseCheck } from '../src/release.mjs';

async function temp(t) { const root = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(root, { recursive: true }); const dir = await fs.mkdtemp(path.join(root, 'companion-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function server(t, handler) { const s = http.createServer(handler); await new Promise(r => s.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { s.closeAllConnections(); s.close(r); })); return `http://127.0.0.1:${s.address().port}`; }
function apiConfig(baseUrl) { return { version: 1, mode: 'api', gatewayPort: 18791, api: { baseUrl, model: 'custom-chat', keyEnv: 'TEST_COMPANION_KEY', contextWindow: 32768, maxTokens: 128, timeoutMs: 1500 } }; }
const fakeEnv = { TEST_COMPANION_KEY: 'fixture-secret-value' };
async function body(req) { let text = ''; for await (const part of req) text += part; return JSON.parse(text); }

test('init defaults to qwen3:8b and preserves edited persona/config on reinitialization', async t => {
  const dir = await temp(t); const c = await init(dir); assert.equal(c.local.model, 'qwen3:8b');
  const persona = path.join(paths(dir).workspace, 'SOUL.md'); await fs.writeFile(persona, '用户自定义角色');
  c.local.maxTokens = 77; await atomicWrite(paths(dir).config, c); await init(dir);
  assert.equal(await fs.readFile(persona, 'utf8'), '用户自定义角色'); assert.equal((await load(dir)).local.maxTokens, 77);
});
test('init rejects private state inside source tree', async () => { await assert.rejects(init(path.join(ROOT, 'state')), /源码目录之外/); });
test('failed switch preserves byte-identical config and persona', async t => {
  const dir = await temp(t); await init(dir); const before = await fs.readFile(paths(dir).config);
  await assert.rejects(switchMode(dir, 'api', { env: fakeEnv }), /model ID/);
  assert.deepEqual(await fs.readFile(paths(dir).config), before);
  await assert.rejects(switchMode(dir, 'local', { probe: () => { throw new Error('bad schema'); } }), /bad schema/);
  assert.deepEqual(await fs.readFile(paths(dir).config), before);
});
test('successful local/api/local switch uses one workspace and preserves memory', async t => {
  const dir = await temp(t); const c = await init(dir); c.api = apiConfig('http://127.0.0.1:12345/v1').api; await atomicWrite(paths(dir).config, c);
  await updateMemory(dir, 'remember', '喜欢先听一句安慰，再讨论建议'); const original = await fs.readFile(path.join(paths(dir).workspace, 'MEMORY.md'));
  const api = await switchMode(dir, 'api', { env: fakeEnv }); assert.ok(api.apiConsentAt);
  assert.equal(openclawConfig(api, dir, 'fixture').agents.defaults.workspace, paths(dir).workspace);
  await switchMode(dir, 'local'); assert.deepEqual(await fs.readFile(path.join(paths(dir).workspace, 'MEMORY.md')), original);
});
test('local requests native Ollama only and never reads API secret', async t => {
  const requests = [];
  const endpoint = await server(t, async (req, res) => { requests.push(req.url); assert.equal(req.headers.authorization, undefined); res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    assert.equal(req.url, '/api/chat'); const b = await body(req); assert.equal(b.model, 'qwen3:8b'); assert.equal(b.think, false); assert.equal(b.options.num_ctx, 8192); res.end(JSON.stringify({ message: { content: '<think>私有思考</think>你好呀' } })); });
  const dir = await temp(t); const c = await init(dir); c.local.baseUrl = endpoint;
  c.api = apiConfig('https://never-contact.example.net/v1').api;
  const env = new Proxy({}, { get() { throw new Error('读取了云密钥'); } });
  const reply = await testModel(c, { env }); assert.equal(reply.text, '你好呀'); assert.deepEqual(requests, ['/api/tags', '/api/chat']);
});
test('missing local model does not generate or fall back', async t => {
  let requests = 0; const endpoint = await server(t, (req, res) => { requests++; res.end(JSON.stringify({ models: [] })); });
  const c = await init(await temp(t)); c.local.baseUrl = endpoint; await assert.rejects(testModel(c), /不会自动下载/); assert.equal(requests, 1);
});
test('API forwards custom URL/model/auth/Chinese messages and parses reply', async t => {
  const endpoint = await server(t, async (req, res) => { assert.equal(req.url, '/custom/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer fixture-secret-value'); const b = await body(req); assert.equal(b.model, 'custom-chat'); assert.equal(b.messages[0].content, '你好，晚晴'); assert.equal(b.stream, false); res.end(JSON.stringify({ choices: [{ message: { content: '我在这里。' } }] })); });
  const r = await testModel(apiConfig(endpoint + '/custom/v1'), { env: fakeEnv, prompt: '你好，晚晴' }); assert.equal(r.text, '我在这里。');
});
for (const status of [401, 403, 429, 500, 503]) test(`API HTTP ${status} is bounded, sanitized, no retries`, async t => {
  let count = 0; const endpoint = await server(t, (req, res) => { count++; res.writeHead(status).end('secret error details fixture-secret-value'); });
  await assert.rejects(testModel(apiConfig(endpoint), { env: fakeEnv }), e => e.message.includes(String(status)) && !e.message.includes('fixture-secret-value'));
  assert.equal(count, 1);
});
for (const [label, value, pattern] of [['malformed JSON', 'not-json', /无效 JSON/], ['wrong structure', '{}', /结构/], ['empty reply', '{"choices":[{"message":{"content":" "}}]}', /空回复/]]) test(`API ${label}`, async t => {
  const endpoint = await server(t, (req, res) => res.end(value)); await assert.rejects(testModel(apiConfig(endpoint), { env: fakeEnv }), pattern);
});
test('API request timeout', async t => { const endpoint = await server(t, () => {}); const c = apiConfig(endpoint); c.api.timeoutMs = 100; await assert.rejects(testModel(c, { env: fakeEnv }), /超时/); });
test('API response body timeout is not reported as malformed JSON', async t => { const endpoint = await server(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }); const c = apiConfig(endpoint); c.api.timeoutMs = 100; await assert.rejects(testModel(c, { env: fakeEnv }), /响应体读取超时/); });
test('redirects are rejected rather than leaking auth', async t => { let targetHits = 0; const target = await server(t, (req, res) => { targetHits++; res.end('{}'); }); const source = await server(t, (req, res) => res.writeHead(302, { Location: target }).end()); await assert.rejects(testModel(apiConfig(source), { env: fakeEnv }), /无法连接/); assert.equal(targetHits, 0); });
test('API config rejects non-HTTPS remote, embedded credentials, example URL/key, malformed limits', () => {
  for (const url of ['http://remote.test/v1', 'https://user:pass@remote.test/v1', 'https://replace.example/v1', 'https://remote.test/v1?token=abc']) assert.throws(() => validateEndpoint(url));
  assert.throws(() => validateConfig(apiConfig('https://provider.test/v1'), 'api', { TEST_COMPANION_KEY: 'API_KEY' }, true), /示例密钥/);
  const c = apiConfig('https://provider.test/v1'); c.api.maxTokens = 50000; assert.throws(() => validateConfig(c), /maxTokens/);
});
test('local endpoint is loopback only and cloud tag is rejected', async t => { const c = await init(await temp(t)); c.local.baseUrl = 'https://remote.test'; assert.throws(() => validateConfig(c), /loopback/); c.local.baseUrl = 'http://127.0.0.1:11434'; c.local.model = 'qwen:cloud'; assert.throws(() => validateConfig(c), /云模型/); });
test('OpenClaw model isolation, disabled tools/embeddings/fallbacks, plugin settings preserved', async t => {
  const dir = await temp(t), c = await init(dir); c.api = apiConfig('https://remote.test').api;
  const oc = openclawConfig(c, dir, 'fixture', { channels: { sample: {} }, plugins: { allow: ['openclaw-weixin'] } });
  assert.deepEqual(Object.keys(oc.models.providers), ['ollama']); assert.deepEqual(oc.agents.defaults.model.fallbacks, []); assert.deepEqual(oc.tools.deny, ['*']); assert.equal(oc.plugins.slots.memory, 'none'); assert.equal(oc.gateway.bind, 'loopback'); assert.deepEqual(oc.plugins.allow, ['openclaw-weixin']);
  const previous = process.env.CLOUD_FIXTURE_API_KEY; process.env.CLOUD_FIXTURE_API_KEY = 'do-not-inherit';
  try { assert.equal(childEnv(dir, c).CLOUD_FIXTURE_API_KEY, undefined); assert.equal(childEnv(dir, c).OPENCLAW_SKIP_CHANNELS, undefined); } finally { if (previous === undefined) delete process.env.CLOUD_FIXTURE_API_KEY; else process.env.CLOUD_FIXTURE_API_KEY = previous; }
});
test('memory correct/forget update durable facts and rotate old transcripts out of active state', async t => {
  const dir = await temp(t); await init(dir); const list = await updateMemory(dir, 'remember', '喜欢红茶'); const epoch = (await load(dir)).sessionEpoch;
  const agent = path.join(paths(dir).state, 'agents', 'companion', 'agent'); await fs.mkdir(agent, { recursive: true }); await fs.writeFile(path.join(agent, 'openclaw-agent.sqlite'), 'fixture transcript and index 喜欢红茶');
  const sessions = path.join(paths(dir).state, 'agents', 'companion', 'sessions'); await fs.mkdir(sessions, { recursive: true }); await fs.writeFile(path.join(sessions, 'old.jsonl'), '喜欢红茶');
  await updateMemory(dir, 'correct', list[0].id, '喜欢乌龙茶'); assert.notEqual((await load(dir)).sessionEpoch, epoch); assert.equal((await memories(dir))[0].text, '喜欢乌龙茶');
  await assert.rejects(fs.access(agent)); const archives = await fs.readdir(path.join(dir, 'excluded-history')); assert.equal(archives.length, 1); assert.match(await fs.readFile(path.join(dir, 'excluded-history', archives[0], 'agent', 'openclaw-agent.sqlite'), 'utf8'), /喜欢红茶/);
  await updateMemory(dir, 'forget', list[0].id); assert.deepEqual(await memories(dir), []); assert.doesNotMatch(await fs.readFile(path.join(paths(dir).workspace, 'MEMORY.md'), 'utf8'), /乌龙茶|红茶/);
  await assert.rejects(updateMemory(dir, 'forget', 'missing'), /未找到/);
});
test('redaction removes configured secret and Bearer/token diagnostic values', () => { const c = apiConfig('https://provider.test'); process.env.TEST_COMPANION_KEY = 'fixture-secret-value'; try { const result = redact('fixture-secret-value Bearer aabbcc {"token":"sensitive"}', c); assert.doesNotMatch(result, /fixture-secret-value|aabbcc|sensitive/); } finally { delete process.env.TEST_COMPANION_KEY; } });
test('thinking-only output is rejected', () => { assert.throws(() => cleanReply('<think>内部</think>'), /空回复/); assert.throws(() => cleanReply('<think>内部'), /思考/); });
test('WeChat startup gate refuses legacy empty owner, additional senders and multiple accounts', async t => {
  const dir = await temp(t); await init(dir); const root = path.join(paths(dir).state, 'openclaw-weixin'); await fs.mkdir(path.join(root, 'accounts'), { recursive: true });
  await atomicWrite(path.join(root, 'accounts.json'), ['fixture-im-bot']); await atomicWrite(path.join(root, 'accounts', 'fixture-im-bot.json'), { token: 'fixture' });
  await assert.rejects(verifyWechatOwner(dir), /缺少扫码所有者/);
  await atomicWrite(path.join(root, 'accounts', 'fixture-im-bot.json'), { userId: 'owner@im.wechat', token: 'fixture' }); assert.equal((await verifyWechatOwner(dir)).restricted, true);
  await atomicWrite(path.join(paths(dir).state, 'credentials', 'openclaw-weixin-fixture-im-bot-allowFrom.json'), { allowFrom: ['someone-else@im.wechat'] }); await assert.rejects(verifyWechatOwner(dir), /非扫码所有者/);
  await atomicWrite(path.join(root, 'accounts.json'), ['fixture-im-bot', 'other-im-bot']); await assert.rejects(verifyWechatOwner(dir), /只允许一个/);
});
test('release manifest rejects unknown files and credential artifacts, accepts companion.ps1', async t => {
  const dir = await temp(t); await fs.mkdir(path.join(dir, 'scripts')); await fs.writeFile(path.join(dir, 'scripts', 'companion.ps1'), 'node cli'); const result = await releaseCheck(dir); assert.equal(result.length, 1); assert.equal(result[0].sha256.length, 64);
  await fs.writeFile(path.join(dir, 'private.json'), '{}'); await assert.rejects(releaseCheck(dir), /未审查/); await fs.rm(path.join(dir, 'private.json')); await fs.writeFile(path.join(dir, 'scripts', 'auth-profiles.json'), '{}'); await assert.rejects(releaseCheck(dir), /私有数据/);
});
test('extracted source manifest is verified and tampering is rejected', async t => {
  const dir = await temp(t); await fs.writeFile(path.join(dir, 'README.md'), '说明');
  const files = await releaseCheck(dir); await atomicWrite(path.join(dir, 'SOURCE-MANIFEST.json'), { generatedAt: new Date().toISOString(), files });
  assert.equal((await releaseCheck(dir)).length, 1); await fs.writeFile(path.join(dir, 'README.md'), '被修改的说明'); await assert.rejects(releaseCheck(dir), /源码清单校验失败/);
});
