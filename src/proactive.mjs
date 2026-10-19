import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { load, paths, readJson, atomicWrite } from './config.mjs';
import { proactiveSettings } from './features.mjs';
import { verifyWechatOwner } from './runtime.mjs';
import { cleanReply } from './providers.mjs';

const stateFile = home => path.join(home, 'proactive-state.json');
export async function ownerContext(home) {
  if (!(await verifyWechatOwner(home)).restricted) return null;
  const root = path.join(paths(home).state, 'openclaw-weixin');
  const [accountId] = await readJson(path.join(root, 'accounts.json'));
  const account = await readJson(path.join(root, 'accounts', `${accountId}.json`));
  const file = path.join(root, 'accounts', `${accountId}.context-tokens.json`);
  let tokens, info;
  try { tokens = await readJson(file); info = await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') return { accountId, userId: account.userId, ready: false }; throw e; }
  const token = tokens[account.userId];
  if (typeof token !== 'string' || !token) return { accountId, userId: account.userId, ready: false };
  return { accountId, userId: account.userId, ready: true, lastInboundAt: info.mtimeMs, fingerprint: crypto.createHash('sha256').update(token + ':' + info.mtimeMs).digest('hex') };
}
function localTime(now, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
export function proactiveDecision(settings, state, owner, now) {
  const clock = localTime(now, settings.timeZone);
  if (!settings.enabled) return { reason: '已关闭主动联系', date: clock.date };
  if (!owner?.ready) return { reason: '请先在微信发一句话，建立可用会话', date: clock.date };
  const active = settings.start < settings.end ? clock.time >= settings.start && clock.time < settings.end : clock.time >= settings.start || clock.time < settings.end;
  if (!active) return { reason: '免打扰时段，不发送消息', date: clock.date };
  if (state.blockedFingerprint === owner.fingerprint) return { reason: '上次未能确认送达，等你在微信再说一句后恢复', date: clock.date };
  if (state.day === clock.date && (state.attempts || 0) >= settings.dailyLimit) return { reason: '今天已达到主动联系上限', date: clock.date };
  if (now < owner.lastInboundAt + settings.idleMinutes * 60000) return { reason: '你们刚聊过，暂时不打扰', date: clock.date };
  if (now < Math.max(state.nextAt || 0, (state.lastAttemptAt || 0) + settings.intervalMinutes * 60000)) return { reason: '等待下一次联系时间', date: clock.date };
  return { due: true, date: clock.date, reason: '可以主动联系' };
}
export async function proactiveStatus(home, c, now = Date.now()) {
  const state = await readJson(stateFile(home)).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
  const owner = await ownerContext(home).catch(() => null);
  const settings = proactiveSettings(c), decision = proactiveDecision(settings, state, owner, now);
  return { enabled: settings.enabled, reason: decision.reason, lastSentAt: state.lastSentAt || null, nextAt: state.nextAt || null, attemptsToday: state.day === decision.date ? state.attempts || 0 : 0, lastResult: state.lastResult || '', sessionReady: !!owner?.ready };
}
export function commandRunner(home, entry, env) {
  return (args, signal, timeoutMs = 180000) => new Promise((resolve, reject) => {
    let output = '', settled = false;
    const child = spawn(process.execPath, [entry, ...args], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { child.kill(); finish(new Error('主动联系已取消')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('主动联系请求超时')); }, timeoutMs);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { output += data; if (output.length > 2000000) abort(); });
    child.stderr.resume(); // Never persist third-party errors that could contain credentials.
    child.once('error', () => finish(new Error('无法运行主动联系服务')));
    child.once('close', code => { if (code !== 0) return finish(new Error('主动联系请求失败')); try { finish(null, JSON.parse(output)); } catch { finish(new Error('主动联系返回格式无效')); } });
  });
}
export function createProactiveRunner({ home, command, ready, now = Date.now, random = Math.random, getOwner = ownerContext }) {
  let busy = false, closed = false, controller;
  return {
    async tick() {
      if (closed || busy) return;
      busy = true; controller = new AbortController();
      try {
        const c = await load(home), settings = proactiveSettings(c);
        if (!settings.enabled || !await ready()) return;
        const owner = await getOwner(home);
        const state = await readJson(stateFile(home)).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
        const at = now(), decision = proactiveDecision(settings, state, owner, at);
        if (!decision.due) return;
        const attempt = crypto.randomUUID();
        Object.assign(state, { day: decision.date, attempts: state.day === decision.date ? (state.attempts || 0) + 1 : 1, lastAttemptAt: at, nextAt: at + settings.intervalMinutes * 60000 * (1 + random() * 0.15), lastResult: '正在准备主动问候', blockedFingerprint: owner.fingerprint });
        // Reserve before any network call: crashes and restarts never repeat an uncertain delivery.
        await atomicWrite(stateFile(home), state);
        try {
          const time = localTime(at, settings.timeZone);
          const prompt = `现在是 ${time.date} ${time.time}（${settings.timeZone}）。你要主动给用户发一条自然的微信问候。用户有一段时间没有发消息。沿用你的角色和已知偏好，最多两三句，不要编造用户正在做的事，不要索要回复或制造内疚。偏好：${settings.prompt}\n只输出准备发给用户的正文；此时不适合打扰就仅输出 SKIP。`;
          const response = await command(['agent', '--agent', 'companion', '--session-id', `proactive-${c.sessionEpoch}-${decision.date}`, '--message', prompt, '--thinking', 'off', '--json'], controller.signal);
          const result = response.result || response;
          const text = cleanReply((result.payloads || []).map(x => x.text || '').join('\n'));
          if (text.length > 600) throw new Error('主动问候过长');
          const latest = await load(home), currentOwner = await getOwner(home);
          const currentSettings = proactiveSettings(latest);
          const decisionNow = proactiveDecision(currentSettings, {}, currentOwner, now());
          if (closed || !currentSettings.enabled || JSON.stringify(currentSettings) !== JSON.stringify(settings) || latest.mode !== c.mode || latest.sessionEpoch !== c.sessionEpoch || currentOwner?.fingerprint !== owner.fingerprint || !decisionNow.due || /^SKIP[。.!]?$/i.test(text)) {
            state.lastResult = '已跳过：刚有新消息、设置变化或此刻不宜打扰'; delete state.blockedFingerprint;
          } else {
            const sessionKey = `agent:companion:openclaw-weixin:${owner.accountId.toLowerCase()}:direct:${owner.userId.toLowerCase()}`;
            await command(['gateway', 'call', 'send', '--json', '--timeout', '30000', '--params', JSON.stringify({ channel: 'openclaw-weixin', accountId: owner.accountId, to: owner.userId, message: text, agentId: 'companion', sessionKey, idempotencyKey: attempt })], controller.signal, 45000);
            state.lastSentAt = now(); state.lastResult = '最近一条主动问候已送达'; delete state.blockedFingerprint;
          }
        } catch { state.lastResult = '未能确认送达，暂停主动消息；请在微信再发一句话后恢复'; }
        await atomicWrite(stateFile(home), state);
      } catch { /* An invalid or temporarily unavailable state must never trigger a send. */ }
      finally { busy = false; }
    },
    close() { closed = true; controller?.abort(); }
  };
}
