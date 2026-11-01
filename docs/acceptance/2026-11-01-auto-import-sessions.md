# 需求三「自动导入系统中已有 dsh 的会话数据」验收报告

- 验收人：小饼干（前端开发）
- 日期：2026-11-01（开发 18:25–19:20；E 盘复跑回归 19:28–19:32）
- 被测：`E:\dsbot-work\DS-Bot` dev HEAD **`b289357`**（含需求三提交 `25ea261`（ds-bot 侧）、`cb5c3c9`（app 侧）；合并提交 `1aeda59`）
- 环境：Windows，node v24.14.1，E 盘本地工作区
- 设计文档：`docs/plans/2026-11-01-auto-import-sessions.md`
- 独立验证脚本：worktree 期 `tmp\verify-headless.mjs`（包装模块对照实验）；测试文件 `ds-bot/test/auto-import.test.js`（7 条）、`app/test/auto-import.test.mjs`（13 条）

## 结论

**需求三 8 条验收标准中 6 条已验证通过，2 条留待装机环节验证**（真机端到端导入、系统环境变量真删）。UI 关闭方案经**对照实验**证明可行，是本次最关键的一关。

| # | 标准 | 状态 |
|---|---|---|
| 1 | dsh-chat-import 打进 app（package.json + lock 都有、BUNDLES 有） | ✅ 通过 |
| 2 | UI 关闭但 `import_chat` 工具可用（**实测**） | ✅ 通过（对照实验） |
| 3 | 首启检测到会话数据自动导入，不弹框 | ⚠️ 链路已实现并单测覆盖；**真机端到端待装机验证** |
| 4 | 导入显示进度、失败不阻塞启动 | ✅ 通过 |
| 5 | 用户级 + 系统级 DSH_HOME 都删（权限不够跳过并提示） | ⚠️ 逻辑已单测覆盖四种分支；**注册表真删待装机验证** |
| 6 | `~/.dsh` 目录本身不动 | ✅ 通过 |
| 7 | 无回归 | ✅ 通过 |
| 8 | 新增测试覆盖上述行为 | ✅ 通过（新增 20 条） |

## 已验证通过

### 1. dsh-chat-import 打进 app ✅

- `app/package.json` dependencies 新增 `"dsh-chat-import": "0.26.3"`；`app/src/profile.mjs` 的 `BUNDLES` 引入 headless 包装模块。
- **`package-lock.json` 已同步提交**，增量干净：仅新增 `node_modules/dsh-chat-import` 与 `node_modules/fzstd` 两条，**零删包**（`git diff --stat` = +30/−1，唯一删除是某包的 `"dev": true` 标记）。

> **踩坑记录（重要，流程已更新）**：`npm install --legacy-peer-deps` 虽能装上（npm 对预发布版本号的比较有 bug，`>=0.1.5-rc.1` 不接受 `0.2.1-rc.4`），但它会**重新求解整棵树**，把 `@electron/windows-sign`、`electron-winstaller` 等 17 个打包必需依赖从 lock 里剔掉，直接毁掉打包。正确做法：**装包**可用 `--legacy-peer-deps`，**更新 lock 必须** `npm install --package-lock-only`。此结论由本人在实测中发现并拦下，经核对 lockfile diff 确认。

### 2. UI 关闭但 `import_chat` 工具可用（对照实验）✅

**这是需求三最难的一关。** 先排除了一条看起来可行的路：小柚（DSH开发）核实 `cordis-plugin-loader` 的 `refresh()` 在 `disabled` 时直接 return（`lib/index.js:363`），`dsh-client-modules` 那边 `entry.disabled` 也整行跳过（`lib/index.js:855`）——**行级 `disabled` 会把 `import_chat` 工具一起关掉**，不可用。

采用方向：**不声明 `dsh.client` 的包装模块**承载同一份服务端插件。

实现 `app/src/chat-import-headless.mjs`（仅一行，未改插件源码）：

```js
export { apply, inject, name, Config } from 'dsh-chat-import'
```

原理：`dsh-client-modules` 的 `locatePkgJson()` 沿模块路径**向上查找 `package.json` 里的 `dsh.client` 声明**。包装模块位于 `app/src/` 下，命中 `app/package.json`，而该文件没有 `dsh.client` → 无 UI 可加载；服务端插件照常 apply。

**对照实验**（真实 profile 启动，临时 `DSH_HOME`，全程未触碰真实 `~/.dsh`）：

