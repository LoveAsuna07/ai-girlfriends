import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homePath } from './config.mjs';
import { createDesktopService } from './desktop-service.mjs';

export async function serveDesktop({ home = homePath(), vault, hooks, port = 0 } = {}) {
  const service = await createDesktopService(home, { vault, hooks });
  const token = crypto.randomBytes(32).toString('hex');
  const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../desktop/ui');
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json = (code, payload) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); };
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return json(403, { error: '无法从这个来源访问桌面控制台。' });
      const pathname = new URL(req.url, origin).pathname;
      if (pathname.startsWith('/api/')) {
        if (req.headers['x-companion-token'] !== token) return json(401, { error: '控制台会话已失效，请重新打开窗口。' });
        if (req.method === 'GET' && pathname === '/api/state') return json(200, await service.snapshot());
        if (req.method === 'GET' && pathname === '/api/models') return json(200, { models: await service.models() });
        if (req.method === 'GET' && pathname === '/api/vision-models') return json(200, { models: await service.visionModels() });
        if (req.method !== 'POST') return json(405, { error: '不支持的操作。' });
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(415, { error: '请求格式不正确。' });
        let raw = '', bytes = 0; const limit = pathname === '/api/vision-test' ? 14000000 : 100000;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) return json(413, { error: '内容太长。' }); raw += chunk; }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return json(400, { error: '请求内容不是有效 JSON。' }); }
        const methods = { '/api/start': () => service.start(), '/api/stop': () => service.stop(), '/api/model': () => service.applyModel(body), '/api/persona': () => service.savePersona(body), '/api/test': () => service.test(), '/api/features': () => service.saveFeatures(body), '/api/vision-test': () => service.testVision(body), '/api/profile-delete': () => service.deleteApiProfile(body) };
        if (!methods[pathname]) return json(404, { error: '没有这个操作。' });
        return json(200, await methods[pathname]());
      }
      const allowed = { '/': ['index.html', 'text/html'], '/app.css': ['app.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/mark.svg': ['mark.svg', 'image/svg+xml'] };
      if (req.method !== 'GET' || !allowed[pathname]) { res.writeHead(404).end(); return; }
      const [file, type] = allowed[pathname];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(await fs.readFile(path.join(assets, file)));
    } catch (error) {
      // Avoid returning third-party diagnostics that might quote a user credential.
      let message = String(error.message || '操作失败，请重试。');
      for (const [key, value] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET/i.test(key) && value?.length > 7) message = message.split(value).join('[已隐藏]');
      json(400, { error: message });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { service, token, origin, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pending = new Map();
  process.on('message', msg => { if (msg?.type === 'vault-result') { const callback = pending.get(msg.id); if (callback) { pending.delete(msg.id); msg.error ? callback.reject(new Error('系统加密服务暂不可用。')) : callback.resolve(msg.value); } } });
  const invoke = (action, value) => new Promise((resolve, reject) => { const id = crypto.randomUUID(); const timer = setTimeout(() => { pending.delete(id); reject(new Error('系统加密服务响应超时。')); }, 10000); pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } }); process.send({ type: 'vault', id, action, value }); });
  try {
    const vault = process.env.COMPANION_DESKTOP_VAULT === '1' && process.send ? { encrypt: value => invoke('encrypt', value), decrypt: value => invoke('decrypt', value) } : undefined;
    const app = await serveDesktop({ vault });
    if (process.send) process.send({ type: 'ready', origin: app.origin, token: app.token });
    else console.log(`桌面服务已启动：${app.origin}/#session=${app.token}`);
    process.on('message', async msg => { if (msg?.type === 'shutdown') { await app.close(); process.exit(0); } });
  } catch (error) { if (process.send) process.send({ type: 'error', message: error.message }); else console.error(error.message); process.exitCode = 1; }
}
