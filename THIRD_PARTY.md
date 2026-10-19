# 第三方与许可

本仓库 MIT 许可证仅涵盖本项目启动器、原创人物模板和测试。源码包不附带下列程序、模型、依赖或用户数据；Windows 便携版包含 Electron、Node.js 与 npm，详见文末说明。独立安装的第三方程序及其间接依赖遵守各自许可证；安装目录中有原始 LICENSE 与第三方声明。

| 项目 | 本次核验版本 | 来源 | 说明 |
| --- | --- | --- | --- |
| Node.js | 22.23.2 | https://nodejs.org/ | 已有系统运行时；不在源码包内 |
| OpenClaw | 2026.8.35 | https://github.com/openclaw/openclaw / https://www.npmjs.com/package/openclaw | 独立安装，MIT；源码未复制其实现 |
| 腾讯微信通道 | @tencent-weixin/openclaw-weixin 2.4.10 | https://github.com/Tencent/openclaw-weixin / https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin | 腾讯维护，独立安装，MIT；扫码由用户完成 |
| Ollama | 复用已有 HTTP 服务 | https://github.com/ollama/ollama | 独立程序，MIT；不更改配置或下载模型 |
| qwen3:8b | 已有 Q4_K_M，8.2B | https://ollama.com/library/qwen3:8b / https://huggingface.co/Qwen/Qwen3-8B | Qwen 模型条款以原发布说明为准，不在本包分发权重 |

参考官方接口文档：

- [OpenClaw Ollama](https://docs.openclaw.ai/providers/ollama)
- [OpenClaw WeChat](https://docs.openclaw.ai/channels/wechat)
- [腾讯插件源码](https://github.com/Tencent/openclaw-weixin)
- [Ollama API](https://docs.ollama.com/api/chat)

线上文档可能晚于固定版本。本项目以实际安装的 CLI 帮助、schema 验证与集成测试为依据。新版本可能更改配置字段，升级前请独立验证。
# 桌面版补充

桌面控制台使用 Electron 44.9.0；便携包包含 Electron/Chromium 原始 LICENSE 与 LICENSES.chromium.html，以及 Node.js 和 npm 的附带许可文件。Electron 使用 MIT，Chromium 和内含组件遵守各自附带许可。Node 22.23.2 与 npm 在便携包 resources/node 下分发。Windows 密钥加密经 Electron safeStorage 调用。

Playwright 仅为开发测试工具，不包含在用户桌面程序中。界面图形为本项目 SVG/CSS 原创图形，字体采用 Windows 本机已安装字体，不另行分发字体文件。