| 挂载方式 | `import_chat` 工具 | `client-modules` 中有 chat-import（=UI 会加载） |
|---|---|---|
| 直接挂原包（对照组） | ✅ 有 | ✅ **有** |
| 挂包装模块 | ✅ **有** | ❌ **无** |

原始输出关键行：

```
RESULT row_found: true
RESULT row_fiber: true              ← 插件真的 apply 了
RESULT has_import_chat: true        ← 工具注册成功
RESULT client_packages_count: 71
RESULT client_has_chat_import: false ← UI 未加载
```

对照组同一脚本（`ROW_TARGET=raw`）：

```
RESULT row_fiber: true
RESULT has_import_chat: true
RESULT client_has_chat_import: true   ← 原包确实会加载 UI
```

**有对照组才说明包装模块起作用**：原包挂上时 UI 确实会加载，证明 `client_has_chat_import: false` 不是因为环境本身缺插件。

### 3. 首启检测 + 自动导入（链路已实现）⚠️

**架构上的关键约束**：`chatImport` 服务由插件通过 `ctx.provide('chatImport', …)` 提供，**只活在 Host 进程内**（`dsh-chat-import/lib/chat-import-service.mjs:161`）；而 `main.mjs` 是 Electron 主进程，通过 `HostProcess` **另起子进程**运行 `host.mjs`——两者不共享 ctx，跨进程调用需另造 HTTP 通道。

因此自动导入放在 **ds-bot 插件内**（`ds-bot/src/host/auto-import.js`），在 Host 进程里直接读服务。

链路：

```
main.mjs 首启 → 传 DS_BOT_AUTO_IMPORT=1 + DS_BOT_USER_DSH_HOME
   → ds-bot auto-import.js: ctx.inject(['chatImport'], …) 取服务
   → scanDiscover({format, path: <用户home>/sessions}) → 有则 importAll(…)
   → process.send({type:'ds-bot:auto-import-done', result})
   → main.mjs 收到后：仅当 result.failed === 0 才删 DSH_HOME 环境变量
```

**两个实现要点**：

- **`ctx.inject` 而非 `ctx.get`**：插件 apply 顺序不保证，`ctx.get('chatImport')` 在 install 时可能仍是 `undefined`，会导致首启导入**静默不执行**。改用仓库既有模式（`steer.js:22` 的 `jobs`、`tools.js:766` 的 `goals` 同样如此），服务可用时才回调。
- **扫描必须显式传 `path`**：插件的 dsh 来源默认根是 `env.DSH_HOME || ~/.dsh` 的 `sessions` 子目录（`lib/discovery/dsh.mjs:124`），而 Host 进程的 `DSH_HOME` 是 **app 自己的数据目录**。不显式传 path 就会扫错地方、什么也导不到。

**单测覆盖**（`ds-bot/test/auto-import.test.js`，7 条）：仅在 app 要求时导入、无 home 不扫、无插件服务不扫、扫描→导入链路、无会话不导、某格式扫描失败不影响另一格式、导入失败不抛异常。

### 4. 进度与失败不阻塞 ✅

- 进度：`rt.warn('%s', message)` 逐条记录（`ds-bot/src/host/auto-import.js` 的 `onProgress`），格式为 `ds-bot: importing N dsh sessions…`。
- 失败不阻塞：`importUserSessions` 每个格式各自 try/catch；一个格式失败只计入 `failed`，不影响另一格式；整个调用在 `setImmediate` 中执行，**不占启动路径**，窗口照常打开。
- app 侧判定：仅当 `result.failed === 0` 才删环境变量；**导入失败则保留变量**，用户下次启动可重试（符合队长要求）。

### 5. 删除 DSH_HOME 环境变量（逻辑已覆盖，真删待验）⚠️

`app/src/auto-import.mjs` 的 `removeDshHomeVariable(io)`：

- 用户级 `HKCU\Environment` 与系统级 `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` **两级都删**；
- 系统级权限不够 → 归入 `skipped`（**跳过不抛异常，不阻塞启动**）；
- 用户级失败 → 归入 `failed`，不影响系统级；
- 未设置 → 不动。

`removeDshHomeVariableWithNotice(io)`：系统级被跳过时**弹窗提示**用户手动删除（说明需要管理员权限、给出系统属性→环境变量的路径）。

**单测覆盖 4 种分支**（`app/test/auto-import.test.mjs`）：两级都删、机器级权限不够跳过、用户级失败记为 failed、未设置不处理；另加 3 条提示相关用例。

