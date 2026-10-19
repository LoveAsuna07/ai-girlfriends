import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { init, paths } from '../src/config.mjs';
import { archiveRoleState } from '../src/role-state.mjs';
import { createDesktopService } from '../src/desktop-service.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(process.env.COMPANION_TEST_ROOT || os.tmpdir(), 'role-registry-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await init(home);
  const state = paths(home).state, agent = path.join(state, 'agents', 'companion');
  await fs.mkdir(path.join(agent, 'agent'), { recursive: true });
  await fs.writeFile(path.join(agent, 'agent', 'openclaw-agent.sqlite'), 'old conversation fixture');
  await fs.mkdir(path.join(state, 'state'), { recursive: true });
  const registry = path.join(state, 'state', 'openclaw.sqlite');
  const db = new DatabaseSync(registry);
  db.exec('CREATE TABLE agent_databases (agent_id TEXT, path TEXT, schema_version INTEGER, last_seen_at INTEGER, size_bytes INTEGER, PRIMARY KEY (agent_id, path)); CREATE TABLE private_sentinel (value TEXT); INSERT INTO private_sentinel VALUES (\'keep credentials and unrelated state\')');
  const insert = db.prepare('INSERT INTO agent_databases VALUES (?, ?, 19, 123, 42)');
  insert.run('companion', path.join('agents', 'companion', 'agent', 'openclaw-agent.sqlite'));
  insert.run('other-agent', path.join('agents', 'other-agent', 'agent', 'openclaw-agent.sqlite'));
  db.close();
  return { home, agent, registry };
}
function registered(registry) {
  const db = new DatabaseSync(registry, { readOnly: true });
  try { return db.prepare('SELECT * FROM agent_databases ORDER BY agent_id').all(); } finally { db.close(); }
}

test('role rotation detaches its database registry entry, preserves unrelated state, and restores on rollback', async t => {
  const f = await fixture(t), before = registered(f.registry);
  const archived = await archiveRoleState(f.home);
  assert.deepEqual(registered(f.registry).map(row => row.agent_id), ['other-agent']);
  assert.equal(await fs.readFile(path.join(archived.archive, 'agent', 'openclaw-agent.sqlite'), 'utf8'), 'old conversation fixture');
  const db = new DatabaseSync(f.registry, { readOnly: true });
  assert.equal(db.prepare('SELECT value FROM private_sentinel').get().value, 'keep credentials and unrelated state'); db.close();
  await fs.mkdir(f.agent, { recursive: true }); await fs.writeFile(path.join(f.agent, 'failed-attempt'), 'retained');
  await archived.restore();
  assert.deepEqual(registered(f.registry), before);
  assert.equal(await fs.readFile(path.join(f.agent, 'agent', 'openclaw-agent.sqlite'), 'utf8'), 'old conversation fixture');
});

test('saving a role with an existing registered conversation restarts without stale registry entries', async t => {
  const f = await fixture(t); let running = true;
  const service = await createDesktopService(f.home, { hooks: {
    status: async () => ({ running }), stop: async () => { running = false; },
    start: async () => { assert.deepEqual(registered(f.registry).map(row => row.agent_id), ['other-agent']); running = true; },
    installRuntime: async () => {}
  } });
  await service.savePersona({ name: '小晴', soul: '新的角色设定', user: '新的用户偏好' });
  assert.equal(running, true);
  assert.equal((await service.snapshot()).persona.user, '新的用户偏好');
});

test('failed role restart restores the old persona, database files, and registry together', async t => {
  const f = await fixture(t), before = registered(f.registry); let running = true;
  const service = await createDesktopService(f.home, { hooks: {
    status: async () => ({ running }), stop: async () => { running = false; },
    start: async (_home, config) => {
      if (config.roleName === '失败的新角色') throw new Error('startup fixture failure');
      assert.deepEqual(registered(f.registry), before); running = true;
    },
    installRuntime: async () => {}
  } });
  const oldPersona = (await service.snapshot()).persona;
  await assert.rejects(service.savePersona({ name: '失败的新角色', soul: '新的设定', user: '新的偏好' }), /startup fixture failure/);
  assert.deepEqual((await service.snapshot()).persona, oldPersona);
  assert.deepEqual(registered(f.registry), before);
  assert.equal(running, true);
  assert.equal(await fs.readFile(path.join(f.agent, 'agent', 'openclaw-agent.sqlite'), 'utf8'), 'old conversation fixture');
});
