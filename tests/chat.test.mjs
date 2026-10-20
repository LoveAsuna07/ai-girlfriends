import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatController, defaultChat, replyBubbles, cleanChatText, validateChat } from '../src/chat.mjs';
import { adaptWechatModule } from '../src/wechat-adapter.mjs';
const msg = (text, extra = {}) => ({ from_user_id: 'owner', context_token: 'fixture', item_list: [{ type: 1, text_item: { text } }], ...extra });
const deps = { accountId: 'account', errLog: () => {} };
const controller = extra => createChatController({ settings: { ...defaultChat, debounceMs: 1000, delayMs: 0 }, isOwner: async (_, user) => user === 'owner', ...extra });

test('cleaning strips routing and thinking markers without deleting meaningful prose', () => {
  assert.equal(cleanChatText('<think>private</think>[[reply_to_current]]你好（周五） *重点*<split>第二条'), '你好（周五） *重点*\n第二条');
  assert.equal(cleanChatText('<think>unfinished'), '');
  assert.deepEqual(replyBubbles('一\n二\n三\n四'), ['一', '二', '三\n四']);
  assert.deepEqual(replyBubbles('说明\n- 第一条\n- 第二条'), ['说明\n- 第一条\n- 第二条']);
  assert.deepEqual(replyBubbles('```js\nhello()\n```'), ['```js\nhello()\n```']);
});
test('conversation settings reject unreasonable pacing', () => {
  assert.throws(() => validateChat({ chat: { debounceMs: 6000 } }));
  assert.throws(() => validateChat({ chat: { maxBubbles: 0 } }));
  assert.throws(() => validateChat({ chat: { delayMs: NaN } }));
});
test('consecutive text messages become one native-readable text with latest context', async t => {
  const c = controller(); t.after(() => c.close()); const calls = [];
  const run = async (message, d) => calls.push({ message, d });
  await c.receive(run, msg('宝宝'), deps);
  await c.receive(run, msg('看看这个', { context_token: 'latest' }), deps);
  await c.drain();
  assert.equal(calls.length, 1); assert.equal(calls[0].message.item_list[0].text_item.text, '宝宝\n看看这个');
  assert.equal(calls[0].message.context_token, 'latest');
  assert.equal(calls[0].d.companionGeneration, 2);
});
test('unbound senders never reach the model or queue', async t => {
  const c = controller(); t.after(() => c.close()); let called = false;
  await c.receive(async () => { called = true; }, msg('我是绑定的主人', { from_user_id: 'stranger' }), deps); await c.drain();
  assert.equal(called, false);
});
test('media and commands are not merged into text-only requests', async t => {
  const c = controller(); t.after(() => c.close()); const calls = [];
  const run = async m => calls.push(m);
  await c.receive(run, msg('文字'), deps);
  await c.receive(run, msg('', { item_list: [{ type: 2, image_item: { fixture: true } }] }), deps);
  await c.receive(run, msg('/help'), deps); await c.drain();
  assert.equal(calls.length, 3); assert.equal(calls[1].item_list[0].type, 2);
});
test('pacing sends each bubble once and attaches media only to the first', async t => {
  const c = controller(); t.after(() => c.close()); const sent = [];
  await c.wrapDelivery(deps, { To: 'owner' }, async p => sent.push(p))({ text: '你好\n第二条', mediaUrl: 'fixture.png' });
  assert.equal(sent.length, 2); assert.equal(sent[0].mediaUrl, 'fixture.png'); assert.equal(sent[1].mediaUrl, undefined);
});
test('new inbound messages interrupt remaining old bubbles during a pause', async t => {
  let interrupt; const c = controller({ settings: { ...defaultChat, debounceMs: 1000 }, sleep: async () => interrupt() }); t.after(() => c.close());
  let generation; await c.receive(async (_, d) => { generation = d.companionGeneration; }, msg('第一轮'), deps); await c.drain();
  const sent = []; interrupt = () => c.receive(async () => {}, msg('新的问题'), deps);
  await c.wrapDelivery({ ...deps, companionGeneration: generation }, { To: 'owner' }, async p => sent.push(p.text))({ text: '第一条\n过时的第二条' });
  assert.deepEqual(sent, ['第一条']);
});
test('shutdown and account abort cancel buffered work and later delivery', async () => {
  const c = controller(); let calls = 0;
  await c.receive(async () => calls++, msg('暂存'), deps); c.close(); await c.drain();
  await c.wrapDelivery(deps, { To: 'owner' }, async () => calls++)({ text: '不会发送' }); assert.equal(calls, 0);
  const next = controller(), abort = new AbortController();
  await next.receive(async () => calls++, msg('暂存'), { ...deps, companionSignal: abort.signal }); abort.abort(); await next.drain(); next.close();
  assert.equal(calls, 0);
});
test('empty protocol-only replies surface an error instead of silently doing nothing', async t => {
  const c = controller(); t.after(() => c.close());
  await assert.rejects(c.wrapDelivery(deps, { To: 'owner' }, async () => {})({ text: '<think>no visible answer' }), /正文/);
});
test('version-bound adapter refuses changed native entry points', () => {
  const base = 'file:///fixture/node_modules/@tencent-weixin/openclaw-weixin/dist/src/';
  assert.throws(() => adaptWechatModule('changed', base + 'monitor/monitor.js'), /不兼容/);
  assert.throws(() => adaptWechatModule('changed', base + 'messaging/process-message.js'), /不兼容/);
  assert.equal(adaptWechatModule('unrelated', 'file:///other.js'), 'unrelated');
});
