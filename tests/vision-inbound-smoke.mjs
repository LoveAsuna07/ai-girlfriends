// Real OpenClaw inbound preprocessing + local mock API. No WeChat account, no external model.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { init, paths, atomicWrite } from '../src/config.mjs';
import { prepare, childEnv, runtimeEntry } from '../src/runtime.mjs';
const base = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(base, { recursive: true });
const home = await fs.mkdtemp(path.join(base, 'vision-inbound-'));
const c = await init(home), requests = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9L8AAAAASUVORK5CYII=';
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw); requests.push(body);
  const content = body.model === 'vision-fixture' ? 'unique-vision-marker：红色圆形。' : '角色已根据图片描述回复。';
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(chunk({ role: 'assistant', content }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] })); }
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
process.env.COMPANION_VISION_TEST_KEY = 'loopback-fixture-only';
try {
  c.mode = 'api'; c.api = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: 'text-fixture', keyEnv: 'COMPANION_VISION_TEST_KEY', contextWindow: 32768, maxTokens: 256, timeoutMs: 60000 };
  c.vision = { enabled: true, localModel: 'qwen3.5:2b', apiModel: 'vision-fixture' };
  await atomicWrite(paths(home).config, c); await prepare(home, c);
  // Match Tencent's saveMediaBuffer root, not an arbitrary folder outside OpenClaw's media roots.
  const image = path.join(paths(home).state, 'media', 'inbound', 'fixture.png'); await fs.mkdir(path.dirname(image), { recursive: true }); await fs.writeFile(image, Buffer.from(png, 'base64'));
  const sdk = path.join(path.dirname(runtimeEntry(home)), 'dist', 'plugin-sdk');
  const worker = path.join(home, 'worker.mjs');
  const code = `import {pathToFileURL} from 'node:url';
const {loadConfig}=await import(pathToFileURL(${JSON.stringify(path.join(sdk, 'config-runtime.js'))}));
const {getReplyFromConfig,finalizeInboundContext}=await import(pathToFileURL(${JSON.stringify(path.join(sdk, 'reply-runtime.js'))}));
const ctx=finalizeInboundContext({Body:'请描述图片',From:'fixture-user',To:'fixture-user',AccountId:'fixture',Provider:'openclaw-weixin',OriginatingChannel:'openclaw-weixin',ChatType:'direct',SessionKey:'agent:companion:openclaw-weixin:fixture:direct:fixture-user',MediaPath:${JSON.stringify(image)},MediaType:'image/png',CommandAuthorized:true});
await getReplyFromConfig(ctx,{},loadConfig());process.exit(0);`;
  await fs.writeFile(worker, code);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], { env: childEnv(home, c), cwd: home, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('入站图片集成测试超时')); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`入站处理退出码 ${code}`)); });
  });
  assert.deepEqual(requests.map(x => x.model), ['vision-fixture', 'text-fixture']);
  assert.equal(requests[0].messages[0].content[1].image_url.url, `data:image/png;base64,${png}`);
  assert.match(JSON.stringify(requests[1].messages), /unique-vision-marker/);
  console.log('PASS real OpenClaw inbound image bytes → vision model → description in text-role request');
  console.log('PASS no real WeChat or cloud requests');
} finally { mock.closeAllConnections(); await new Promise(r => mock.close(r)); delete process.env.COMPANION_VISION_TEST_KEY; }
