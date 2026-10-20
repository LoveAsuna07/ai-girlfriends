// Real pinned Tencent plugin + OpenClaw; both WeChat and model HTTP are loopback mocks.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import assert from 'node:assert/strict';
import { init, paths, atomicWrite } from '../src/config.mjs';
import { runOC, start, stop } from '../src/runtime.mjs';
if (!process.env.COMPANION_WECHAT_PACKAGE) throw new Error('Set COMPANION_WECHAT_PACKAGE to installed @tencent-weixin/openclaw-weixin 2.4.10 package directory.');
const base = process.env.COMPANION_TEST_ROOT || os.tmpdir(); await fs.mkdir(base, { recursive: true });
const home = await fs.mkdtemp(path.join(base, 'chat-native-'));
const owner = 'fixture-owner@im.wechat', accountId = 'fixture-bot', modelRequests = [], sent = [];
let release = false, deliveredInbound = false;
const message = (text, id) => ({ from_user_id: owner, to_user_id: accountId, message_id: id, message_type: 1, message_state: 2, context_token: 'loopback-context', create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text } }] });
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const data of req) raw += data;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url.includes('chat/completions')) {
    modelRequests.push(body);
    res.setHeader('Content-Type', 'text/event-stream');
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'pacing-test', object: 'chat.completion.chunk', created: 1, model: 'mock-chat', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(chunk({ role: 'assistant', content: '[[reply_to_current]]第一句\n第二句' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'); return;
  }
  let response = { ret: 0 };
  if (req.url.includes('getupdates')) {
    await new Promise(r => setTimeout(r, 100));
    const msgs = release && !deliveredInbound ? [message('merge-first-marker', 'first'), message('merge-second-marker', 'second')] : [];
    if (msgs.length) deliveredInbound = true;
    response = { ret: 0, msgs, get_updates_buf: 'loopback-buffer' };
  } else if (req.url.includes('sendmessage')) { sent.push(body); response.message_id = 'sent-' + sent.length; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${mock.address().port}`;
const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const gatewayPort = probe.address().port; await new Promise(r => probe.close(r));
process.env.COMPANION_API_KEY = 'loopback-pacing-only';
try {
  const c = await init(home); c.mode = 'api'; c.gatewayPort = gatewayPort;
  c.api = { baseUrl: origin + '/v1', model: 'mock-chat', keyEnv: 'COMPANION_API_KEY', contextWindow: 32768, maxTokens: 128, timeoutMs: 60000, temperature: 0.75 };
  c.chat = { debounceMs: 1800, splitReplies: true, maxBubbles: 3, delayMs: 100 };
  await atomicWrite(paths(home).config, c);
  await runOC(home, c, ['plugins', 'install', path.resolve(process.env.COMPANION_WECHAT_PACKAGE), '--link', '--accept-capabilities', '--force'], { capture: true });
  const root = path.join(paths(home).state, 'openclaw-weixin');
  await atomicWrite(path.join(root, 'accounts.json'), [accountId]);
  await atomicWrite(path.join(root, 'accounts', accountId + '.json'), { token: 'loopback-bot-only', userId: owner, baseUrl: origin });
  await start(home, c); release = true;
  const deadline = Date.now() + 90000;
  while (sent.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  assert.equal(modelRequests.length, 1, 'burst should trigger one model request');
  const content = JSON.stringify(modelRequests[0].messages);
  assert.match(content, /merge-first-marker/); assert.match(content, /merge-second-marker/);
  assert.equal(modelRequests[0].temperature, 0.75);
  assert.deepEqual(sent.map(x => x.msg?.item_list?.[0]?.text_item?.text), ['第一句', '第二句']);
  console.log('PASS real Tencent inbound merges both messages; one real OpenClaw model call; clean text sent as two bubbles via loopback WeChat API');
  console.log('Isolated test home: ' + home);
} finally { await stop(home).catch(() => {}); mock.closeAllConnections(); await new Promise(r => mock.close(r)); delete process.env.COMPANION_API_KEY; }