### 6. `~/.dsh` 目录本身不动 ✅

- 检测只读：`detectSessions()` 仅 `readdirSync`，无任何写入。
- 导入由插件执行，其产物写入 **app 自己的 `DSH_HOME`**（即 `<dataDir>`），不是用户 home。
- 代码层无任何 `rm`/`unlink` 指向用户 home；用户 home 仅作为**扫描源路径**出现。

### 7. 无回归 ✅（E 盘迁移后复跑）

| 项 | 结果 | 基线对照 |
|---|---|---|
| `app/` npm test | **232 / 231 / 1** | 219 + 13 条新增；唯一失败为既有 `move-data.test.mjs:160` EPERM |
| `ds-bot/` npm test | **1317 / 1316 / 0** | 1310 + 7 条新增；零失败 |
| `ds-bot/` npm run lint | **39 warnings / 0 errors** | 与基线一致 |
| `node scripts/build-client.mjs --check` | **exit 0** | 一致 |

### 8. 新增测试 ✅

| 位置 | 条数 | 覆盖 |
|---|---|---|
| `ds-bot/test/auto-import.test.js` | 7 | 请求判定、扫描→导入链路、路径显式传递、格式失败隔离、失败不抛 |
| `app/test/auto-import.test.mjs` | 13 | 会话检测（含 dsh/dsh4 格式识别）、home 重定向、环境变量四级分支、提示逻辑 |
| 合计 | **20** | 合计后 app 219→232（+13）、ds-bot 1310→1317（+7） |

## 未验证（留待装机环节）

这两条**没有在真机上跑过**，不能算已验证：

1. **首启真实自动导入的端到端**：已用 mock 的 `chatImport` 服务测了 ds-bot 侧链路（scanDiscover → importAll → 失败不阻塞），也用**真实 profile**测了包装模块装载与 `import_chat` 工具注册；但「用户真实 `~/.dsh` → 真的导入出**可继续对话**的会话」这条完整链路未跑——**未使用真实用户数据做此测试**。
2. **`DSH_HOME` 环境变量的真删**：已用注入的 `read`/`remove` 覆盖全部四种分支，但**没有真的删过注册表里的真实变量**（会改动开发机的系统环境）。

→ **建议在总包装机后补验**：装到干净测试环境 → 首启确认自动导入真的产出可继续的会话 → 确认用户级与系统级 `DSH_HOME` 真被删除、系统级权限不足时弹提示而不阻塞。

## 新发现问题

1. **`npm install --legacy-peer-deps` 会破坏打包依赖树**（严重，已拦下）：重新求解整棵树，把 `@electron/windows-sign`、`electron-winstaller` 等 17 个打包依赖剔出 lock。已还原 lock 并改用 `--package-lock-only` 增量更新。**流程已更新**：装包可用 `--legacy-peer-deps`，更新 lock 必须 `--package-lock-only`。
2. **会话日志格式的正则容易写错**：DSH 的会话日志是 `session[.vN].jsonl[.zstd]`，版本号在 `jsonl` **之前**。本人初版写成 `session.jsonl.v4` 形式，被单测直接抓出，已照抄插件真实正则 `^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$`（`dsh-chat-import/lib/sources/dsh.mjs:12`）。
3. **跨进程边界易被忽略**：`chatImport` 只在 Host 进程，app 主进程拿不到。本实现选择把导入逻辑放进 ds-bot 插件，而非在 `main.mjs` 里另造 HTTP 通道——前者能拿到真实进度，也不需要新接口。
4. **`ctx.get` 的时序坑**：可选服务应统一用 `ctx.inject([...], cb)`，否则服务未就绪时静默失败。

## 自我修正记录

- 首版 `factory.mjs` 的改动属需求五残留，已在工作区清理，不在本需求提交内。
- 首版 `removeDshHomeVariable` 用了 ESM 中不可用的 `require()`，改为顶层 `import { spawnSync }`。
- 首版 `detectSessions` 的会话日志正则写错，由新增单测发现并修正。
- 首版 `importUserSessions` 直接 `ctx.get('chatImport')`，改为 `ctx.inject` 取服务并允许注入，便于单测。

## 结论

需求三的开发与单测层面**已完成并通过**，UI 关闭方案经对照实验证实可行，无回归。两项真机行为（端到端导入、注册表真删）明确标注**待装机验证**，已移交小年糕（升级维护）列入装机验收清单。
