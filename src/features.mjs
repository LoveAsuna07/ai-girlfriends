export const defaultVision = { enabled: false, localModel: 'qwen3.5:2b', apiModel: '' };
export const defaultProactive = { enabled: false, idleMinutes: 120, intervalMinutes: 120, dailyLimit: 5, start: '09:00', end: '22:30', timeZone: 'Asia/Taipei', prompt: '自然、稍微黏人的短句，像主动分享日常或关心近况。不要催促回复。' };
export function visionSettings(c) { return { ...defaultVision, ...c.vision }; }
export function proactiveSettings(c) { return { ...defaultProactive, ...c.proactive }; }
export function validateFeatures(c) {
  const v = visionSettings(c), p = proactiveSettings(c);
  if (typeof v.enabled !== 'boolean' || typeof p.enabled !== 'boolean') throw new Error('功能开关必须为布尔值。');
  for (const key of ['localModel', 'apiModel']) if (typeof v[key] !== 'string' || v[key].length > 200 || /[\r\n]/.test(v[key])) throw new Error('图片模型名称无效。');
  if (v.enabled && c.mode === 'local' && !v.localModel.trim()) throw new Error('请选择本地图片模型。');
  for (const [key, min, max] of [['idleMinutes', 30, 1440], ['intervalMinutes', 30, 1440], ['dailyLimit', 1, 12]]) if (!Number.isInteger(p[key]) || p[key] < min || p[key] > max) throw new Error('主动联系的间隔须为 30–1440 分钟，每日上限为 1–12 次。');
  for (const key of ['start', 'end']) if (typeof p[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p[key])) throw new Error('请填写有效的联系时段。');
  if (p.start === p.end) throw new Error('开始与结束时间不能相同。');
  try { new Intl.DateTimeFormat('en', { timeZone: p.timeZone }).format(); } catch { throw new Error('时区无效。'); }
  if (typeof p.prompt !== 'string' || p.prompt.length > 2000) throw new Error('主动联系偏好最多 2000 字。');
  return { vision: v, proactive: p };
}
