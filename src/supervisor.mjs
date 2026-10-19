// Holds the exact ChildProcess handle; shutdown never acts on a saved/reused PID.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { atomicWrite, paths } from './config.mjs';
const [home, entry, port] = process.argv.slice(2);
const supervisorId = crypto.randomUUID(), controlToken = crypto.randomBytes(32).toString('hex');
let child, closing = false;
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${controlToken}`) { res.writeHead(403).end(); return; }
  if (req.method === 'GET' && req.url === '/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ supervisorId, running: child?.exitCode === null && !closing })); return; }
  if (req.method === 'POST' && req.url === '/stop') { closing = true; res.end('stopping'); child?.kill(); return; }
  res.writeHead(404).end();
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
child = spawn(process.execPath, [entry, 'gateway', 'run', '--port', port, '--bind', 'loopback'], { cwd: home, env: process.env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', err => { console.error(err.message); process.exitCode = 1; cleanup(); });
child.on('close', () => cleanup());
async function cleanup() { server.close(); await fs.rm(paths(home).pid, { force: true }); }
await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
await atomicWrite(paths(home).pid, { pid: child.pid, supervisorPid: process.pid, supervisorId, controlToken, controlPort: server.address().port, entry, home, port: Number(port), startedAt: new Date().toISOString() });
process.on('SIGTERM', () => { closing = true; child.kill(); });
