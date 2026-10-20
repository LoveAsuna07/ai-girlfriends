# 源码导读

建议阅读顺序：本文件 → config.mjs → runtime.mjs / supervisor.mjs → desktop-service.mjs → chat.mjs / wechat-adapter.mjs。先看边界和调用关系，再读微信插件内部实现。

## 一次操作如何走完

桌面按钮 → desktop/ui/app.js → src/desktop-server.mjs 的本机认证接口 → src/desktop-service.mjs 校验、保存、重启 → src/runtime.mjs → src/supervisor.mjs → OpenClaw。

微信消息 → 腾讯插件 monitor → 本项目 wechat-adapter.mjs 在模块加载时接入 → chat.mjs 按账户和发送者合并文本 → 腾讯原生鉴权、媒体处理和 OpenClaw 推理 → chat.mjs 清理协议标签、分条等待 → 腾讯原生发送。

模型测试按钮走 providers.mjs，普通微信聊天走 OpenClaw。修改测试接口不会自动修改微信推理链路。

## 文件职责

| 文件 | 负责什么 |
| --- | --- |
| src/config.mjs | 配置校验、工作区初始化、生成 OpenClaw 配置 |
| src/runtime.mjs | 隔离环境、安装运行时、启动与停止、就绪状态、微信所有者检查 |
| src/supervisor.mjs | 持有准确子进程、私有控制接口、主动联系定时器 |
| src/gateway-control.mjs | 将私有 IPC 停止请求交给 Gateway 清理流程，安装微信适配 |
| src/chat.mjs | 连发合并、按会话串行处理、输出清理、分条、取消 |
| src/wechat-adapter.mjs | 接入固定腾讯插件 2.4.10 的两处消息入口；不修改第三方文件 |
| src/desktop-service.mjs | 桌面业务、双模型参数、密钥保存、修改失败恢复 |
| src/desktop-server.mjs | 只监听本机的桌面接口、会话认证与静态页面 |
| src/providers.mjs | Ollama 元数据、模型连接测试、图片测试 |
| src/vision-cli.mjs | 受限图片预处理，不允许任意路径或主机工具 |
| src/proactive.mjs | 免打扰、间隔、限额、会话有效性与投递去重 |
| src/memory.mjs | 明确提交的记忆增删改，不自动把对话当事实 |
| src/role-state.mjs | 人物变更时归档会话数据库，同步撤销登记并支持恢复 |
| src/release.mjs | 发布内容白名单、凭据检查、清单校验 |
| src/cli.mjs | 命令行入口 |
| desktop/main.cjs | Electron 窗口、系统密钥加密、关闭行为 |
| desktop/ui/ | 中文界面及交互 |
| templates/persona/ | 面向所有用户的角色模板，不放个人姓名和偏好 |
| templates/runtime/ | 固定 OpenClaw 依赖与锁文件 |
| scripts/ | 桌面构建、源码打包、Windows 启动与微信绑定 |

## 修改功能时先看哪里

- 提问与说话风格：templates/persona/SOUL.md；个人已保存的设定在私人 workspace，不会被新模板自动覆盖。
- 微信回复清理、拆条与等待：chat.mjs；接入点在 wechat-adapter.mjs。
- 本地 / API 参数：config.mjs、desktop-service.mjs、desktop/ui/app.js。
- 配置变更后无响应：runtime.mjs、supervisor.mjs、role-state.mjs，结合私人日志。
- 主动联系：proactive.mjs。当前不解析用户“我在忙”等自然语言为持久暂停指令；不能将这一能力写成已经实现。
- 添加新页面或设置：desktop-server.mjs → desktop-service.mjs → desktop/ui/。

## 运行检查

单元测试：npm test。

有意义的独立集成测试：
- tests/chat-native-smoke.mjs：真实腾讯插件和 OpenClaw，微信与模型服务器全部模拟在本机。
- tests/chat-ui-smoke.mjs：界面参数、切换、节奏保存与刷新。
- tests/role-restart-smoke.mjs：已有聊天记录时连续保存角色，核对正常停止和模型参数。
- tests/vision-inbound-smoke.mjs：原生入站图片预处理。
- tests/desktop-native-smoke.mjs：Electron 与系统加密保存。

环境变量 COMPANION_RUNTIME 指向安装 OpenClaw 的目录；COMPANION_TEST_ROOT 指向源码外测试目录；浏览器测试另需 COMPANION_PLAYWRIGHT。测试不是手机微信实际验收。
