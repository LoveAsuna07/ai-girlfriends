const { app, BrowserWindow, dialog, safeStorage, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let backend, window, endpoint, quitting = false;
const root = path.resolve(__dirname, '..');
function settings() {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(process.execPath), 'local-launch.json'), 'utf8')); } catch { return {}; }
}
const localHome = settings().home;
const privateHome = process.env.COMPANION_HOME || (localHome && fs.existsSync(localHome) ? localHome : path.join(require('node:os').homedir(), '.local-companion'));
fs.mkdirSync(path.join(privateHome, 'desktop-window'), { recursive: true });
app.setPath('userData', path.join(privateHome, 'desktop-window'));
async function boot() {
  const local = settings();
  const nodeBinary = process.env.COMPANION_NODE || local.node || (app.isPackaged ? path.join(process.resourcesPath, 'node', 'node.exe') : 'node');
  const env = { ...process.env, COMPANION_DESKTOP_VAULT: safeStorage.isEncryptionAvailable() ? '1' : '0' };
  if (!env.COMPANION_HOME && local.home && fs.existsSync(local.home)) env.COMPANION_HOME = local.home;
  if (!env.COMPANION_RUNTIME && local.runtime && fs.existsSync(local.runtime)) env.COMPANION_RUNTIME = local.runtime;
  backend = spawn(nodeBinary, [path.join(root, 'src', 'desktop-server.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  backend.stderr.on('data', () => {});
  endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('控制台启动超时，请重新打开。')), 30000);
    backend.once('error', () => { clearTimeout(timer); reject(new Error('无法启动 Node.js 运行环境。')); });
    backend.once('exit', () => { clearTimeout(timer); reject(new Error('控制台服务提前退出，请检查本机运行环境。')); });
    backend.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timer); resolve(message); }
      else if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
      else if (message.type === 'vault') {
        try {
          if (!safeStorage.isEncryptionAvailable()) throw new Error('不可用');
          const value = message.action === 'encrypt' ? safeStorage.encryptString(message.value).toString('base64') : safeStorage.decryptString(Buffer.from(message.value, 'base64'));
          backend.send({ type: 'vault-result', id: message.id, value });
        } catch { backend.send({ type: 'vault-result', id: message.id, error: true }); }
      }
    });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window = new BrowserWindow({ width: 1180, height: 820, minWidth: 960, minHeight: 690, title: 'AI 陪伴 · Companion', backgroundColor: '#f5f2eb', autoHideMenuBar: true, show: false, icon: path.join(__dirname, 'ui', 'icon.png'), webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== endpoint.origin) event.preventDefault(); });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    (async () => {
      try {
        const state = await fetch(`${endpoint.origin}/api/state`, { headers: { 'X-Companion-Token': endpoint.token } }).then(r => r.json());
        if (state.operation?.busy) { await dialog.showMessageBox(window, { type: 'info', message: '操作还在进行，请完成后再关闭窗口。', buttons: ['继续等待'] }); return; }
        if (state.gateway?.running) {
          const choice = await dialog.showMessageBox(window, { type: 'question', title: '关闭控制台', message: '陪伴服务正在运行', detail: '你可以保留服务，在微信继续聊天。', buttons: ['保持运行并关闭窗口', '停止陪伴并退出', '取消'], defaultId: 0, cancelId: 2 });
          if (choice.response === 2) return;
          if (choice.response === 1) {
            const r = await fetch(`${endpoint.origin}/api/stop`, { method: 'POST', headers: { 'X-Companion-Token': endpoint.token, 'Content-Type': 'application/json' }, body: '{}' });
            if (!r.ok) throw new Error((await r.json()).error);
          }
        }
        quitting = true; window.close();
      } catch (e) { const choice = await dialog.showMessageBox(window, { type: 'error', message: '控制台连接已中断', detail: '关闭窗口不会终止其他服务。你可以重新打开控制台。', buttons: ['退出窗口', '取消'], cancelId: 1 }); if (choice.response === 0) { quitting = true; window.close(); } }
    })();
  });
  await window.loadURL(`${endpoint.origin}/#session=${endpoint.token}`);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(boot).catch(async e => { await dialog.showMessageBox({ type: 'error', title: 'AI 陪伴', message: '无法打开桌面控制台', detail: e.message }); quitting = true; app.quit(); });
  app.on('window-all-closed', () => { if (backend?.connected) backend.send({ type: 'shutdown' }); setTimeout(() => backend?.kill(), 1500).unref(); app.quit(); });
  app.on('before-quit', event => {
    if (!quitting && window && !window.isDestroyed()) { event.preventDefault(); window.close(); return; }
    if (backend?.connected) backend.send({ type: 'shutdown' });
  });
}
