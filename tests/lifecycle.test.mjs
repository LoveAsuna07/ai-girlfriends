import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { gatewayReadiness } from '../src/runtime.mjs';

test('readiness authenticates and rejects a live Gateway with suppressed or failing WeChat', async t => {
  const base = process.env.COMPANION_TEST_ROOT || os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const home = await fs.mkdtemp(path.join(base, 'readiness-test-'));
  await fs.writeFile(path.join(home, 'gateway-token'), 'local-test-only');
  let body = { ready: true, suppressed: ['openclaw-weixin'] }, status = 200;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/readyz');
    assert.equal(req.headers.authorization, 'Bearer local-test-only');
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(home, { recursive: true, force: true }); });
  const c = { gatewayPort: server.address().port };
  assert.deepEqual(await gatewayReadiness(home, c), { ready: false, suppressed: true, wechatFailed: false });
  body = { ready: false, failing: ['openclaw-weixin'] }; status = 503;
  assert.deepEqual(await gatewayReadiness(home, c), { ready: false, suppressed: false, wechatFailed: true });
  body = { ready: true, failing: [] }; status = 200;
  assert.equal((await gatewayReadiness(home, c)).ready, true);
  body = { status: 'ok' };
  assert.equal((await gatewayReadiness(home, c)).ready, false);
});
