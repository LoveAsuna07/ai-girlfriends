// Real Gateway + two loopback providers. No real cloud or WeChat requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { init, atomicWrite, paths, load } from '../src/config.mjs';
import { createDesktopService } from '../src/desktop-service.mjs';
import { runOC, stop } from '../src/runtime.mjs';
const base = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(base, { recursive: true });
const home = await fs.mkdtemp(path.join(base, 'api-profile-native-'));
const requests = [];
async function provider(label) {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push({ label, auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'text/event-stream');
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'profile-test', object: 'chat.completion.chunk', created: 1, model: label, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(chunk({ role: 'assistant', content: 'profile-reply-' + label }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); return server;
}
const a = await provider('A'), b = await provider('B');
const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
const url = server => `http://127.0.0.1:${server.address().port}/v1`;
const input = (server, model, extra) => ({ mode: 'api', api: { baseUrl: url(server), model, remember: true, ...extra } });
const oldKey = process.env.COMPANION_API_KEY;
try {
  const config = await init(home); config.gatewayPort = port; await atomicWrite(paths(home).config, config);
  const service = await createDesktopService(home, { vault: { encrypt: async text => Buffer.from(text).toString('base64'), decrypt: async text => Buffer.from(text, 'base64').toString() } });
  await service.applyModel(input(a, 'model-A', { key: 'loopback-A-only', name: 'A' })); const firstId = (await service.snapshot()).apiProfiles.activeId;
  await service.start();
  const chat = message => load(home).then(c => runOC(home, c, ['agent', '--agent', 'companion', '--session-id', 'shared-profile-session', '--message', message, '--thinking', 'off', '--json'], { capture: true, timeoutMs: 120000 }));
  await chat('first-profile-context-marker');
  assert.equal(requests.at(-1).label, 'A'); assert.equal(requests.at(-1).auth, 'Bearer loopback-A-only');
  await service.applyModel(input(b, 'model-B', { key: 'loopback-B-only', name: 'B', createProfile: true }));
  await chat('second-profile-context-marker');
  assert.equal(requests.at(-1).label, 'B'); assert.equal(requests.at(-1).body.model, 'model-B'); assert.equal(requests.at(-1).auth, 'Bearer loopback-B-only');
  assert.match(JSON.stringify(requests.at(-1).body.messages), /first-profile-context-marker/);
  await service.applyModel(input(a, 'model-A', { key: '', profileId: firstId }));
  await chat('third-profile-context-marker');
  assert.equal(requests.at(-1).label, 'A'); assert.equal(requests.at(-1).auth, 'Bearer loopback-A-only');
  assert.match(JSON.stringify(requests.at(-1).body.messages), /second-profile-context-marker/);
  console.log('PASS real Gateway A → B → A switches endpoint, model and key; shared conversation context survives');
} finally {
  await stop(home).catch(() => {});
  for (const server of [a, b]) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (oldKey === undefined) delete process.env.COMPANION_API_KEY; else process.env.COMPANION_API_KEY = oldKey;
}
