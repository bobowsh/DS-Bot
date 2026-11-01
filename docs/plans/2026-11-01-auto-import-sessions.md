# 自动导入系统中已有 dsh 的会话数据

- 日期：2026-11-01
- 状态：已实施

## 为什么

用户安装 DS Bot 桌面应用后，如果系统中已经安装过其他 dsh（用户的 `~/.dsh`），希望**自动**把他的历史会话数据导入到新的 dsbot 会话中，而不是让用户手动操作。数据格式可能是老版本的格式，需要兼容。

参考：[桌面应用](2026-10-16-desktop-app.md)「首次启动和导入」、[固定数据位置与导入提示](2026-11-01-fixed-data-location.md)。

## 调研结果

### dsh-chat-import 插件

- 版本：v0.26.3
- 位置：作为 app 的内置 bundle 打进安装包（`app/node_modules/dsh-chat-import/`）
- 能力：导入 25+ 种 AI coding agents 的会话历史（claude-code、codex、chatgpt、cursor、gemini、grokbuild、qoder、vibe、kimi、trae、workbuddy 等），包括老版本格式
- 工具：提供 `import_chat` 工具
- 结构：
  - `cordis.patch.yml`：bundle patch，挂载 `- insert: [{ id: import-claude, name: dsh-chat-import }]`
  - `lib/tools.mjs`：工具定义
  - `lib/import-core.mjs`：导入核心
  - `lib/discovery.mjs`：发现会话
  - `client.js`：web 平台 UI（面板，手动导入）
  - `bin/dsh-chat-import.mjs`：CLI
- 导入记录：`~/.dsh/dsh-chat-import/imports.json`

### 当前导入逻辑

- `app/src/import.mjs`：
  - `findTeam(from)`：在用户的 `~/.dsh` 里找 Bot 团队（`bot/state.json`）
  - `copySessions()`：复制会话
  - `newerSessions()`：检测会话格式是否比锁定版新
- `app/src/first-run.mjs`：
  - `chooseLocations()`：首启选位置

### 关键差异

- 现有导入逻辑导入的是「Bot 团队」（`state.json`、`bots`、`rooms`），不是「会话数据」
- 新需求导入的是「历史会话数据」（`sessions/` 目录），格式可能老
- dsh-chat-import 的 `import_chat` 工具可以导入多种格式的会话（包括 dsh 格式）

## 已定的行为

### 1. 集成方式：作为 bundle 挂载，UI 保留

dsh-chat-import 作为内置插件打进 app，像 ds-bot 一样：

- `app/package.json` 的 `dependencies` 加 `"dsh-chat-import": "0.26.3"`（npm 安装，`package-lock.json` 一并提交）
- `app/src/profile.mjs` 的 `BUNDLES` 加 `'dsh-chat-import'`
- 插件**自带的面板 UI 一并加载**：界面上有手动导入的按钮，用户随时可以自己再导一遍
- `import_chat` 工具照常注册，模型链路不受影响
- 插件在 `dependencies` 里，因此受安装锚（`INSTALL_ANCHOR`）保护，不会被当作可移除的第三方插件清掉

**这条是用户 2026-11-01 拍板的**：界面上有现成的导入按钮，用户看着也放心，没必要藏起来。初稿曾计划用行级 `disabled` 禁掉 UI、只留工具；该方案已废弃，理由见「变更」。

### 2. 自动导入

- 首启时检测系统中是否有其他 dsh 的会话数据（`~/.dsh` 或 `DSH_HOME` 环境变量指向的位置）
- 检测到就自动导入，不弹框问要不要
- 导入过程显示进度（复制中…）
- 导入失败不阻塞启动，显示错误信息，用户可重试
- 数据格式兼容：dsh-chat-import 支持 25+ 种格式（含 grokbuild、qoder、vibe 等老版本），转换由插件完成

自动导入在 Host 进程内执行：插件的 `chatImport` 服务由 `ctx.provide('chatImport', …)` 提供，只活在这个进程里，app 主进程拿不到它，所以导入逻辑放在 ds-bot 插件内（`ds-bot/src/host/auto-import.js`），在 startup 阶段扫描并导入，失败只记日志，不阻塞启动。

### 3. 删除 DSH_HOME 环境变量

导入完成后，删除 Windows 环境变量 `DSH_HOME`：

- **用户级**：`HKCU\Environment` 里的 `DSH_HOME` 值
- **系统级**：`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` 里的 `DSH_HOME` 值
- 两个都删。系统级删除需要管理员权限：权限不够时跳过并提示用户手动删，不阻塞启动
- 删除后广播 `WM_SETTINGCHANGE`，让已经运行的程序立刻看到变化（否则它们要到下次启动才生效）
- **只删注册表里的那一个值，不动 `~/.dsh` 目录本身**：目录和里面的数据完整保留，只是系统不再通过环境变量指向它

变量值被删掉之后，用户自己跑 dsh 会回到它默认的数据目录；想继续用原来那份，把 `DSH_HOME` 指回去即可，数据一直都在。

## 不做什么

- 不删除用户 `~/.dsh` 的原始数据（除非用户明确要求）
- 不修改 dsh-chat-import 插件的源码
- 不删用户 `~/.dsh` 目录，只删指向它的环境变量

## 已知限制

- 系统级 `DSH_HOME` 环境变量删除需要管理员权限，first-run 时权限不够时需跳过并提示。
- 老版本格式的兼容性依赖 dsh-chat-import 的转换器。
- 自动导入走的是插件的批量导入通道，导入结果的明细在插件自己的面板里看。

## 变更

- 2026-11-01：初稿，方案已定（三个关键决策：方案 A 集成、自动导入、删除用户级+系统级 DSH_HOME 环境变量）。
- 2026-11-01：用户拍板**保留插件自带的 UI**（界面上有手动导入按钮）。初稿的「行级 `disabled` 禁掉 UI、只留 `import_chat` 工具」废弃；改为插件直接作为 bundle 挂载、UI 与工具同时可用，头less 包装模块与 app 侧的 overlay patch 都不再需要。
- 2026-11-01：补记「删 DSH_HOME」只删注册表里的环境变量值，不动 `~/.dsh` 目录；删除后广播 `WM_SETTINGCHANGE`。
