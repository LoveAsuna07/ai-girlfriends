// Optional integration check: real local Ollama + installed OpenClaw + loopback mock API.
// Run explicitly, never as part of npm test; may load an existing qwen3:8b model, never downloads it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { init, load, paths, atomicWrite, switchMode } from '../src/config.mjs';
import { runOC, start, stop } from '../src/runtime.mjs';
import { updateMemory } from '../src/memory.mjs';
import { testModel } from '../src/providers.mjs';

const root = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(root, { recursive: true });
const dir = await fs.mkdtemp(path.join(root, 'companion-integration-'));
let c = await init(dir); c.gatewayPort = 18893; await atomicWrite(paths(dir).config, c);
const requests = [];
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const d of req) raw += d;
  const b = JSON.parse(raw); requests.push({ url: req.url, auth: req.headers.authorization, body: b });
  res.setHeader('Content-Type', 'text/event-stream');
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'mock-chat', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.write(chunk({ role: 'assistant' })); res.write(chunk({ content: '已收到共用人物与记忆。' })); res.write(chunk({}, 'stop')); res.end('data: [DONE]\n\n');
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
process.env.COMPANION_SMOKE_KEY = 'loopback-fixture-only';
try {
  console.log('集成测试私有目录：' + dir);
  await runOC(dir, c, ['config', 'validate'], { capture: true }); console.log('PASS local OpenClaw config validate');
  const model = await testModel(c); console.log(`PASS actual Ollama ${model.model}, ${model.elapsedMs}ms, reply=${model.text}`);
  await updateMemory(dir, 'remember', '测试偏好：最喜欢的虚构饮品是桂花乌龙'); c = await load(dir);
  const begun = performance.now();
  const local = await runOC(dir, c, ['agent', '--local', '--agent', 'companion', '--session-id', 'integration-local', '--message', '请直接告诉我，我最喜欢的虚构饮品是什么？', '--thinking', 'off', '--json'], { capture: true, timeoutMs: 240000 });
  const localResult = JSON.parse(local.stdout); const localText = (localResult.payloads || []).map(p => p.text || '').join(''); assert.match(localText, /桂花|乌龙/); console.log(`PASS actual OpenClaw persona/memory, ${Math.round(performance.now()-begun)}ms, reply=${localText}`);
  c.api = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'mock-chat', keyEnv: 'COMPANION_SMOKE_KEY', contextWindow: 32768, maxTokens: 128, timeoutMs: 60000 }; await atomicWrite(paths(dir).config, c);
  c = await switchMode(dir, 'api', { probe: async (current, mode) => runOC(dir, { ...current, mode }, ['config', 'validate'], { capture: true }) }); console.log('PASS api OpenClaw config validate/switch');
  const result = await runOC(dir, c, ['agent', '--local', '--agent', 'companion', '--session-id', 'integration-api', '--message', '你好', '--thinking', 'off', '--json'], { capture: true, timeoutMs: 120000 });
  assert.match(result.stdout, /已收到共用人物与记忆/);
  assert.ok(requests.length > 0); assert.equal(requests[0].url, '/v1/chat/completions'); assert.equal(requests[0].auth, 'Bearer loopback-fixture-only'); assert.equal(requests[0].body.model, 'mock-chat'); assert.match(JSON.stringify(requests[0].body.messages), /桂花乌龙/); assert.match(JSON.stringify(requests[0].body.messages), /晚晴/); console.log(`PASS native OpenClaw → mock Chat Completions, ${requests.length} request(s), persona/memory/auth/model verified`);
  c = await switchMode(dir, 'local'); await start(dir, c); console.log('PASS hidden loopback Gateway start'); await stop(dir); console.log('PASS authenticated supervisor stop');
  console.log('真实云端 API 和微信扫码未测试。');
} finally { await stop(dir).catch(() => {}); mock.closeAllConnections(); await new Promise(r => mock.close(r)); delete process.env.COMPANION_SMOKE_KEY; }
