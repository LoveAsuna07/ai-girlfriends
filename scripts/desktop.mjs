import path from 'node:path';
import { spawn } from 'node:child_process';
import { exists, ROOT } from '../src/config.mjs';
const portable = path.resolve(ROOT, '..', 'local-companion-desktop', 'Local Companion.exe');
const binary = process.env.COMPANION_ELECTRON || (await exists(portable) ? portable : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'));
if (!await exists(binary)) { console.error('请双击桌面版文件夹中的 Local Companion.exe，或先准备 Electron 并设置 COMPANION_ELECTRON。'); process.exitCode = 1; }
else {
  const child = spawn(binary, path.basename(binary) === 'Local Companion.exe' ? [] : [ROOT], { cwd: ROOT, windowsHide: true, detached: true, stdio: 'ignore', env: process.env });
  child.on('error', e => { console.error(e.message); process.exitCode = 1; }); child.unref();
}
