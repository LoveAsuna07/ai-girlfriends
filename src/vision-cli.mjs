// Restricted image preprocessor invoked by OpenClaw for one staged attachment.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { load } from './config.mjs';
import { testVision } from './providers.mjs';
try {
  if (!process.env.OPENCLAW_HOME || process.argv.length !== 3) throw new Error('图片预处理参数无效。');
  const home = await fs.realpath(process.env.OPENCLAW_HOME), file = await fs.realpath(process.argv[2]);
  const relative = path.relative(home, file);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('只允许读取本实例收到的图片。');
  const handle = await fs.open(file, 'r');
  let bytes;
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > 10485760) throw new Error('图片过大。');
    bytes = await handle.readFile(); if (bytes.length > 10485760) throw new Error('图片过大。');
  } finally { await handle.close(); }
  const result = await testVision(await load(home), { base64: bytes.toString('base64') });
  process.stdout.write(result.reply + '\n');
} catch { console.error('图片未能识别，请检查图片模型设置、图片格式和大小。'); process.exitCode = 1; }
