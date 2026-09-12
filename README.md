# OpenHarness

桌面级 Agent Harness 统一集成服务,把散落在本机的各类桌面 AI Agent（Harness）聚合到一个入口统一管理。

## 功能

- **Harness 管理**：检测 Claude Desktop / Claude Code / Codex / Cursor / Windsurf / Trae / OpenClaw 等 Harness；启动、配置模型与 MCP 注入能力按各适配器显示
- **MCP 中心**：集中注册 MCP Server（STDIO / HTTP），批量注入到各 Harness 的配置文件（注入前自动备份原文件为 `.openharness.bak`）
- **Skills 中心**：本地/Git 导入、扫描已有 Skill、搜索与内容预览、更新、按工具同步/停用及删除；支持自定义工具和项目目录
- **模型服务**：统一配置 LLM Provider（OpenAI 兼容 / Anthropic / 火山方舟 Ark），一处配置处处可用
- **统一对话**：多模型流式对话（SSE），随时切换 Provider 与模型
- **深浅主题**：CherryStudio 风格深色/浅色主题

## 开发

```bash
npm install
npm run dev      # 开发模式
npm test         # 隔离回归测试，不读取真实密钥或调用真实模型
npm run build    # 构建
npm run test:electron # 构建后验证真实 Electron 页面、IPC、聊天保存与 PTY；使用假响应
npm run dist     # 打包安装程序（electron-builder）
```

开发环境需要 Node.js 22.12+（本次复核使用 24.14）。Windows 打包复用 node-pty 随包提供、已通过 Electron 烟雾测试的原生预编译文件，关闭重复源码重编译。新增原生依赖、升级 node-pty 或更换平台/架构时，先重新验证预编译支持；不支持时恢复重编译并安装相应工具链。

## 架构

```
src/
├── main/              # Electron 主进程
│   ├── index.js       # 窗口 + IPC + 数据存储（electron-store）
│   ├── chat.js        # 统一流式对话（OpenAI 兼容 / Anthropic SSE）
│   └── harnesses/     # Harness 适配器层（检测 / 启动 / 注入）
├── preload/           # contextBridge 安全桥接
└── renderer/          # Vue 3 + Element Plus 渲染进程
    └── src/views/     # 首页 / 对话 / Harness / 模型服务 / MCP / Skills / 设置
```

## 安全说明

### Skills 使用

侧栏打开 **Skills**，导入包含 `SKILL.md` 的文件夹，或填写 HTTPS Git 仓库地址和 Skill 子目录。Git 导入需要已安装 Git，读取默认分支；不执行 Skill 脚本。管理库位于应用 `userData/skills`，可从 Skill 详情打开完整文件夹。

点击 **同步工具**，勾选 Claude Code、Codex、Cursor、OpenCode、共享 Agents 或 OpenClaw；取消勾选即停用。**同步目录**可添加自定义工具或项目的实际 skills 目录。Windows 使用 junction，其他系统使用符号链接；链接创建失败会报错并撤销本次同步，不会静默降级为可能过期的副本。工具可能需要重新启动或新建会话才会加载变更。

**扫描本机**只扫描同步目录的直接子目录（忽略隐藏目录、插件缓存和已管理链接），导入时复制并保留原目录；已有同名目录不会自动接管或覆盖。**更新**重新读取本地来源或 Git 默认分支，替换管理库内容；源文件应保留在独立目录中。**删除**移除管理库副本和指向它的同步链接，不删除原始导入目录。单个 Skill 限 100 MB / 10000 个文件，内部链接和特殊文件会被拒绝。

功能参考 [Skills Hub](https://github.com/qufei1993/skills-hub) 的集中管理与多工具同步方式。本版未包含在线市场、标签、定时更新和批量操作。

- 渲染进程 `contextIsolation: true`，`nodeIntegration: false`，所有系统能力通过 preload 白名单 IPC 暴露
- API Key 与会话数据保存在本地 `userData`（electron-store，未额外加密）；发起对话时，请求与认证信息会发送给所选 Provider
- 注入 MCP 前自动备份目标配置文件

模型代理使用每次安装独立的随机访问令牌。升级旧版本后，请在各 Harness 的「配置模型」中重新保存并重启 Harness；旧版固定令牌不再接受。模型路由按保存的选择恢复，同名模型不能同时绑定不同提供商，未知模型会明确报错。

配置文件无法解析时会停止写入。首次 `.openharness.bak` 备份保留不覆盖，写入通过同目录临时文件替换完成。TOML 配置只修改目标字段，保存时可能规范化排版与注释。

同协议请求保留上游流式输出；OpenAI / Anthropic 跨协议转换目前先取得完整响应，再输出包含工具调用的对应 SSE 事件，不提供逐 token 实时转换。

`test-model.mjs`、`test-edit.mjs`、`test-ui.mjs` 是需手动运行的真实模型诊断，会使用本机 Provider 并可能产生费用，不属于 `npm test`。其中 UI 诊断只在内存中保存测试数据。
