#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homePath, paths, init, load, readJson, atomicWrite, validateConfig, switchMode, OC_VERSION, exists } from './config.mjs';
import { localModels, testModel, cleanReply } from './providers.mjs';
import { runOC, installRuntime, runtimeEntry, prepare, start, stop, processStatus, requireStopped, setupWechat, verifyWechatOwner } from './runtime.mjs';
import { memories, updateMemory } from './memory.mjs';
import { releaseCheck } from './release.mjs';

const argv = process.argv.slice(2); let explicitHome;
const homeIndex = argv.indexOf('--home');
if (homeIndex >= 0) { explicitHome = argv[homeIndex + 1]; if (!explicitHome || explicitHome.startsWith('--')) { console.error('--home 需要目录。'); process.exit(1); } argv.splice(homeIndex, 2); }
const home = homePath(explicitHome), [command = 'help', ...args] = argv;
const print = s => console.log(s);
const help = `Local Companion · 中文 AI 陪伴（私有目录：${home}）
node src/cli.mjs [--home 源码外目录] 命令
  init                       初始化（只补缺失人物文件）
  install-runtime            隔离安装 OpenClaw ${OC_VERSION}
  doctor                     中文环境与通道检查
  models                     列出已有 Ollama 模型
  configure-api 路径.json     保存 API 配置（密钥只用环境变量）
  mode local|api             验证并切换，必须先 stop
  test-model [一句话]         直接模型测试，不等于微信接通
  chat [一句话]              OpenClaw 原生角色对话；省略则进入连续聊天
  start | stop | status      管理本项目 Gateway
  wechat setup|login|status  官方插件安装/扫码/真实状态
  memory list               查看已确认记忆
  memory remember 内容      记住用户明确提交的事实
  memory correct ID 内容    纠正；必须先 stop
  memory forget ID          遗忘并轮换旧会话；必须先 stop
  openclaw 参数...           使用本实例配置运行原生 CLI
  release-check              扫描实际源码发布清单`;

