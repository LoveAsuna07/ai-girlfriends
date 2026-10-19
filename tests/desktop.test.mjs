import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopService } from '../src/desktop-service.mjs';
import { serveDesktop } from '../src/desktop-server.mjs';
import { paths, load } from '../src/config.mjs';

async function fixture(t, options = {}) {
  const base = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(base, { recursive: true });
  const home = await fs.mkdtemp(path.join(base, 'desktop-test-'));
  const oldKey = process.env.COMPANION_API_KEY; delete process.env.COMPANION_API_KEY;
  let running = false; const events = [];
  const hooks = { status: async () => ({ running }), start: async (_h, c) => { events.push('start:' + c.mode); running = true; }, stop: async () => { events.push('stop'); running = false; }, localModels: async () => ['qwen3:8b', 'qwen3.5:2b'], installRuntime: async () => {}, runOC: async () => ({}), testModel: async () => ({ text: '你好', elapsedMs: 120 }), ...options.hooks };
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); if (oldKey === undefined) delete process.env.COMPANION_API_KEY; else process.env.COMPANION_API_KEY = oldKey; });
  return { home, hooks, events, setRunning: value => { running = value; } };
}
const api = (extra = {}) => ({ mode: 'api', api: { baseUrl: 'https://provider.test/v1', model: 'test-chat', key: 'desktop-fixture-not-a-real-key', remember: false, ...extra } });

