// Explicit integration regression: real OpenClaw + loopback mock, no WeChat or cloud calls.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { init, paths, atomicWrite, load } from '../src/config.mjs';
import { runOC, start, stop, processStatus } from '../src/runtime.mjs';
import { createDesktopService } from '../src/desktop-service.mjs';
import { updateMemory } from '../src/memory.mjs';

const base = process.env.COMPANION_TEST_ROOT || os.tmpdir();
await fs.mkdir(base, { recursive: true });
const home = await fs.mkdtemp(path.join(base, 'role-restart-smoke-'));
const requests = [];
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw); requests.push(body);
  res.setHeader('Content-Type', 'text/event-stream');
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'role-regression', object: 'chat.completion.chunk', created: 1, model: 'mock-chat', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.end(chunk({ role: 'assistant', content: '测试回复。' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const portProbe = http.createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const gatewayPort = portProbe.address().port; await new Promise(r => portProbe.close(r));
process.env.COMPANION_API_KEY = 'loopback-role-regression-only';
try {
  const c = await init(home);
  c.mode = 'api'; c.gatewayPort = gatewayPort;
  c.api = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'mock-chat', keyEnv: 'COMPANION_API_KEY', contextWindow: 32768, maxTokens: 128, timeoutMs: 60000, temperature: 0.65 };
  await atomicWrite(paths(home).config, c);
  const chat = async message => runOC(home, await load(home), ['agent', ...((await processStatus(home)).running ? [] : ['--local']), '--agent', 'companion', '--session-id', 'role-regression', '--message', message, '--thinking', 'off', '--json'], { capture: true, timeoutMs: 120000 });
  await chat('old-session-marker-9031');
  await start(home, c);
  const service = await createDesktopService(home);
  for (let i = 1; i <= 4; i++) {
    await service.savePersona({ name: `小晴${i}`, soul: `你是小晴${i}。角色标记 persona-marker-${i}。`, user: `用户资料标记 profile-marker-${i}。` });
    assert.equal((await processStatus(home)).running, true);
    const current = await load(home);
    assert.equal((await fetch(`http://127.0.0.1:${current.gatewayPort}/healthz`)).ok, true);
    await chat(`new-session-marker-${i}`);
    const messages = JSON.stringify(requests.at(-1).messages);
    assert.equal(requests.at(-1).temperature, 0.65);
    assert.match(messages, new RegExp(`persona-marker-${i}`));
    assert.match(messages, new RegExp(`profile-marker-${i}`));
    assert.doesNotMatch(messages, /old-session-marker-9031/);
    if (i > 1) assert.doesNotMatch(messages, new RegExp(`new-session-marker-${i - 1}`));
    console.log(`PASS save role ${i} with populated SQLite, Gateway healthy, new persona loaded, previous conversation excluded`);
  }
  await stop(home);
  await updateMemory(home, 'remember', 'memory-regression-marker');
  await start(home, await load(home));
  assert.equal((await processStatus(home)).running, true);
  console.log('PASS memory update with populated SQLite restarts cleanly');
  await stop(home);
  const db = new DatabaseSync(path.join(paths(home).state, 'state', 'openclaw.sqlite'), { readOnly: true });
  try {
    const boots = db.prepare('SELECT outcome, completed_at_ms, startup_reason FROM gateway_boot_lifecycle').all();
    assert.ok(boots.length >= 6);
    assert.ok(boots.every(boot => boot.outcome === 'clean_stop' && boot.completed_at_ms !== null));
    assert.ok(boots.every(boot => boot.startup_reason !== 'gateway.crash_loop_breaker'));
    console.log(`PASS ${boots.length} consecutive real Gateway boots stopped cleanly without crash-loop suppression`);
  } finally { db.close(); }
  console.log('PASS no real WeChat or external model requests; private test data: ' + home);
} finally {
  await stop(home).catch(() => {});
  mock.closeAllConnections(); await new Promise(r => mock.close(r));
  delete process.env.COMPANION_API_KEY;
}
