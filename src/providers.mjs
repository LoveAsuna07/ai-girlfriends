import { validateConfig } from './config.mjs';
import { visionSettings } from './features.mjs';
import { cleanChatText } from './chat.mjs';

export async function requestJson(url, { timeoutMs = 10000, ...options } = {}) {
  let response;
  try { response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' || e.name === 'AbortError' ? '模型请求超时；未重试。' : '无法连接模型服务；请检查地址与服务状态。'); }
  if (!response.ok) {
    const hints = { 401: 'API 密钥无效', 403: 'API 权限不足', 429: '服务限流或额度不足' };
    throw new Error(`模型服务 HTTP ${response.status}：${hints[response.status] || (response.status >= 500 ? '服务端故障' : '请求被拒绝')}；未重试。`);
  }
  try { return await response.json(); } catch (e) { throw new Error(e.name === 'TimeoutError' || e.name === 'AbortError' ? '模型响应体读取超时；未重试。' : '模型服务返回了无效 JSON。'); }
}
export async function localModels(c) {
  validateConfig(c, 'local');
  const data = await requestJson(`${c.local.baseUrl.replace(/\/$/, '')}/api/tags`);
  if (!Array.isArray(data.models)) throw new Error('Ollama 模型列表结构不正确。');
  return data.models.map(m => m.name);
}
export async function localModelInfo(c, model) {
  return requestJson(`${c.local.baseUrl.replace(/\/$/, '')}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
}
export async function localVisionModels(c) {
  const models = await localModels(c);
  const supported = await Promise.all(models.map(async model => (await localModelInfo(c, model)).capabilities?.includes('vision') ? model : null));
  return supported.filter(Boolean);
}
export function normalizeImage(input) {
  if (!input || typeof input.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length > 13981016) throw new Error('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。');
  const bytes = Buffer.from(input.base64, 'base64');
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!mime || bytes.length > 10485760 || bytes.toString('base64') !== input.base64) throw new Error('图片格式无效，仅支持 10 MB 以内的 PNG、JPEG 或 WebP。');
  return { mime, base64: input.base64 };
}
export async function testVision(c, input) {
  validateConfig(c, c.mode, process.env, true);
  const v = visionSettings(c); if (!v.enabled) throw new Error('请先开启并保存图片识别设置。');
  const image = normalizeImage(input), p = c[c.mode];
  const model = c.mode === 'local' ? v.localModel : v.apiModel || p.model;
  const prompt = '请用中文描述这张图片的主要内容和可读文字。看不清时请说明，不要猜测。';
  const started = performance.now(); let data;
  if (c.mode === 'local') {
    if (!(await localModelInfo(c, model)).capabilities?.includes('vision')) throw new Error('所选模型不支持图片。');
    data = await requestJson(p.baseUrl.replace(/\/$/, '') + '/api/chat', { method: 'POST', timeoutMs: 180000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: false, think: false, messages: [{ role: 'user', content: prompt, images: [image.base64] }], options: { num_ctx: 8192, num_predict: 512, temperature: 0.2 }, keep_alive: 0 }) });
  } else {
    data = await requestJson(p.baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', timeoutMs: 180000, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env[p.keyEnv]}` }, body: JSON.stringify({ model, stream: false, max_tokens: 512, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }] }] }) });
  }
  return { message: `图片识别成功 · ${model} · ${((performance.now() - started) / 1000).toFixed(1)} 秒`, reply: cleanReply(c.mode === 'local' ? data.message?.content : data.choices?.[0]?.message?.content) };
}
export function cleanReply(text) {
  if (typeof text !== 'string') throw new Error('模型回复结构不正确。');
  const clean = cleanChatText(text);
  if (!clean || clean.includes('<think>')) throw new Error('模型返回空回复或未结束的思考内容。');
  return clean;
}
export async function testModel(c, { mode = c.mode, env = process.env, prompt = '请用一句简短中文问候我。', messages } = {}) {
  validateConfig(c, mode, env, true); const m = c[mode]; const start = performance.now();
  const chat = messages || [{ role: 'user', content: prompt }]; let data, text;
  if (mode === 'local') {
    const models = await localModels(c); if (!models.includes(m.model)) throw new Error(`Ollama 未安装 ${m.model}；请自行安装后重试，本项目不会自动下载。`);
    data = await requestJson(`${m.baseUrl.replace(/\/$/, '')}/api/chat`, { method: 'POST', timeoutMs: m.timeoutMs, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: m.model, messages: chat, stream: false, think: false, options: { num_ctx: Math.min(m.testContext || 8192, m.contextWindow), num_predict: m.maxTokens, temperature: m.temperature ?? 0.7 } }) });
    text = cleanReply(data.message?.content);
  } else {
    data = await requestJson(`${m.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', timeoutMs: m.timeoutMs, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env[m.keyEnv]}` }, body: JSON.stringify({ model: m.model, messages: chat, stream: false, max_tokens: m.maxTokens, temperature: m.temperature ?? 0.7 }) });
    text = cleanReply(data.choices?.[0]?.message?.content);
  }
  return { mode, model: m.model, elapsedMs: Math.round(performance.now() - start), text };
}