test('desktop HTTP requires session token and rejects cross-origin requests', async t => {
  const f = await fixture(t), app = await serveDesktop({ home: f.home, hooks: f.hooks }); t.after(app.close);
  assert.equal((await fetch(app.origin + '/api/state')).status, 401);
  assert.equal((await fetch(app.origin + '/api/state', { headers: { 'X-Companion-Token': app.token, Origin: 'https://outsider.test' } })).status, 403);
  assert.equal((await fetch(app.origin + '/workspace/USER.md')).status, 404);
  const state = await fetch(app.origin + '/api/state', { headers: { 'X-Companion-Token': app.token } }).then(r => r.json());
  assert.equal(state.local.model, 'qwen3:8b'); assert.equal(state.gateway.running, false);
  const response = await fetch(app.origin + '/api/start', { method: 'POST', headers: { 'X-Companion-Token': app.token, 'Content-Type': 'text/plain' }, body: '{}' }); assert.equal(response.status, 415);
});
test('desktop model apply preserves memory and restarts an existing instance', async t => {
  const f = await fixture(t), service = await createDesktopService(f.home, { hooks: f.hooks });
  await fs.writeFile(path.join(paths(f.home).workspace, 'MEMORY.md'), '喜欢桂花乌龙'); f.setRunning(true);
  await service.applyModel({ mode: 'local', model: 'qwen3.5:2b' });
  assert.deepEqual(f.events, ['stop', 'start:local']); assert.equal((await load(f.home)).local.model, 'qwen3.5:2b');
  assert.equal(await fs.readFile(path.join(paths(f.home).workspace, 'MEMORY.md'), 'utf8'), '喜欢桂花乌龙');
});
test('desktop invalid target schema never stops current service or overwrites current config', async t => {
  const f = await fixture(t, { hooks: { runOC: async () => { throw new Error('target schema rejected'); } } }), service = await createDesktopService(f.home, { hooks: f.hooks }); f.setRunning(true);
  const before = await fs.readFile(paths(f.home).config);
  await assert.rejects(service.applyModel({ mode: 'local', model: 'qwen3.5:2b' }), /schema rejected/);
  assert.deepEqual(f.events, []); assert.deepEqual(await fs.readFile(paths(f.home).config), before);
});
test('desktop restart failure restores old mode and restarts original instance', async t => {
  const f = await fixture(t); const hookStart = f.hooks.start;
  f.hooks.start = async (home, c) => { if (c.local.model === 'qwen3.5:2b') throw new Error('new startup failed'); return hookStart(home, c); };
  const service = await createDesktopService(f.home, { hooks: f.hooks }); f.setRunning(true);
  await assert.rejects(service.applyModel({ mode: 'local', model: 'qwen3.5:2b' }), /new startup failed/);
  assert.equal((await load(f.home)).local.model, 'qwen3:8b'); assert.equal((await service.snapshot()).gateway.running, true);
});
test('desktop role changes archive SQLite state, rename role consistently and preserve durable memory', async t => {
  const f = await fixture(t), service = await createDesktopService(f.home, { hooks: f.hooks });
  const agent = path.join(paths(f.home).state, 'agents', 'companion', 'agent'); await fs.mkdir(agent, { recursive: true }); await fs.writeFile(path.join(agent, 'openclaw-agent.sqlite'), 'old fixture');
  await fs.writeFile(path.join(paths(f.home).workspace, 'MEMORY.md'), '已确认偏好');
  await service.savePersona({ name: '小晴', soul: '# 晚晴\n你是晚晴，说话简短。', user: '称呼：小宁' });
  const snapshot = await service.snapshot(); assert.equal(snapshot.persona.name, '小晴'); assert.match(snapshot.persona.soul, /你是小晴/); assert.equal((await load(f.home)).roleName, '小晴');
  assert.equal(await fs.readFile(path.join(paths(f.home).workspace, 'MEMORY.md'), 'utf8'), '已确认偏好');
  assert.equal(await fs.access(agent).then(() => true, () => false), false); assert.equal((await fs.readdir(path.join(f.home, 'excluded-history'))).length, 1);
});
test('desktop rejects invalid role fields before modifying persona', async t => {
  const f = await fixture(t), service = await createDesktopService(f.home, { hooks: f.hooks }), before = (await service.snapshot()).persona;
  await assert.rejects(service.savePersona({ name: '', soul: 'a', user: '' }), /角色名/);
  assert.deepEqual((await service.snapshot()).persona, before);
});
test('desktop API secrets are never returned in state and provider changes require new key', async t => {
  const f = await fixture(t), service = await createDesktopService(f.home, { hooks: f.hooks });
  await service.applyModel(api());
  const snapshot = await service.snapshot(); assert.equal(snapshot.mode, 'api'); assert.equal(snapshot.credentials.present, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /desktop-fixture-not-a-real-key/);
  await assert.rejects(service.applyModel(api({ baseUrl: 'https://other.test/v1', key: '' })), /重新输入/);
  assert.equal((await load(f.home)).api.baseUrl, 'https://provider.test/v1');
});
test('desktop role save requires the API key before stopping an already-running API instance', async t => {
  const f = await fixture(t), service = await createDesktopService(f.home, { hooks: f.hooks });
  await service.applyModel(api()); delete process.env.COMPANION_API_KEY; f.setRunning(true);
  const before = (await service.snapshot()).persona;
  await assert.rejects(service.savePersona({ name: '小晴', soul: '温柔的角色', user: '' }), /COMPANION_API_KEY/);
  assert.deepEqual(f.events, []); assert.deepEqual((await service.snapshot()).persona, before);
});
test('desktop encrypted vault persists ciphertext only and restores key through system vault', async t => {
  const f = await fixture(t);
  const vault = { encrypt: async value => Buffer.from('protected:' + value).toString('base64'), decrypt: async value => Buffer.from(value, 'base64').toString().slice(10) };
  const service = await createDesktopService(f.home, { hooks: f.hooks, vault }); await service.applyModel(api({ remember: true }));
  const encrypted = await fs.readFile(path.join(f.home, 'desktop-key.enc.json'), 'utf8'); assert.doesNotMatch(encrypted, /desktop-fixture-not-a-real-key/);
  delete process.env.COMPANION_API_KEY;
  const reopened = await createDesktopService(f.home, { hooks: f.hooks, vault }); assert.equal((await reopened.snapshot()).credentials.present, true);
});
test('desktop exclusive operations reject simultaneous mutations', async t => {
  let release; const barrier = new Promise(r => { release = r; });
  const f = await fixture(t, { hooks: { start: async () => barrier } }), service = await createDesktopService(f.home, { hooks: f.hooks });
  const pending = service.start();
  await new Promise(r => setTimeout(r, 30));
  await assert.rejects(service.stop(), /上一项操作/); release(); await pending;
});
