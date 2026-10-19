import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { ROOT } from '../src/config.mjs';
import { releaseCheck } from '../src/release.mjs';

const [outArg, workArg] = process.argv.slice(2);
if (!outArg || !workArg || !outArg.toLowerCase().endsWith('.zip')) throw new Error('用法：node scripts/package.mjs 源码包绝对路径.zip 临时工作目录');
const output = path.resolve(outArg), work = path.resolve(workArg);
await fs.mkdir(work, { recursive: true }); await fs.mkdir(path.dirname(output), { recursive: true });
const files = await releaseCheck(); const stage = await fs.mkdtemp(path.join(work, 'source-release-'));
const target = path.join(stage, 'local-companion');
try {
  for (const file of files) { const dest = path.join(target, ...file.path.split('/')); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(path.join(ROOT, ...file.path.split('/')), dest); const copied = await fs.readFile(dest); if (crypto.createHash('sha256').update(copied).digest('hex') !== file.sha256) throw new Error('打包期间源码发生变化：' + file.path); }
  await fs.writeFile(path.join(target, 'SOURCE-MANIFEST.json'), JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2));
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:COMPANION_PACKAGE_STAGE -DestinationPath $env:COMPANION_PACKAGE_OUTPUT -Force'], { windowsHide: true, env: { ...process.env, COMPANION_PACKAGE_STAGE: target, COMPANION_PACKAGE_OUTPUT: output }, stdio: 'inherit' });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('压缩失败：' + code)));
  });
  console.log(`已打包 ${files.length} 个审查过的源码文件 + SHA256清单：${output}`);
} finally {
  const relative = path.relative(work, stage);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(stage, { recursive: true, force: true });
}
