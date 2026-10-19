import { validateConfig } from './config.mjs';

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
export function cleanReply(text) {
  if (typeof text !== 'string') throw new Error('模型回复结构不正确。');
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!clean || clean.includes('<think>')) throw new Error('模型返回空回复或未结束的思考内容。');
  return clean;
}
export async function testModel(c, { mode = c.mode, env = process.env, prompt = '请用一句简短中文问候我。', messages } = {}) {
  validateConfig(c, mode, env, true); const m = c[mode]; const start = performance.now();
  const chat = messages || [{ role: 'user', content: prompt }]; let data, text;
  if (mode === 'local') {
    const models = await localModels(c); if (!models.includes(m.model)) throw new Error(`Ollama 未安装 ${m.model}；请自行安装后重试，本项目不会自动下载。`);
    data = await requestJson(`${m.baseUrl.replace(/\/$/, '')}/api/chat`, { method: 'POST', timeoutMs: m.timeoutMs, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: m.model, messages: chat, stream: false, think: false, options: { num_ctx: m.testContext || 8192, num_predict: m.maxTokens, temperature: 0.7 } }) });
    text = cleanReply(data.message?.content);
  } else {
    data = await requestJson(`${m.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', timeoutMs: m.timeoutMs, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env[m.keyEnv]}` }, body: JSON.stringify({ model: m.model, messages: chat, stream: false, max_tokens: m.maxTokens }) });
    text = cleanReply(data.choices?.[0]?.message?.content);
  }
  return { mode, model: m.model, elapsedMs: Math.round(performance.now() - start), text };
}