async function validateOC(c) {
  const p = paths(home), old = await exists(p.oc) ? await fs.readFile(p.oc) : null;
  const restore = async () => { if (old) await atomicWrite(p.oc, old.toString()); else await fs.rm(p.oc, { force: true }); };
  try { await runOC(home, c, ['config', 'validate'], { capture: true }); }
  catch (e) { await restore(); throw e; }
  return restore;
}
async function chatOne(c, message) {
  validateConfig(c, c.mode, process.env, true);
  const r = await runOC(home, c, ['agent', '--local', '--agent', 'companion', '--session-id', `companion-${c.sessionEpoch}`, '--message', message, '--thinking', 'off', '--json'], { capture: true, timeoutMs: c[c.mode].timeoutMs + 60000 });
  let result;
  try { result = JSON.parse(r.stdout); } catch { throw new Error('OpenClaw 返回的结果不是 JSON；请运行原生 CLI 检查。'); }
  const payloads = result.payloads || result.result?.payloads;
  if (!Array.isArray(payloads)) throw new Error('OpenClaw 未返回角色回复。');
  const texts = payloads.map(x => x.text).filter(Boolean); if (!texts.length) throw new Error('OpenClaw 返回空回复。');
  for (const text of texts) print(`${c.roleName || '晚晴'}：${cleanReply(text)}`);
}
async function main() {
  if (command === 'help' || command === '--help') return print(help);
  if (command === 'release-check') { const list = await releaseCheck(); print(`发布检查通过：${list.length} 个源码文件；无运行状态/依赖。`); for (const f of list) print(`${f.sha256}  ${f.path}`); return; }
  if (command === 'init') { const c = await init(home); await prepare(home, c); return print(`初始化完成，模式 ${c.mode}。\n私有目录：${home}\n人物/记忆：${paths(home).workspace}\n重复 init 保留已有人物与配置。`); }
  if (command === 'install-runtime') { await installRuntime(home); return print('本项目运行时已安装。未修改全局 OpenClaw。'); }
  const c = await load(home);
  if (command === 'models') return print((await localModels(c)).join('\n'));
  if (command === 'configure-api') {
    await requireStopped(home); if (!args[0]) throw new Error('请提供 API JSON 配置路径（参考 templates/api.example.json）。');
    const api = await readJson(path.resolve(args[0]));
    const keys = new Set(['baseUrl', 'model', 'keyEnv', 'contextWindow', 'maxTokens', 'timeoutMs']);
    if (Object.keys(api).some(k => !keys.has(k))) throw new Error('API 配置仅支持 baseUrl/model/keyEnv/contextWindow/maxTokens/timeoutMs；不要保存密钥或其他协议字段。');
    const next = { ...c, api }; validateConfig(next, 'api');
    let rollback;
    if (c.mode === 'api') { validateConfig(next, 'api', process.env, true); rollback = await validateOC(next); }
    try { await atomicWrite(paths(home).config, next); } catch (e) { if (rollback) await rollback(); throw e; }
    return print('API 配置已保存。协议：OpenAI-compatible Chat Completions。当前模式：' + c.mode);
  }
  if (command === 'mode') {
    await requireStopped(home); const mode = args[0];
    if (mode === 'api') print('启用 API：人物设定、相关记忆和对话上下文将发送给你配置的服务商/中转服务。此显式操作记录知情启用；不会自动云回退。');
    const next = await switchMode(home, mode, { probe: async (current, target) => { if (target === 'local' && !(await localModels(current)).includes(current.local.model)) throw new Error('指定本地模型未安装。'); return validateOC({ ...current, mode: target }); } });
    return print(`已切换为 ${next.mode} / ${next[next.mode].model}。人物和记忆保留。需要微信时运行 start。`);
  }
  if (command === 'test-model') { const r = await testModel(c, { prompt: args.join(' ') || undefined }); return print(`直接模型测试：${r.mode} / ${r.model} / ${r.elapsedMs} ms\n${r.text}\n此结果不代表 OpenClaw 或微信链路通过。`); }
  if (command === 'chat') {
    if (args.length) return chatOne(c, args.join(' '));
    const rl = createInterface({ input: stdin, output: stdout }); print(`原生 OpenClaw 角色对话 · ${c.mode} / ${c[c.mode].model} · 输入 /exit 结束`);
    try { while (true) { const message = await rl.question('你：'); if (message.trim() === '/exit') break; if (message.trim()) await chatOne(c, message); } } finally { rl.close(); } return;
  }
  if (command === 'start') { await start(home, c); return print(`Gateway 已就绪：127.0.0.1:${c.gatewayPort}，模式 ${c.mode}。日志在私有目录 logs。`); }
  if (command === 'stop') return print(await stop(home) ? '本项目 Gateway 已停止。' : '本项目 Gateway 未运行。');
  if (command === 'status') { const s = await processStatus(home); return print(`模式：${c.mode} / ${c[c.mode].model}\nGateway：${s.running ? '运行中，PID ' + s.pid : '未运行'}\n私有目录：${home}`); }
  if (command === 'memory') {
    const [action, value, ...rest] = args;
    if (action === 'list') { const list = await memories(home); return print(list.length ? list.map(x => `${x.id}  ${x.text}`).join('\n') : '尚无已确认记忆。'); }
    if (!['remember', 'correct', 'forget'].includes(action)) throw new Error('memory 支持 list/remember/correct/forget。');
    const list = await updateMemory(home, action, action === 'remember' ? [value, ...rest].filter(Boolean).join(' ') : value, rest.join(' '));
    print(`记忆已更新，共 ${list.length} 条。下次 chat/start 使用新会话。`);
    return print('旧会话移到私有 excluded-history，不会检索或自动注入；旧转录、日志、备份和微信历史仍可能保留，未宣称全链路删除。');
  }
  if (command === 'wechat') {
    if (args[0] === 'setup') return setupWechat(home, c);
    if (args[0] === 'login') { await requireStopped(home); print('请本人扫码确认。仅允许扫码所有者，成功后将核对私有账户与允许名单。'); await runOC(home, c, ['channels', 'login', '--channel', 'openclaw-weixin'], { timeoutMs: 600000 }); const state = await verifyWechatOwner(home); if (!state.restricted) throw new Error('未找到已绑定的所有者账户，未确认登录成功。'); return print('已记录单一微信账户与所有者限制；请 start 后用自己的微信发送一句话，完成收发验收。'); }
    if (args[0] === 'status') return runOC(home, c, ['channels', 'status', '--probe']);
    throw new Error('wechat 支持 setup/login/status。');
  }
  if (command === 'openclaw') { if (!args.length) throw new Error('请提供原生 OpenClaw 参数。'); return runOC(home, c, args, { timeoutMs: 600000 }); }
  if (command === 'doctor') {
    print(`Node：${process.version}（要求 >=22.23）\n配置：有效，${c.mode} / ${c[c.mode].model}\n状态目录：${home}`);
    let fail = false;
    try { const models = await localModels(c); print(`Ollama：可访问，${models.includes(c.local.model) ? '已安装 ' + c.local.model : '缺少默认模型'}`); if (!models.includes(c.local.model)) fail = true; } catch (e) { fail = true; print(`Ollama：${e.message}`); }
    if (await exists(runtimeEntry(home))) { try { const r = await runOC(home, c, ['config', 'validate'], { capture: true }); print('OpenClaw：已安装，配置 schema 验证通过。'); } catch (e) { fail = true; print(e.message); } } else { fail = true; print('OpenClaw：未安装；运行 install-runtime。'); }
    const oc = await exists(paths(home).oc) ? await readJson(paths(home).oc) : {}; print(`微信插件：${oc.plugins?.entries?.['openclaw-weixin']?.enabled ? '已启用（运行 wechat status 检查实际绑定）' : '未启用；运行 wechat setup'}`);
    try { const w = await verifyWechatOwner(home); print(`微信所有者限制：${w.restricted ? '单账户，已核对扫码所有者' : '尚无扫码账户'}`); } catch (e) { fail = true; print(`微信所有者限制：${e.message}`); }
    print(`Gateway：${(await processStatus(home)).running ? '本项目进程运行中' : '未运行'}\n微信扫码/云端真实 API：只能以各自实际验证为准。`);
    if (fail) process.exitCode = 1; return;
  }
  throw new Error(`未知命令：${command}；运行 help 查看。`);
}
main().catch(e => { console.error(`错误：${e.message}`); process.exitCode = 1; });
