// IPC belongs to the supervisor's exact child, never to a PID read from disk.
// Windows kill() uses TerminateProcess and cannot invoke OpenClaw's cleanup.
let requested = false;
let timer;
const home = process.env.OPENCLAW_HOME;
if (home) await (await import('./wechat-adapter.mjs')).installWechatAdapter(home);
function stopWhenReady() {
  if (process.listenerCount('SIGTERM') > 0) {
    clearInterval(timer);
    process.emit('SIGTERM');
  } else if (!timer) {
    timer = setInterval(stopWhenReady, 100);
    timer.unref();
  }
}
function requestStop() {
  if (requested) return;
  requested = true;
  globalThis[Symbol.for('local-companion.chat')]?.close();
  stopWhenReady();
}
process.on('message', message => {
  if (message?.type === 'companion-stop') requestStop();
});
process.on('disconnect', requestStop);
