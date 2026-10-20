import { setTimeout as delay } from 'node:timers/promises';

export const defaultChat = { debounceMs: 1800, splitReplies: true, maxBubbles: 3, delayMs: 1000 };
export function chatSettings(c) { return { ...defaultChat, ...c.chat }; }
export function validateChat(c) {
  const s = chatSettings(c);
  for (const [key, min, max] of [['debounceMs', 0, 5000], ['maxBubbles', 1, 4], ['delayMs', 0, 3000]]) {
    if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw new Error('聊天节奏参数超出允许范围。');
  }
  if (typeof s.splitReplies !== 'boolean') throw new Error('分条回复开关无效。');
  return s;
}
export function cleanChatText(text) {
  // Strip protocol markers only. Parentheses, Markdown emphasis and ordinary prose are valid content.
  return String(text ?? '').replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .replace(/\[\[?reply_to_(?:current|[^\]\s]+)\]?\]/gi, '')
    .replace(/<split\s*\/>|<split>/gi, '\n').trim();
}
export function replyBubbles(text, settings = defaultChat) {
  const clean = cleanChatText(text);
  if (!clean) return [];
  if (!settings.splitReplies || /```|^\s*(?:[-*]|\d+[.)])\s/m.test(clean)) return [clean];
  const parts = clean.split(/\n\s*\n|\n/).map(x => x.trim()).filter(Boolean);
  // Do not chop arbitrary sentences or truncate explanations to satisfy a bubble count.
  if (parts.length <= settings.maxBubbles) return parts;
  return [...parts.slice(0, settings.maxBubbles - 1), parts.slice(settings.maxBubbles - 1).join('\n')];
}
const keyOf = (account, user) => JSON.stringify([account, user]);
const plain = message => message.item_list?.length > 0 && message.item_list.every(x => x.type === 1 && typeof x.text_item?.text === 'string')
  && !message.item_list.some(x => /^\s*\//.test(x.text_item.text) || x.ref_msg) && !message.ref_msg;

export function createChatController({ settings = defaultChat, isOwner, sleep = delay, now = Date.now }) {
  const sessions = new Map();
  let closed = false;
  function session(key) {
    if (!sessions.has(key)) sessions.set(key, { version: 0, pending: null, chain: Promise.resolve(), abort: new AbortController() });
    return sessions.get(key);
  }
  function flush(s) {
    const pending = s.pending;
    if (!pending) return;
    clearTimeout(pending.timer); s.pending = null;
    s.chain = s.chain.then(async () => {
      if (closed || pending.deps.companionSignal?.aborted) return;
      await pending.run(pending.message, { ...pending.deps, companionGeneration: pending.version });
    }).catch(() => pending.deps.errLog?.('陪伴消息处理失败，请检查模型连接与私有日志；未自动重发。'));
  }
  return {
    async receive(run, message, deps) {
      if (closed || deps.companionSignal?.aborted || !await isOwner(deps.accountId, message.from_user_id)) return;
      const s = session(keyOf(deps.accountId, message.from_user_id));
      s.version++;
      s.abort.abort(); s.abort = new AbortController();
      const merge = settings.debounceMs > 0 && plain(message);
      const length = m => (m.item_list || []).reduce((n, x) => n + (x.text_item?.text?.length || 0), 0);
      if (s.pending && (!merge || !plain(s.pending.message) || s.pending.message.item_list.length + message.item_list.length > 12 || length(s.pending.message) + length(message) > 6000)) flush(s);
      if (s.pending) {
        clearTimeout(s.pending.timer);
        const text = [...s.pending.message.item_list, ...message.item_list].map(x => x.text_item.text).join('\n');
        s.pending.message = { ...message, item_list: [{ ...message.item_list[0], text_item: { ...message.item_list[0].text_item, text } }] };
        s.pending.version = s.version;
        s.pending.deps = deps;
      } else s.pending = { run, message: structuredClone(message), deps, version: s.version, firstAt: now() };
      const wait = merge ? Math.max(0, Math.min(settings.debounceMs, 6000 - (now() - s.pending.firstAt))) : 0;
      if (!wait) flush(s);
      else s.pending.timer = setTimeout(() => flush(s), wait);
      if (deps.companionSignal && !s.boundSignals?.has(deps.companionSignal)) {
        s.boundSignals ||= new WeakSet(); s.boundSignals.add(deps.companionSignal);
        deps.companionSignal.addEventListener('abort', () => { clearTimeout(s.pending?.timer); s.pending = null; s.abort.abort(); }, { once: true });
      }
    },
    wrapDelivery(deps, ctx, deliver) {
      return async payload => {
        const s = session(keyOf(deps.accountId, ctx.To));
        const valid = () => !closed && !deps.companionSignal?.aborted && (deps.companionGeneration === undefined || deps.companionGeneration === s.version);
        const media = payload.mediaUrl || payload.mediaUrls?.length;
        const bubbles = replyBubbles(payload.text, settings);
        if (!bubbles.length && media && valid()) return deliver({ ...payload, text: '' });
        if (!bubbles.length && valid()) throw new Error('模型没有返回可发送的正文，请检查模型连接。');
        for (let i = 0; i < bubbles.length; i++) {
          if (!valid()) return;
          if (i && settings.delayMs) {
            try { await sleep(settings.delayMs, undefined, { signal: s.abort.signal }); } catch { return; }
          }
          if (!valid()) return;
          await deliver({ ...payload, text: bubbles[i], ...(i ? { mediaUrl: undefined, mediaUrls: undefined } : {}) });
        }
      };
    },
    close() { closed = true; for (const s of sessions.values()) { clearTimeout(s.pending?.timer); s.pending = null; s.abort.abort(); } },
    async drain() { for (const s of sessions.values()) flush(s); await Promise.all([...sessions.values()].map(s => s.chain)); }
  };
}
