import { promises as fs, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import { paths, exists, atomicWrite, readJson, openclawConfig, OC_VERSION, WECHAT_VERSION, validateConfig, ROOT } from './config.mjs';

export function runtimeEntry(home) { return path.join(process.env.COMPANION_RUNTIME || paths(home).runtime, 'node_modules', 'openclaw', 'openclaw.mjs'); }
export async function prepare(home, c) {
  const p = paths(home); let previous = {};
  if (await exists(p.oc)) previous = await readJson(p.oc);
  const tokenFile = path.join(home, 'gateway-token');
  if (!await exists(tokenFile)) await atomicWrite(tokenFile, crypto.randomBytes(32).toString('hex'));
  const token = (await fs.readFile(tokenFile, 'utf8')).trim();
  await fs.mkdir(path.join(home, 'tmp'), { recursive: true });
  await atomicWrite(p.oc, openclawConfig(c, home, token, previous));
  return p;
}
export function childEnv(home, c) {
  // Local children never inherit common cloud credentials. Only explicit API mode gets its configured key.
  const result = {};
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i;
  for (const [key, value] of Object.entries(process.env)) if (keep.test(key)) result[key] = value;
  if (c.mode === 'api' && process.env[c.api.keyEnv]) result[c.api.keyEnv] = process.env[c.api.keyEnv];
  return { ...result, USERPROFILE: home, TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), OPENCLAW_STATE_DIR: paths(home).state, OPENCLAW_CONFIG_PATH: paths(home).oc, OPENCLAW_HOME: home, OPENCLAW_NO_RESPAWN: '1' };
}
export function redact(text, c) {
  let safe = String(text);
  if (c.mode === 'api' && process.env[c.api.keyEnv]) safe = safe.split(process.env[c.api.keyEnv]).join('[已隐藏密钥]');
  return safe.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').replace(/("(?:token|apiKey|botToken|access_token)"\s*:\s*")[^"]+/gi, '$1[已隐藏]');
}
export async function runOC(home, c, args, { capture = false, timeoutMs = 240000 } = {}) {
  const entry = runtimeEntry(home); if (!await exists(entry)) throw new Error('未安装本项目 OpenClaw；请运行 install-runtime。');
  await prepare(home, c);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: childEnv(home, c), cwd: home, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d; }); child.stderr?.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('OpenClaw 命令超时；请查看私有日志。')); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`OpenClaw 命令失败（退出码 ${code}）。${capture ? '\n' + redact((stderr || stdout).slice(-2500), c) : ''}`)); else resolve({ stdout, stderr }); });
  });
}
export async function installRuntime(home) {
  const dir = paths(home).runtime; await fs.mkdir(dir, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(ROOT, 'templates', 'runtime', file), path.join(dir, file));
  const npmCli = process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : null;
  return new Promise((resolve, reject) => {
    const args = ['ci', '--prefix', dir, '--cache', path.join(home, 'npm-cache'), '--no-audit', '--no-fund'];
    const child = spawn(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args, { windowsHide: true, stdio: 'inherit' });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`隔离安装失败（${code}）；保留源码可重试。`)));
  });
}
export async function processStatus(home) {
  const p = paths(home); if (!await exists(p.pid)) return { running: false };
  const record = await readJson(p.pid);
  if (record.home !== home || !Number.isInteger(record.controlPort) || !record.controlToken) return { running: false, stale: true, uncertain: true };
  try {
    const response = await fetch(`http://127.0.0.1:${record.controlPort}/status`, { headers: { Authorization: `Bearer ${record.controlToken}` }, signal: AbortSignal.timeout(1500) });
    const current = await response.json();
    if (response.ok && current.supervisorId === record.supervisorId) return { ...record, running: current.running, stopping: !!current.stopping };
  } catch {}
  try { process.kill(record.supervisorPid, 0); return { running: false, uncertain: true }; } catch { return { running: false, stale: true }; }
}
async function portFree(port) {
  await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', () => reject(new Error(`本机端口 ${port} 已被占用；未启动或停止其他服务。`))); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
}
export async function gatewayReadiness(home, c) {
  try {
    const token = (await fs.readFile(path.join(home, 'gateway-token'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${c.gatewayPort}/readyz`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(1500) });
    const result = await response.json();
    const suppressed = Array.isArray(result.suppressed) && result.suppressed.includes('openclaw-weixin');
    const wechatFailed = Array.isArray(result.failing) && result.failing.includes('openclaw-weixin');
    return { ready: response.ok && result.ready === true && !suppressed, suppressed, wechatFailed };
  } catch { return { ready: false, suppressed: false, wechatFailed: false }; }
}
export async function start(home, c) {
  validateConfig(c, c.mode, process.env, true);
  const status = await processStatus(home);
  if (status.running || status.uncertain) throw new Error('本项目 Gateway 已在运行或控制状态不明；请先检查 status。');
  await verifyWechatOwner(home); await portFree(c.gatewayPort); await prepare(home, c);
  const entry = runtimeEntry(home); if (!await exists(entry)) throw new Error('请先运行 install-runtime。');
  const logDir = path.join(home, 'logs'); await fs.mkdir(logDir, { recursive: true });
  const out = openSync(path.join(logDir, 'gateway.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'supervisor.mjs'), home, entry, String(c.gatewayPort)], { env: childEnv(home, c), cwd: home, windowsHide: true, detached: true, stdio: ['ignore', out, out] }); closeSync(out);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  const readyDeadline = Date.now() + 90000;
  for (let attempt = 0; Date.now() < readyDeadline; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    const current = await processStatus(home);
    if (attempt > 5 && !current.running) throw new Error('Gateway 提前退出；查看私有 logs/gateway.log。');
    const readiness = await gatewayReadiness(home, c);
    if (readiness.suppressed) throw new Error('微信连接已被异常重启保护暂停。请停止陪伴，等待 5 分钟后重新启动；若再次出现，请检查私有日志。');
    if (readiness.ready) return;
  }
  throw new Error('Gateway 尚未就绪；已保留本项目进程记录，请检查 status 与私有日志。');
}
export async function stop(home) {
  const s = await processStatus(home);
  if (s.uncertain) throw new Error('无法联系本项目监督器；未按 PID 终止任何进程。请检查私有日志与任务管理器。');
  if (!s.running) { await fs.rm(paths(home).pid, { force: true }); return false; }
  if (s.home !== home || s.entry !== runtimeEntry(home)) throw new Error('进程归属记录不匹配，拒绝停止。');
  const r = await fetch(`http://127.0.0.1:${s.controlPort}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${s.controlToken}` }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('监督器未确认停止；未终止其他进程。');
  for (let i = 0; i < 350; i++) { if (!await exists(paths(home).pid)) return true; await new Promise(r => setTimeout(r, 200)); }
  throw new Error('停止尚未完成，请检查 status。');
}
export async function requireStopped(home) { const s = await processStatus(home); if (s.running || s.uncertain) throw new Error('请先 stop 并确认进程停止，再更改模型或记忆，随后 start；运行中配置未修改。'); }
export async function setupWechat(home, c) {
  await requireStopped(home);
  await runOC(home, c, ['plugins', 'install', `@tencent-weixin/openclaw-weixin@${WECHAT_VERSION}`, '--accept-capabilities', '--pin'], { timeoutMs: 600000 });
  await runOC(home, c, ['plugins', 'enable', 'openclaw-weixin', '--accept-capabilities']);
}
export async function verifyWechatOwner(home) {
  const root = path.join(paths(home).state, 'openclaw-weixin');
  const index = path.join(root, 'accounts.json');
  if (!await exists(index)) return { accounts: 0, restricted: false };
  const ids = await readJson(index);
  if (!Array.isArray(ids) || ids.length > 1) throw new Error('此陪伴实例只允许一个微信账户；请使用原生 channels logout 清理多余账户。');
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_@.-]+$/.test(id)) throw new Error('微信账户索引无效。');
    const account = await readJson(path.join(root, 'accounts', `${id}.json`));
    if (typeof account.userId !== 'string' || !account.userId.endsWith('@im.wechat')) throw new Error('微信账户缺少扫码所有者 userId；旧版空允许名单可能接受所有人，请重新本人扫码，未启动 Gateway。');
    const safeId = id.trim().toLowerCase().replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_');
    const allowFile = path.join(paths(home).state, 'credentials', `openclaw-weixin-${safeId}-allowFrom.json`);
    if (await exists(allowFile)) { const allow = (await readJson(allowFile)).allowFrom; if (!Array.isArray(allow) || allow.some(x => x !== account.userId)) throw new Error('微信允许名单含非扫码所有者；请只保留自己的 userId，未启动 Gateway。'); }
  }
  return { accounts: ids.length, restricted: ids.length === 1 };
}
