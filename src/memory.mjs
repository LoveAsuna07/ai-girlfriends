import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, exists, readJson, atomicWrite, load } from './config.mjs';
import { requireStopped } from './runtime.mjs';
import { archiveRoleState } from './role-state.mjs';

export async function memories(home) { const f = path.join(home, 'memories.json'); return await exists(f) ? readJson(f) : []; }
export async function updateMemory(home, action, value, text) {
  await requireStopped(home); const list = await memories(home); let next;
  if (action === 'remember') {
    if (!value?.trim() || value.length > 2000) throw new Error('记忆内容必须是 1–2000 字。');
    next = [...list, { id: crypto.randomUUID().slice(0, 8), text: value.trim(), source: '用户明确提交', at: new Date().toISOString() }];
  } else {
    if (!list.some(x => x.id === value)) throw new Error('未找到该记忆 ID。');
    if (action === 'correct' && (!text?.trim() || text.length > 2000)) throw new Error('纠正内容必须是 1–2000 字。');
    next = action === 'forget' ? list.filter(x => x.id !== value) : list.map(x => x.id === value ? { ...x, text: text.trim(), at: new Date().toISOString() } : x);
  }
  const c = await load(home); const epoch = crypto.randomUUID();
  // Rotate all role sessions before publishing the edited memory. Old transcripts remain outside searchable state.
  // 2026.8.35 stores sessions, transcripts and indexes inside agent/openclaw-agent.sqlite.
  // Detach the companion database registration together with the archived files.
  await archiveRoleState(home);
  await atomicWrite(path.join(home, 'memories.json'), next);
  await atomicWrite(path.join(paths(home).workspace, 'MEMORY.md'), '# 长期记忆\n仅将用户明确提交的内容作为事实。\n\n' + next.map(x => `- [${x.id}] ${x.text.replace(/[\r\n]+/g, ' ')}（${x.source}，${x.at.slice(0, 10)}）`).join('\n') + '\n');
  await atomicWrite(paths(home).config, { ...c, sessionEpoch: epoch });
  return next;
}
