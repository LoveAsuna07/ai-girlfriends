import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, atomicWrite } from './config.mjs';

export const profilesPath = home => path.join(home, 'api-profiles.json');
export async function readProfiles(home) {
  const data = await readJson(profilesPath(home)).catch(error => { if (error.code === 'ENOENT') return { version: 1, activeId: null, profiles: [] }; throw error; });
  if (data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 50 || data.profiles.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string' || !p.api || 'key' in p.api || 'apiKey' in p.api)) throw new Error('API 配置列表无效，请检查私人配置备份。');
  return data;
}
export function profileName(value, api) {
  if (value !== undefined && typeof value !== 'string') throw new Error('配置名称必须为文字。');
  const name = (value ?? `${new URL(api.baseUrl).hostname} · ${api.model}`.slice(0, 64)).trim();
  if (!name || name.length > 64 || /[\r\n]/.test(name)) throw new Error('配置名称请填写 1–64 个字。');
  return name;
}
export async function migrateProfiles(home, config) {
  const data = await readProfiles(home);
  if (data.profiles.length || !config.api) return data;
  // A damaged legacy key file must not prevent opening the editor to enter a new key.
  const old = await readJson(path.join(home, 'desktop-key.enc.json')).catch(() => null);
  const id = crypto.randomUUID();
  const encryptedKey = old?.origin === new URL(config.api.baseUrl).origin ? old.value : null;
  const next = { version: 1, activeId: id, profiles: [{ id, name: profileName(undefined, config.api), api: config.api, encryptedKey }] };
  await atomicWrite(profilesPath(home), next);
  return next;
}
export function publicProfiles(data) {
  return { activeId: data.activeId, items: data.profiles.map(p => ({ id: p.id, name: p.name, api: { baseUrl: p.api.baseUrl, model: p.api.model, contextWindow: p.api.contextWindow, maxTokens: p.api.maxTokens, timeoutMs: p.api.timeoutMs, temperature: p.api.temperature ?? 0.7 }, stored: !!p.encryptedKey })) };
}
