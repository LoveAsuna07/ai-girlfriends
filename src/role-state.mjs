import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, exists } from './config.mjs';

// OpenClaw 2026.8.35 keeps a central registry in addition to the agent files.
// Only detach this project's companion entry; leave every other state table intact.
export async function archiveRoleState(home) {
  const state = paths(home).state;
  const agent = path.join(state, 'agents', 'companion');
  const agentDatabase = path.join(agent, 'agent', 'openclaw-agent.sqlite');
  const registry = path.join(state, 'state', 'openclaw.sqlite');
  let db, rows = [], archive;
  const samePath = value => path.relative(agentDatabase, path.resolve(state, value)) === '';
  try {
    if (await exists(registry)) {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(registry);
      db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_databases'").get()) {
        rows = db.prepare('SELECT agent_id, path, schema_version, last_seen_at, size_bytes FROM agent_databases WHERE agent_id = ?').all('companion').filter(row => samePath(row.path));
        const remove = db.prepare('DELETE FROM agent_databases WHERE agent_id = ? AND path = ?');
        for (const row of rows) remove.run(row.agent_id, row.path);
      }
    }
    if (await exists(agent)) {
      archive = path.join(home, 'excluded-history', `role-${Date.now()}-${crypto.randomUUID()}`);
      await fs.mkdir(path.dirname(archive), { recursive: true });
      await fs.rename(agent, archive);
    }
    db?.exec('COMMIT');
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch {}
    if (archive && !await exists(agent)) await fs.rename(archive, agent);
    throw error;
  } finally { db?.close(); }
  return {
    archive,
    async restore() {
      if (archive) {
        if (await exists(agent)) await fs.rename(agent, `${archive}-failed`);
        await fs.rename(archive, agent);
      }
      if (rows.length) {
        const { DatabaseSync } = await import('node:sqlite');
        const restoreDb = new DatabaseSync(registry);
        try {
          restoreDb.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
          const insert = restoreDb.prepare('INSERT OR REPLACE INTO agent_databases (agent_id, path, schema_version, last_seen_at, size_bytes) VALUES (?, ?, ?, ?, ?)');
          for (const row of rows) insert.run(row.agent_id, row.path, row.schema_version, row.last_seen_at, row.size_bytes);
          restoreDb.exec('COMMIT');
        } catch (error) { try { restoreDb.exec('ROLLBACK'); } catch {} throw error; }
        finally { restoreDb.close(); }
      }
    }
  };
}
