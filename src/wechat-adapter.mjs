// Adapter for the pinned Tencent 2.4.10 runtime. Package files are never modified.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load, paths, readJson, WECHAT_VERSION } from './config.mjs';
import { chatSettings, createChatController } from './chat.mjs';

export const CHAT_CONTROL = Symbol.for('local-companion.chat');
export function adaptWechatModule(source, url) {
  if (!url.includes('/@tencent-weixin/openclaw-weixin/dist/src/')) return source;
  if (url.endsWith('/monitor/monitor.js')) {
    const marker = 'await processOneMessage(full, {';
    if (source.split(marker).length !== 2) throw new Error('微信入站适配与当前插件不兼容，请使用固定版本 2.4.10。');
    return source.replace(marker, 'await globalThis[Symbol.for("local-companion.chat")].receive(processOneMessage, full, { companionSignal: abortSignal,');
  }
  if (url.endsWith('/messaging/process-message.js')) {
    const start = 'deliver: async (payload) => {';
    const end = /\},(\s+)onError: \(err, info\) => \{/g;
    if (source.split(start).length !== 2 || [...source.matchAll(end)].length !== 1) throw new Error('微信发送适配与当前插件不兼容，请使用固定版本 2.4.10。');
    return source.replace(start, 'deliver: globalThis[Symbol.for("local-companion.chat")].wrapDelivery(deps, ctx, async (payload) => {')
      .replace(end, '}),$1onError: (err, info) => {');
  }
  return source;
}
export async function installWechatAdapter(home) {
  const c = await load(home);
  const controller = createChatController({ settings: chatSettings(c), isOwner: async (accountId, sender) => {
    if (typeof accountId !== 'string' || !/^[a-zA-Z0-9_@.-]+$/.test(accountId)) return false;
    const root = path.join(paths(home).state, 'openclaw-weixin');
    const ids = await readJson(path.join(root, 'accounts.json')).catch(() => []);
    if (ids.length !== 1 || ids[0] !== accountId) return false;
    const account = await readJson(path.join(root, 'accounts', `${accountId}.json`)).catch(() => ({}));
    return typeof sender === 'string' && sender.endsWith('@im.wechat') && sender === account.userId;
  } });
  globalThis[CHAT_CONTROL] = controller;
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.includes('/@tencent-weixin/openclaw-weixin/dist/src/') || !/\/(monitor\/monitor|messaging\/process-message)\.js$/.test(url)) return result;
    // Both targets live at dist/src/<area>/<file>; resolve from the containing directory.
    const manifest = JSON.parse(readFileSync(new URL('../../../package.json', url), 'utf8'));
    if (manifest.version !== WECHAT_VERSION) throw new Error(`微信聊天适配仅支持插件 ${WECHAT_VERSION}。`);
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    return { ...result, source: adaptWechatModule(source, url) };
  } });
  return controller;
}
