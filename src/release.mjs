import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.mjs';

const rootFiles = new Set(['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'THIRD_PARTY.md', '.gitignore', '.env.example', 'SOURCE-MANIFEST.json']);
const directories = new Set(['src', 'scripts', 'templates', 'tests', 'docs', 'desktop']);
export async function releaseCheck(root = ROOT) {
  const files = [];
  let manifest;
  async function walk(dir, relative = '') {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = path.posix.join(relative, ent.name);
      if (ent.isSymbolicLink()) throw new Error(`发布目录含符号链接：${rel}`);
      if (!relative && !rootFiles.has(ent.name) && !directories.has(ent.name)) { if (ent.name === '.git' || ent.name === 'node_modules') continue; throw new Error(`发布目录有未审查文件：${rel}`); }
      if (ent.isDirectory()) await walk(path.join(dir, ent.name), rel);
      else {
        if (/\.(log|jsonl|db|sqlite|zip|tgz|tmp)$/i.test(rel) || /(^|\/)(credentials|sessions)\//i.test(rel) || /(^|\/)(auth-profiles|companion|openclaw|memories)\.json$/i.test(rel)) throw new Error(`发布目录疑似私有数据：${rel}`);
        const buf = await fs.readFile(path.join(dir, ent.name)); const content = buf.toString('utf8');
        if (/(?:sk-[a-zA-Z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"(?:botToken|access_token|refresh_token)"\s*:\s*"[^"\s]{12,}")/.test(content)) throw new Error(`发布文件疑似含凭据：${rel}`);
        if (rel === 'SOURCE-MANIFEST.json') { try { manifest = JSON.parse(content); } catch { throw new Error('源码清单不是有效 JSON。'); } }
        else files.push({ path: rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
      }
    }
  }
  await walk(root); files.sort((a, b) => a.path.localeCompare(b.path));
  if (manifest) {
    if (!Array.isArray(manifest.files) || manifest.files.length !== files.length) throw new Error('源码清单与实际发布文件数量不符。');
    for (let i = 0; i < files.length; i++) {
      const expected = manifest.files[i], actual = files[i];
      if (!expected || expected.path !== actual.path || expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) throw new Error(`源码清单校验失败：${actual.path}`);
    }
  }
  return files;
}
