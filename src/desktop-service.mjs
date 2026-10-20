import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { init, load, paths, atomicWrite, readJson, validateConfig, validateEndpoint } from './config.mjs';
import { prepare, runtimeEntry, runOC, start, stop, processStatus, installRuntime, verifyWechatOwner, gatewayReadiness } from './runtime.mjs';
import { localModels, testModel, localModelInfo, localVisionModels, testVision } from './providers.mjs';
import { archiveRoleState } from './role-state.mjs';
import { visionSettings, proactiveSettings, validateFeatures } from './features.mjs';
import { proactiveStatus } from './proactive.mjs';
import { chatSettings } from './chat.mjs';
import { profilesPath, readProfiles, migrateProfiles, publicProfiles, profileName } from './api-profiles.mjs';

const files = ['IDENTITY.md', 'SOUL.md', 'USER.md'];
const nameOf = text => text.match(/^-\s*名字[：:]\s*(.+)$/m)?.[1]?.trim() || '晚晴';
const publicStatus = s => ({ running: !!s.running, uncertain: !!s.uncertain });

export async function createDesktopService(home, { vault, hooks = {} } = {}) {
  await init(home);
  // Use one runtime for both the real instance and isolated schema validation.
  process.env.COMPANION_RUNTIME ||= paths(home).runtime;
  const state = { busy: false, message: '', credentialWarning: '' };
  const keyFile = path.join(home, 'desktop-key.enc.json');
  const previous = await load(home);
  const initialProfiles = await migrateProfiles(home, previous);
  const sessionKeys = new Map();
  if (previous.api && vault) {
    try {
      const saved = await readJson(keyFile);
      if (saved.origin === new URL(previous.api.baseUrl).origin && !process.env[previous.api.keyEnv]) {
        process.env[previous.api.keyEnv] = await vault.decrypt(saved.value);
      }
    } catch (e) { if (e.code !== 'ENOENT') state.credentialWarning = '保存的密钥暂时无法读取，请在模型页重新输入。'; }
  }
  if (initialProfiles.activeId && previous.api && process.env[previous.api.keyEnv]) sessionKeys.set(initialProfiles.activeId, process.env[previous.api.keyEnv]);
  const dependencies = {
    status: processStatus, start, stop, runOC, localModels, testModel, installRuntime, localModelInfo, localVisionModels, testVision,
    ...hooks
  };
  async function persona() {
    const contents = Object.fromEntries(await Promise.all(files.map(async f => [f, await fs.readFile(path.join(paths(home).workspace, f), 'utf8')])));
    return { name: nameOf(contents['IDENTITY.md']), soul: contents['SOUL.md'], user: contents['USER.md'] };
  }
  async function snapshot() {
    const c = await load(home), p = await persona(), profileData = await readProfiles(home);
    const gateway = publicStatus(await dependencies.status(home));
    Object.assign(gateway, gateway.running ? await gatewayReadiness(home, c) : { ready: false });
    return {
      mode: c.mode, local: c.local, api: c.api ? { baseUrl: c.api.baseUrl, model: c.api.model, contextWindow: c.api.contextWindow, maxTokens: c.api.maxTokens, temperature: c.api.temperature ?? 0.7, timeoutMs: c.api.timeoutMs } : null, persona: p, chat: chatSettings(c), apiProfiles: (() => { const result = publicProfiles(profileData); for (const item of result.items) item.available = sessionKeys.has(item.id); return result; })(),
      vision: visionSettings(c), proactive: proactiveSettings(c), proactiveStatus: await proactiveStatus(home, c),
      gateway,
      wechatReady: await verifyWechatOwner(home).then(owner => owner.restricted, () => false),
      runtimeReady: await fs.access(runtimeEntry(home)).then(() => true, () => false),
      credentials: { present: !!(c.api && process.env[c.api.keyEnv]), stored: await fs.access(keyFile).then(() => true, () => false), canStore: !!vault, warning: state.credentialWarning },
      operation: { busy: state.busy, message: state.message }
    };
  }
  async function exclusive(message, action) {
    if (state.busy) throw new Error('上一项操作还在进行，请稍候。');
    state.busy = true; state.message = message;
    try { return await action(); } finally { state.busy = false; state.message = ''; }
  }
  async function ensureRuntime() {
    if (!await fs.access(runtimeEntry(home)).then(() => true, () => false)) {
      state.message = '首次准备运行环境，可能需要几分钟…';
      await dependencies.installRuntime(home);
    }
  }
  async function ensureLocal(c, requireModel = true) {
    try {
      const models = await dependencies.localModels(c);
      if (requireModel && !models.includes(c.local.model)) throw new Error(`没有找到 ${c.local.model}，请在模型页选择已下载的模型。`);
      return;
    } catch (error) {
      if (!error.message.includes('无法连接')) throw error;
      if (!/^http:\/\/(127\.0\.0\.1|localhost):11434\/?$/.test(c.local.baseUrl)) throw error;
    }
    state.message = '正在唤醒本地 Ollama…';
    let binary = 'ollama'; const ollamaEnv = { ...process.env };
    if (process.platform === 'win32') {
      const candidates = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'), path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe')];
      binary = candidates[0];
      for (const candidate of candidates) if (await fs.access(candidate).then(() => true, () => false)) { binary = candidate; break; }
      // A desktop launched from an older terminal can miss a newer Windows machine/user model-directory setting.
      if (!ollamaEnv.OLLAMA_MODELS) {
        const configured = await new Promise(resolve => {
          const command = "$v=[Environment]::GetEnvironmentVariable('OLLAMA_MODELS','User'); if(-not $v){$v=[Environment]::GetEnvironmentVariable('OLLAMA_MODELS','Machine')}; if($v){[Console]::Write([Environment]::ExpandEnvironmentVariables($v))}";
          const query = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
          let value = ''; query.stdout.on('data', d => { value += d; });
          const timer = setTimeout(() => { query.kill(); resolve(''); }, 5000);
          query.once('error', () => { clearTimeout(timer); resolve(''); }); query.once('close', code => { clearTimeout(timer); resolve(code === 0 ? value.trim() : ''); });
        });
        if (configured) ollamaEnv.OLLAMA_MODELS = configured;
      }
    }
    const child = spawn(binary, ['serve'], { env: ollamaEnv, windowsHide: true, detached: true, stdio: 'ignore' });
    let launchError;
    child.once('error', () => { launchError = new Error('无法自动启动 Ollama，请从开始菜单打开 Ollama 后重试。'); });
    child.once('spawn', () => { atomicWrite(path.join(home, 'desktop-ollama-process.json'), { pid: child.pid, binary, startedAt: new Date().toISOString() }).catch(() => {}); });
    child.unref();
    for (let i = 0; i < 20; i++) {
      if (launchError) throw launchError;
      await new Promise(r => setTimeout(r, 500));
      try { const installed = await dependencies.localModels(c); if (!requireModel || installed.includes(c.local.model)) return; } catch {}
    }
    throw new Error('Ollama 尚未就绪，请从开始菜单打开 Ollama 后重试。');
  }
  async function validateOffline(c) {
    const tempRoot = path.join(home, 'tmp'); await fs.mkdir(tempRoot, { recursive: true });
    const dir = await fs.mkdtemp(path.join(tempRoot, 'desktop-validate-'));
    try {
      await init(dir);
      await dependencies.runOC(dir, c, ['config', 'validate'], { capture: true });
    } finally {
      const rel = path.relative(tempRoot, dir);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) await fs.rm(dir, { recursive: true, force: true });
    }
  }
  async function transact(next, role, onRollback, commit) {
    const old = await load(home), p = paths(home), original = new Map();
    const savedStatus = await dependencies.status(home);
    if (savedStatus.uncertain) throw new Error('服务状态暂时无法确认，请关闭其他控制窗口后重试。');
    for (const file of [p.config, p.oc, keyFile, profilesPath(home), ...files.map(f => path.join(p.workspace, f))]) {
      try { original.set(file, await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; original.set(file, null); }
    }
    let archived;
    if (savedStatus.running) { state.message = '正在停止当前陪伴服务…'; await dependencies.stop(home); }
    try {
      if (role) {
        archived = await archiveRoleState(home);
        for (const [file, content] of Object.entries(role)) await atomicWrite(path.join(p.workspace, file), content);
        next.sessionEpoch = crypto.randomUUID();
      }
      await atomicWrite(p.config, next); await prepare(home, next);
      await commit?.();
      if (savedStatus.running) { state.message = '正在重新启动，让设置生效…'; await dependencies.start(home, next); }
    } catch (error) {
      onRollback?.();
      // Stop only our instance before restoring its files. An uncertain status must be surfaced.
      const failed = await dependencies.status(home);
      if (failed.running || failed.uncertain) await dependencies.stop(home);
      for (const [file, content] of original) {
        if (content === null) await fs.rm(file, { force: true }); else await atomicWrite(file, content);
      }
      if (archived) await archived.restore();
      if (savedStatus.running) {
        try { await dependencies.start(home, old); }
        catch { throw new Error(`${error.message}\n原设置已恢复，但服务未能恢复启动，请点击一键启动重试。`); }
      }
      throw error;
    }
  }
  return {
    snapshot,
    visionModels: () => exclusive('正在检查图片模型能力…', async () => dependencies.localVisionModels(await load(home))),
    models: () => exclusive('正在读取本地模型…', async () => { const c = await load(home); await ensureLocal(c, false); return dependencies.localModels(c); }),
    start: () => exclusive('正在准备陪伴服务…', async () => {
      const c = await load(home); validateConfig(c, c.mode, process.env, true);
      const current = await dependencies.status(home);
      if (current.running) return { message: '陪伴服务已经在运行。' };
      if (current.uncertain) throw new Error('无法确认已有服务状态，请稍后重试。');
      if (c.mode === 'local') await ensureLocal(c);
      await ensureRuntime(); await dependencies.start(home, c);
      const owner = await verifyWechatOwner(home);
      return { message: owner.restricted ? '陪伴已启动，可以回到微信聊天了。' : '服务已启动。首次使用请完成微信 ClawBot 扫码绑定。' };
    }),
    stop: () => exclusive('正在停止陪伴服务…', async () => { await dependencies.stop(home); return { message: '陪伴服务已停止。' }; }),
    saveFeatures: input => exclusive('正在保存图片与主动联系设置…', async () => {
      const c = await load(home);
      const next = { ...c, vision: input.vision, proactive: input.proactive, chat: input.chat ?? c.chat };
      const normalized = validateFeatures(next); Object.assign(next, normalized);
      validateConfig(next, next.mode, process.env, true);
      if (next.vision.enabled && next.mode === 'local') {
        if (!(await dependencies.localModelInfo(next, next.vision.localModel)).capabilities?.includes('vision')) throw new Error('所选本地模型不支持图片，请选择具有视觉能力的模型。');
      }
      await ensureRuntime(); await validateOffline(next); await transact(next);
      return { message: '图片与主动联系设置已保存。主动消息仅在陪伴服务运行、允许时段和微信会话可用时发送。' };
    }),
    testVision: input => exclusive('正在看这张图片，首次加载可能需要一些时间…', async () => dependencies.testVision(await load(home), input)),
    deleteApiProfile: input => exclusive('正在删除 API 配置…', async () => {
      const data = await readProfiles(home);
      if (input.id === data.activeId) throw new Error('请先应用另一套 API 配置，再删除当前配置。');
      if (!data.profiles.some(p => p.id === input.id)) throw new Error('未找到这套 API 配置。');
      await atomicWrite(profilesPath(home), { ...data, profiles: data.profiles.filter(p => p.id !== input.id) });
      sessionKeys.delete(input.id);
      return { message: 'API 配置及其保存的密钥已删除。' };
    }),
    applyModel: input => exclusive('正在检查模型设置…', async () => {
      const old = await load(home), next = structuredClone(old);
      if (!['local', 'api'].includes(input.mode)) throw new Error('请选择本地模型或 API 服务。');
      next.mode = input.mode;
      const keyEnv = 'COMPANION_API_KEY', priorKey = process.env[keyEnv];
      const profiles = await readProfiles(home);
      let selected, candidateKey, savedName;
      if (input.mode === 'local') {
        if (typeof input.model !== 'string') throw new Error('请选择本地模型。');
        next.local.model = input.model.trim();
        for (const key of ['temperature', 'contextWindow', 'maxTokens', 'timeoutMs']) if (input.local?.[key] !== undefined) next.local[key] = Number(input.local[key]);
        validateConfig(next);
        const models = await dependencies.localModels(next);
        if (!models.includes(next.local.model)) throw new Error('这个模型尚未下载，请选择列表中的模型。');
      } else {
        const a = input.api || {};
        selected = a.createProfile ? undefined : profiles.profiles.find(p => p.id === (a.profileId || profiles.activeId));
        if (a.profileId && !selected) throw new Error('所选 API 配置不存在，请刷新后重试。');
        const baseline = selected?.api || old.api;
        next.api = { baseUrl: validateEndpoint(a.baseUrl?.trim()), model: a.model?.trim(), keyEnv, contextWindow: Number(a.contextWindow ?? baseline?.contextWindow ?? 32768), maxTokens: Number(a.maxTokens ?? baseline?.maxTokens ?? 512), timeoutMs: Number(a.timeoutMs ?? baseline?.timeoutMs ?? 120000), temperature: Number(a.temperature ?? baseline?.temperature ?? 0.7) };
        savedName = profileName(a.name ?? selected?.name, next.api);
        if (!selected && profiles.profiles.length >= 50) throw new Error('最多保存 50 套 API 配置，请先删除不用的配置。');
        if (a.key && typeof a.key !== 'string') throw new Error('密钥格式不正确。');
        const sameEndpoint = selected && selected.api.baseUrl === next.api.baseUrl;
        if (a.key?.trim()) candidateKey = a.key.trim();
        else if (sameEndpoint) {
          candidateKey = sessionKeys.get(selected.id);
          if (!candidateKey && selected.encryptedKey && vault) {
            try { candidateKey = await vault.decrypt(selected.encryptedKey); }
            catch { throw new Error('这套配置的密钥无法解密，请重新输入。'); }
          }
          if (!candidateKey && selected.id === profiles.activeId) candidateKey = priorKey;
        }
        if (!candidateKey) throw new Error('新增配置或更换服务地址时，请输入对应 API Key；未保存密钥的配置也需要重新输入。');
        next.apiConsentAt = new Date().toISOString();
      }
      try {
        if (input.mode === 'api') process.env[keyEnv] = candidateKey;
        validateConfig(next, next.mode, process.env, true);
        if (input.mode === 'api' && input.api.remember && !vault) throw new Error('当前环境不支持加密保存密钥，请取消勾选后使用。');
        const encrypted = input.mode === 'api' && input.api.remember ? await vault.encrypt(process.env[keyEnv]) : null;
        const id = selected?.id || crypto.randomUUID();
        await ensureRuntime(); await validateOffline(next); await transact(next, undefined, () => { if (priorKey === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = priorKey; }, input.mode === 'api' ? async () => {
          const record = { id, name: savedName, api: next.api, encryptedKey: encrypted };
          const items = selected ? profiles.profiles.map(p => p.id === id ? record : p) : [...profiles.profiles, record];
          await atomicWrite(profilesPath(home), { version: 1, activeId: id, profiles: items });
          if (encrypted) await atomicWrite(keyFile, { origin: new URL(next.api.baseUrl).origin, value: encrypted });
          else await fs.rm(keyFile, { force: true });
        } : undefined);
        if (input.mode === 'api') {
          state.credentialWarning = '';
          sessionKeys.set(id, candidateKey);
        }
        return { message: '模型设置已生效，人物与记忆已保留。' };
      } catch (e) { if (priorKey === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = priorKey; throw e; }
    }),
    savePersona: input => exclusive('正在保存角色设定…', async () => {
      const currentConfig = await load(home);
      validateConfig(currentConfig, currentConfig.mode, process.env, true);
      const name = input.name?.trim();
      if (!name || name.length > 32 || /[\r\n]/.test(name)) throw new Error('角色名请填写 1–32 个字。');
      if (typeof input.soul !== 'string' || !input.soul.trim() || input.soul.length > 16000) throw new Error('请填写角色设定（最多 16000 字）。');
      if (typeof input.user !== 'string' || input.user.length > 8000) throw new Error('关于你的资料最多 8000 字。');
      const before = await persona();
      const identity = await fs.readFile(path.join(paths(home).workspace, 'IDENTITY.md'), 'utf8');
      const role = { 'IDENTITY.md': /^-\s*名字[：:]/m.test(identity) ? identity.replace(/^-\s*名字[：:].*$/m, `- 名字：${name}`) : `- 名字：${name}\n${identity}`, 'SOUL.md': name !== before.name ? input.soul.replaceAll(before.name, name) : input.soul, 'USER.md': input.user };
      await ensureRuntime(); await transact({ ...currentConfig, roleName: name }, role);
      return { message: '角色设定已保存。新的对话会采用这份设定。' };
    }),
    test: () => exclusive('正在测试当前模型，请稍候…', async () => {
      const result = await dependencies.testModel(await load(home));
      return { message: `连接成功 · ${(result.elapsedMs / 1000).toFixed(1)} 秒`, reply: result.text };
    })
  };
}
