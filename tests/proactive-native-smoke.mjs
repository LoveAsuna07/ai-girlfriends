// Real Gateway generation + actual send RPC rejection. This fixture has NO WeChat account/plugin.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { init, paths, atomicWrite } from '../src/config.mjs';
import { start, stop, childEnv, runtimeEntry } from '../src/runtime.mjs';
import { commandRunner, createProactiveRunner } from '../src/proactive.mjs';
import { defaultProactive } from '../src/features.mjs';
const base = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(base, { recursive: true });
const home = await fs.mkdtemp(path.join(base, 'proactive-native-'));
let modelRequests = 0;
const mock = http.createServer(async (req, res) => { for await (const part of req) {} modelRequests++; res.setHeader('Content-Type', 'text/event-stream'); const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'proactive-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`; res.end(chunk({ role: 'assistant', content: '测试问候。' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); });
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const gatewayPort = probe.address().port; await new Promise(r => probe.close(r));
process.env.COMPANION_PROACTIVE_TEST_KEY = 'loopback-fixture-only';
try {
  const c = await init(home); c.mode = 'api'; c.gatewayPort = gatewayPort;
  c.api = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'fixture', keyEnv: 'COMPANION_PROACTIVE_TEST_KEY', contextWindow: 32768, maxTokens: 128, timeoutMs: 60000 };
  c.proactive = { ...defaultProactive, enabled: true }; await atomicWrite(paths(home).config, c);
  await start(home, c);
  let now = Date.parse('2026-10-19T06:00:00Z');
  const runner = createProactiveRunner({ home, command: commandRunner(home, runtimeEntry(home), childEnv(home, c)), ready: async () => true, now: () => now, getOwner: async () => ({ ready: true, accountId: 'fixture-no-account', userId: 'fixture@im.wechat', lastInboundAt: now - 180 * 60000, fingerprint: 'fixture-no-real-credentials' }) });
  await runner.tick();
  const state = JSON.parse(await fs.readFile(path.join(home, 'proactive-state.json'), 'utf8'));
  assert.equal(modelRequests, 1); assert.equal(state.blockedFingerprint, 'fixture-no-real-credentials'); assert.match(state.lastResult, /未能确认送达/);
  now += 180 * 60000; await runner.tick(); assert.equal(modelRequests, 1); runner.close();
  console.log('PASS real Gateway agent generation and send RPC; missing WeChat channel pauses delivery without retry');
  console.log('PASS fixture has no WeChat account; no actual outbound message sent');
} finally { await stop(home).catch(() => {}); mock.closeAllConnections(); await new Promise(r => mock.close(r)); delete process.env.COMPANION_PROACTIVE_TEST_KEY; }
