const $ = id => document.getElementById(id);
let token = new URLSearchParams(location.hash.slice(1)).get('session') || sessionStorage.getItem('companion-session');
if (token) sessionStorage.setItem('companion-session', token);
history.replaceState(null, '', location.pathname);
let current, selectedMode = 'local', localBusy = false, toastTimer;
const pageNames = { home: '开始陪伴', models: '模型', persona: '角色设定', together: '更多陪伴' };
function toast(message, error = false) {
  clearTimeout(toastTimer); $('toast-message').textContent = message;
  $('toast').classList.toggle('error', error); $('toast').hidden = false;
  if (!error) toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}
async function request(route, body) {
  const response = await fetch(`/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Companion-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
  return result;
}
function navigate(page) {
  document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== `page-${page}`; });
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $('page-label').textContent = pageNames[page]; window.scrollTo(0, 0);
}
document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.page)));
function modeFields(mode) {
  selectedMode = mode;
  for (const item of ['local', 'api']) {
    $(`choose-${item}`).classList.toggle('selected', item === mode);
    $(`choose-${item}`).setAttribute('aria-pressed', String(item === mode));
    $(`${item}-fields`).hidden = item !== mode;
  }
}
function preview() {
  const name = $('role-name').value.trim() || '你的陪伴';
  $('preview-name').textContent = name;
  $('preview-monogram').textContent = [...name].at(-1);
}
function fillForms() {
  $('role-name').value = current.persona.name; $('role-soul').value = current.persona.soul; $('role-user').value = current.persona.user; preview();
  modeFields(current.mode);
  $('api-url').value = current.api?.baseUrl || ''; $('api-model').value = current.api?.model || '';
  for (const mode of ['local', 'api']) { const m = current[mode] || {}; $(mode + '-temperature').value = m.temperature ?? 0.7; $(mode + '-timeout').value = (m.timeoutMs ?? (mode === 'local' ? 180000 : 120000)) / 1000; }
  $('local-context').value = current.local.contextWindow; $('local-max').value = current.local.maxTokens;
  $('chat-split').checked = current.chat.splitReplies; $('chat-debounce').value = current.chat.debounceMs / 1000; $('chat-bubbles').value = current.chat.maxBubbles; $('chat-delay').value = current.chat.delayMs / 1000;
  $('api-context').value = current.api?.contextWindow || 32768; $('api-max').value = current.api?.maxTokens || 512;
  $('remember-key').disabled = !current.credentials.canStore;
  $('remember-key').checked = current.credentials.stored;
  $('api-key').placeholder = current.credentials.present ? '密钥已就绪，留空继续使用' : '输入你的密钥';
  $('key-note').textContent = current.credentials.warning || (current.credentials.canStore ? '加密后仅此 Windows 账户可读取；不保存则仅本次运行有效。' : '当前为浏览器测试模式，密钥仅在本次运行期间有效。');
  $('vision-enabled').checked = current.vision.enabled; $('vision-api-model').value = current.vision.apiModel;
  ensureVisionOption(current.vision.localModel); $('vision-local-model').value = current.vision.localModel;
  const p = current.proactive;
  $('proactive-enabled').checked = p.enabled; $('proactive-idle').value = p.idleMinutes; $('proactive-interval').value = p.intervalMinutes; $('proactive-limit').value = p.dailyLimit;
  $('proactive-start').value = p.start; $('proactive-end').value = p.end; $('proactive-zone').value = p.timeZone; $('proactive-prompt').value = p.prompt;
}
function ensureVisionOption(model) { if (![...$('vision-local-model').options].some(x => x.value === model)) $('vision-local-model').add(new Option(model + '（当前配置）', model)); }
function renderStatus() {
  const alive = current.gateway.running, running = alive && current.gateway.ready, busy = localBusy || current.operation.busy;
  document.body.classList.toggle('busy', busy);
  $('side-status').textContent = current.gateway.suppressed ? '微信连接已暂停' : current.gateway.wechatFailed ? '微信连接异常' : current.gateway.uncertain ? '状态待确认' : running ? '陪伴正在运行' : alive ? '服务准备中…' : '陪伴尚未启动';
  $('side-dot').classList.toggle('online', running);
  $('hero-status').classList.toggle('online', running);
  $('hero-status').querySelector('span').textContent = running ? '陪伴已在线' : '准备好时，就开始吧';
  $('hero-status').querySelector('.dot').classList.toggle('online', running);
  $('start-button').disabled = busy || alive;
  $('start-button').querySelector('span').textContent = busy ? '请稍候…' : running ? '陪伴正在运行' : alive ? '服务准备中…' : '一键启动陪伴';
  $('stop-button').hidden = !alive; $('stop-button').disabled = busy;
  $('operation-text').textContent = current.operation.message || (busy ? '正在处理，请稍候…' : current.gateway.suppressed ? '异常重启保护暂停了微信连接。请停止陪伴，等待 5 分钟后重新启动；若再次出现，请检查私有日志。' : current.gateway.wechatFailed ? '微信连接异常，请检查网络和私有日志后停止并重新启动。' : running ? (current.wechatReady ? '你可以回到微信，和她聊聊今天。' : '服务已就绪，首次使用请先完成微信扫码绑定。') : '电脑保持开机，陪伴就能持续在线。');
  $('home-name').textContent = current.persona.name; $('home-monogram').textContent = [...current.persona.name].at(-1);
  $('hero-description').textContent = `${current.persona.name}已准备好。启动陪伴后，\n就可以回到微信和她聊聊。`;
  const model = current.mode === 'local' ? current.local.model : current.api?.model;
  $('home-model').textContent = model || '尚未选择'; $('home-model').title = model || '';
  $('home-model-detail').textContent = current.mode === 'local' ? '本地运行 · Ollama' : 'API 服务 · 自定义接口';
  $('privacy-text').textContent = current.mode === 'local' ? '本地模式' : 'API 模式';
  $('test-description').textContent = `当前已应用：${model}。测试会发送一句简短问候。`;
  $('vision-local-fields').hidden = current.mode !== 'local'; $('vision-api-fields').hidden = current.mode !== 'api';
  const ps = current.proactiveStatus;
  $('proactive-runtime').textContent = !current.proactive.enabled ? '主动联系已关闭。' : !running ? '陪伴服务未运行，主动联系已暂停。' : `${ps.reason}。今日尝试 ${ps.attemptsToday}/${current.proactive.dailyLimit} 次。${ps.lastResult ? '\n' + ps.lastResult : ''}`;
  for (const id of ['save-model', 'save-persona', 'test-model', 'refresh-models', 'reset-persona', 'save-features', 'test-vision']) $(id).disabled = busy;
}
async function refreshState(forms = false) {
  current = await request('state'); renderStatus(); if (forms) fillForms();
}
async function refreshModels() {
  const selected = $('local-model').value || current?.local.model;
  try {
    const result = await request('models'); $('local-model').replaceChildren();
    for (const model of result.models) $('local-model').add(new Option(model, model));
    if (result.models.includes(selected)) $('local-model').value = selected;
    else if (result.models.includes(current.local.model)) $('local-model').value = current.local.model;
    $('models-note').textContent = result.models.length ? `找到 ${result.models.length} 个已下载模型。只会使用你明确选择的模型。` : '暂时没有已下载的模型，请先在 Ollama 中下载。';
  } catch (e) { $('local-model').replaceChildren(new Option(current?.local.model || 'Ollama 未连接', current?.local.model || '')); $('models-note').textContent = e.message; }
}
async function refreshVisionModels() {
  const selected = $('vision-local-model').value || current.vision.localModel;
  try {
    const { models } = await request('vision-models'); $('vision-local-model').replaceChildren();
    for (const model of models) $('vision-local-model').add(new Option(model, model));
    ensureVisionOption(selected); $('vision-local-model').value = selected;
    $('vision-models-note').textContent = models.length ? `已确认 ${models.length} 个本机图片模型。推荐 qwen3.5:2b，加载更轻。` : '未找到图片模型，请先在 Ollama 下载支持视觉的模型。';
  } catch (e) { $('vision-models-note').textContent = e.message; }
}
async function action(route, body = {}, { forms = false } = {}) {
  if (localBusy) return;
  localBusy = true; renderStatus();
  try {
    const result = await request(route, body);
    if (route === 'test') { $('test-result').hidden = false; $('test-result').textContent = `${result.message}\n${result.reply}`; }
    if (route === 'vision-test') { $('vision-result').hidden = false; $('vision-result').textContent = `${result.message}\n${result.reply}`; }
    toast(result.message); await refreshState(forms);
    if (route === 'model') $('api-key').value = '';
  } catch (e) { toast(e.message, true); }
  finally { localBusy = false; try { await refreshState(false); } catch {} if (current) renderStatus(); }
}
$('start-button').addEventListener('click', () => action('start'));
$('stop-button').addEventListener('click', () => action('stop'));
$('choose-local').addEventListener('click', () => modeFields('local'));
$('choose-api').addEventListener('click', () => modeFields('api'));
$('refresh-models').addEventListener('click', refreshModels);
$('role-name').addEventListener('input', preview);
$('reset-persona').addEventListener('click', () => { $('role-name').value = current.persona.name; $('role-soul').value = current.persona.soul; $('role-user').value = current.persona.user; preview(); });
$('save-persona').addEventListener('click', () => action('persona', { name: $('role-name').value, soul: $('role-soul').value, user: $('role-user').value }, { forms: true }));
$('save-model').addEventListener('click', () => action('model', { mode: selectedMode, model: $('local-model').value, local: { temperature: Number($('local-temperature').value), contextWindow: Number($('local-context').value), maxTokens: Number($('local-max').value), timeoutMs: Number($('local-timeout').value) * 1000 }, api: { baseUrl: $('api-url').value, model: $('api-model').value, key: $('api-key').value, remember: $('remember-key').checked, temperature: Number($('api-temperature').value), timeoutMs: Number($('api-timeout').value) * 1000, contextWindow: Number($('api-context').value), maxTokens: Number($('api-max').value) } }, { forms: true }));
$('test-model').addEventListener('click', () => action('test'));
$('save-features').addEventListener('click', () => action('features', { chat: { splitReplies: $('chat-split').checked, debounceMs: Math.round(Number($('chat-debounce').value) * 1000), maxBubbles: Number($('chat-bubbles').value), delayMs: Math.round(Number($('chat-delay').value) * 1000) }, vision: { enabled: $('vision-enabled').checked, localModel: $('vision-local-model').value, apiModel: $('vision-api-model').value.trim() }, proactive: { enabled: $('proactive-enabled').checked, idleMinutes: Number($('proactive-idle').value), intervalMinutes: Number($('proactive-interval').value), dailyLimit: Number($('proactive-limit').value), start: $('proactive-start').value, end: $('proactive-end').value, timeZone: $('proactive-zone').value.trim(), prompt: $('proactive-prompt').value } }, { forms: true }));
$('test-vision').addEventListener('click', async () => {
  if (localBusy) return;
  const file = $('vision-file').files[0];
  if (!file || file.size > 10485760 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { toast('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。', true); return; }
  try { const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); await action('vision-test', { base64: url.split(',')[1] }); }
  catch { toast('图片读取失败，请重新选择。', true); }
});
$('dismiss-toast').addEventListener('click', () => { $('toast').hidden = true; });
(async () => {
  try { if (!token) throw new Error('请通过桌面程序打开控制台。'); await refreshState(true); await refreshModels(); await refreshVisionModels(); }
  catch (e) { toast(e.message, true); $('side-status').textContent = '连接失败'; $('start-button').disabled = true; }
  setInterval(() => { if (token) refreshState(false).catch(() => { $('side-status').textContent = '连接暂时中断'; }); }, 2500);
})();
