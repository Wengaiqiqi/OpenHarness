# OpenHarness

桌面级 Agent Harness 统一集成服务 —— 参考 CherryStudio 的产品设计，把散落在本机的各类桌面 AI Agent（Harness）聚合到一个入口统一管理。

## 功能

- **Harness 管理**：自动扫描本机已安装的桌面级 Agent（Claude Desktop / Cursor / Windsurf / Trae / VS Code / CherryStudio / OpenClaw），支持一键启动、打开配置、注入 MCP
- **MCP 中心**：集中注册 MCP Server（STDIO / HTTP），批量注入到各 Harness 的配置文件（注入前自动备份原文件为 `.openharness.bak`）
- **模型服务**：统一配置 LLM Provider（OpenAI 兼容 / Anthropic / 火山方舟 Ark），一处配置处处可用
- **统一对话**：多模型流式对话（SSE），随时切换 Provider 与模型
- **深浅主题**：CherryStudio 风格深色/浅色主题

## 开发

```bash
npm install
npm run dev      # 开发模式
npm run build    # 构建
npm run dist     # 打包安装程序（electron-builder）
```

## 架构

```
src/
├── main/              # Electron 主进程
│   ├── index.js       # 窗口 + IPC + 数据存储（electron-store）
│   ├── chat.js        # 统一流式对话（OpenAI 兼容 / Anthropic SSE）
│   └── harnesses/     # Harness 适配器层（检测 / 启动 / 注入）
├── preload/           # contextBridge 安全桥接
└── renderer/          # Vue 3 + Element Plus 渲染进程
    └── src/views/     # 首页 / 对话 / Harness / 模型服务 / MCP / 设置
```

## 安全说明

- 渲染进程 `contextIsolation: true`，`nodeIntegration: false`，所有系统能力通过 preload 白名单 IPC 暴露
- API Key 与会话数据保存在本地 `userData`（electron-store），不上传任何服务器
- 注入 MCP 前自动备份目标配置文件
