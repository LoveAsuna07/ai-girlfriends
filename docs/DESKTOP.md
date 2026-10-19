# Windows 桌面控制台

版本：0.2.1 · 日期：2026-10-19

## 使用

在桌面版文件夹双击 `Local Companion.exe`。界面直接操作原有项目：

首次绑定微信：先停止服务，双击同目录 `微信绑定.cmd`，本人扫码确认后再启动陪伴。完整安装与操作步骤见 [README](../README.md)。

| 页面 | 操作 | 生效方式 |
| --- | --- | --- |
| 开始陪伴 | 一键启动、停止、查看状态 | 启动时确认本地模型/密钥，准备环境，等待 Gateway 健康检查通过 |
| 模型 | 本地模型下拉选择、API 设置、测试当前连接 | 先在独立目录校验目标配置；若当前运行则停止并重启，失败时恢复原设置并尝试恢复原服务 |
| 角色设定 | 名字、性格/相处提示词、关于你的资料 | 名字同步到人物和 agent 显示名；轮换旧角色会话，保留长期记忆，运行时自动重启 |

接口测试只测试已经应用的模型。填写 API 不会自动请求计费服务；点击“测试当前模型”或通过微信实际聊天时才进行模型调用。启用 API 会把必要人物、记忆和上下文交给该服务商，界面中已直接说明。

本地模式不会自动转到云端。模型列表只使用本机已下载标签，不擅自下载新模型。第一次准备 OpenClaw 可能花几分钟，冷启动也可能需要等待，期间按钮显示进行中。

## 数据与关闭窗口

桌面版复用 CLI 的 COMPANION_HOME 私有目录；本次交付的 `local-launch.json` 仅包含本机数据和运行时路径，不含账号、聊天或密钥。此文件与源码分别打包，移动到另一台电脑且原路径不存在时，采用该账户默认私有目录重新初始化。

角色资料保存至 workspace/IDENTITY.md、SOUL.md、USER.md。长期记忆仍通过原有 memory CLI 管理；保存角色不会把临时聊天自动晋升为事实。旧角色 SQLite 会话移入 excluded-history，日志和旧归档并不自动抹除。

选择加密保存时，密钥以系统加密后的值保存为私有 `desktop-key.enc.json`，只通过后台进程和系统加密桥读取。界面状态接口只返回密钥是否就绪，不返回原文。重新打开应用后，可以恢复同一 Windows 账户的已保存密钥；不勾选则只在本次应用进程内使用。

关闭窗口时，如果服务已启动，应用会询问保留服务或停止并退出。保留服务后仍可在微信聊天，电脑须保持开机联网。桌面窗口与 Gateway 分别管理生命周期，停止只作用于本项目实例。

## 架构

```text
Electron 桌面窗口（隔离、无 Node 权限）
   ↕ 本机随机端口 + 每次启动随机会话令牌
Node.js 桌面服务
   ├─ 复用项目 config / runtime / providers
   ├─ 独立临时目录校验 → 原配置备份 → 更新/重启 → 失败恢复
   └─ Electron safeStorage 加密桥（进程间通信，不向页面暴露原文）
       ↕
OpenClaw Gateway → Ollama / 自定义 API → 微信通道
```

只服务随包的本地页面，所有 API 校验请求来源和会话令牌，禁止跨域。Electron 禁用 Node 集成、启用 contextIsolation 和 sandbox，拒绝外部导航和新窗口。页面不通过 CDN 加载资源。

本次分发 Electron 44.9.0、Node 22.23.2，以及 npm；OpenClaw 继续使用固定的运行时锁文件。必须保留 Electron 和 Node 的附带许可文件。

## 从源码开发和构建

准备单独的工具目录安装 Electron（不要把依赖和构建产物提交进源码仓库）：

```powershell
npm install --prefix 'D:\CompanionBuildTools' --save-exact electron@44.9.0 playwright
node 'D:\CompanionBuildTools\node_modules\electron\install.js'
$env:COMPANION_ELECTRON = 'D:\CompanionBuildTools\node_modules\electron\dist\electron.exe'
npm run desktop
```

Electron 新版本 npm 包可能需要显式执行 install.js 才下载二进制。Node 要选择 README 列出的 OpenClaw 兼容版本。

构建便携文件夹（输出目录须不存在）：

```powershell
node scripts/build-desktop.mjs 'D:\CompanionBuildTools\node_modules\electron\dist' '你的Node目录\node.exe' 'D:\CompanionDesktop'
```

构建时会复制 Electron、项目运行文件、Node 和同目录的 npm。最后可选的两个参数分别为本机私有数据目录和 OpenClaw 运行时目录，用于本机免配置启动；省略则新建默认独立实例。源码包不包含模型、密钥、真实人物数据或完整运行环境。

## 测试

- `npm test`：原有核心测试 + 桌面服务测试。
- `node tests/desktop-ui-smoke.mjs`：真实 OpenClaw、Ollama、无头 Chrome 的按钮联调，使用独立临时角色；需要设置 COMPANION_PLAYWRIGHT、COMPANION_RUNTIME、COMPANION_TEST_ROOT，可选 COMPANION_PREVIEW。
- `node tests/desktop-native-smoke.mjs`：真实 Electron 窗口、Windows 密钥加密保存与重开恢复；设置 COMPANION_ELECTRON、COMPANION_PLAYWRIGHT、COMPANION_RUNTIME、COMPANION_TEST_ROOT。

Playwright 仅用于开发测试，不分发给最终用户。实际测试结果见 VALIDATION.md。
