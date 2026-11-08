# 需求三「自动导入系统中已有 dsh 的会话数据」验收报告

- 验收人：小饼干（前端开发）
- 日期：2026-11-01（开发 18:25–19:20；E 盘复跑回归 19:28–19:32；方案按用户拍板改为保留 UI 后重做，20:13–20:20）
- 被测：`E:\dsbot-work\DS-Bot` dev HEAD **`d4bb5c1`**（需求三提交：`bccc71f` 插件作为 bundle 挂载、UI 保留 + 成功日志 + 去 BOM；`dfa6827` 版本对齐；`8d75c33` 设计文档入库；`d4bb5c1` 发版版本号清单。前序提交 `25ea261`/`cb5c3c9`/`1aeda59` 为初版）
- 环境：Windows，node v24.14.1，E 盘本地工作区
- 设计文档：`docs/plans/2026-11-01-auto-import-sessions.md`
- 独立验证脚本：`tmp\verify-mount2.mjs`（真实 profile 装载验证）；测试文件 `ds-bot/test/auto-import.test.js`（8 条）、`app/test/auto-import.test.mjs`（18 条）

## 结论

**需求三 8 条验收标准中 6 条已验证通过，2 条留待装机环节验证**（真机端到端导入、系统环境变量真删）。插件的挂载方式在实施中按用户拍板改过一次：最终是**作为 bundle 挂载、UI 保留**，验收标准相应改为「工具与 UI 都在」。

| # | 标准 | 状态 |
|---|---|---|
| 1 | dsh-chat-import 打进 app（package.json + lock 都有、BUNDLES 有） | ✅ 通过 |
| 2 | 插件作为 bundle 挂载，`import_chat` 工具可用，UI 保留（**实测**） | ✅ 通过 |
| 3 | 首启检测到会话数据自动导入，不弹框 | ⚠️ 链路已实现并单测覆盖；**真机端到端待装机验证** |
| 4 | 导入显示进度、失败不阻塞启动 | ✅ 通过 |
| 5 | 用户级 + 系统级 DSH_HOME 都删（权限不够跳过并提示） | ⚠️ 逻辑已单测覆盖四种分支；**注册表真删待装机验证** |
| 6 | `~/.dsh` 目录本身不动 | ✅ 通过 |
| 7 | 无回归 | ✅ 通过 |
| 8 | 新增测试覆盖上述行为 | ✅ 通过（新增 26 条） |

## 已验证通过

### 1. dsh-chat-import 打进 app ✅

- `app/package.json` dependencies 新增 `"dsh-chat-import": "0.26.3"`；`app/src/profile.mjs` 的 `BUNDLES` 加 `'dsh-chat-import'`。
- **`package-lock.json` 已同步提交**，增量干净：仅新增 `node_modules/dsh-chat-import` 与 `node_modules/fzstd` 两条，**零删包**（`git diff --stat` = +30/−1，唯一删除是某包的 `"dev": true` 标记）。

> **踩坑记录（重要，流程已更新）**：`npm install --legacy-peer-deps` 虽能装上（npm 对预发布版本号的比较有 bug，`>=0.1.5-rc.1` 不接受 `0.2.1-rc.4`），但它会**重新求解整棵树**，把 `@electron/windows-sign`、`electron-winstaller` 等 17 个打包必需依赖从 lock 里剔掉，直接毁掉打包。正确做法：**装包**可用 `--legacy-peer-deps`，**更新 lock 必须** `npm install --package-lock-only`。此结论由本人在实测中发现并拦下，经核对 lockfile diff 确认。

### 2. 插件作为 bundle 挂载，UI 与工具都在 ✅

**最终采用的方案**：插件直接进 `BUNDLES`，走和 ds-bot 完全相同的路径——bundle → 插件自带的 `cordis.patch.yml` 插入 `import-claude` 行 → 服务端 apply → 客户端 UI 一并加载。

实测（真实 profile 启动，临时 `DSH_HOME`，全程未触碰真实 `~/.dsh`）：

```
RESULT row_name: dsh-chat-import        ← 插件行在
RESULT row_fiber: true                   ← 插件真的 apply 了
RESULT has_import_chat: true             ← import_chat 工具注册成功
RESULT client_has_chat_import: true      ← UI 也加载了（手动导入按钮可用）
RESULT client_package_count: 72
```

**方案演进（重要，别按旧方案验收）**：本项最初的做法是「关掉插件的 UI、只留 `import_chat` 工具」，实现上需要一个不声明 `dsh.client` 的包装模块承载同一份服务端插件。

- 先排除了一条看起来可行的路：小柚（DSH开发）核实 `cordis-plugin-loader` 的 `refresh()` 在 `disabled` 时直接 return（`lib/index.js:363`），`dsh-client-modules` 那边 `entry.disabled` 也整行跳过（`lib/index.js:855`）——**行级 `disabled` 会把 `import_chat` 工具一起关掉**，不可用。
- 包装模块方案实测可行（对照实验：挂原包时 UI 加载、挂包装模块时 UI 不加载，工具都在）。
- **但用户 2026-11-01 拍板保留 UI**：界面上有现成的导入按钮，用户看着也放心，没必要藏起来。于是包装模块与 app 侧的 overlay patch 全部废弃，改回标准 bundle 模式（提交 `bccc71f`）。

**当前代码里已无任何 headless 包装或 overlay patch**：`app/src/chat-import-headless.mjs`、`app/src/chat-import-patch.mjs`、`app/vendor/` 与 `app/packages/` 均已删除，`host.mjs` 相对该提交零改动。验收时按 bundle 模式判定：插件行在、工具在、**UI 在**。

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
| `app/` npm test | **237 / 236 / 1** | 219 + 18 条新增；唯一失败为既有 `move-data.test.mjs:160` EPERM |
| `ds-bot/` npm test | **1318 / 1317 / 0** | 1310 + 8 条新增；零失败 |
| `ds-bot/` npm run lint | **39 warnings / 0 errors** | 与基线一致 |
| `node scripts/build-client.mjs --check` | **exit 0** | 一致 |

### 8. 新增测试 ✅

| 位置 | 条数 | 覆盖 |
|---|---|---|
| `ds-bot/test/auto-import.test.js` | 8 | 请求判定、扫描→导入链路、路径显式传递、格式失败隔离、失败不抛、成功日志 |
| `app/test/auto-import.test.mjs` | 18 | 会话检测（含 dsh/dsh4 格式识别）、home 重定向、环境变量四级分支、广播、提示逻辑、成功日志 |
| 合计 | **26** | 合计后 app 219→237（+18）、ds-bot 1310→1318（+8） |

## 未验证（留待装机环节）

这两条**没有在真机上跑过**，不能算已验证：

1. **首启真实自动导入的端到端**：已用 mock 的 `chatImport` 服务测了 ds-bot 侧链路（scanDiscover → importAll → 失败不阻塞），也用**真实 profile**测了插件作为 bundle 的装载、`import_chat` 工具注册与 UI 加载；但「用户真实 `~/.dsh` → 真的导入出**可继续对话**的会话」这条完整链路未跑——**未使用真实用户数据做此测试**。
2. **`DSH_HOME` 环境变量的真删**：已用注入的 `read`/`remove` 覆盖全部四种分支，但**没有真的删过注册表里的真实变量**（会改动开发机的系统环境）。

→ **建议在总包装机后补验**：装到干净测试环境 → 首启确认自动导入真的产出可继续的会话 → 确认用户级与系统级 `DSH_HOME` 真被删除、系统级权限不足时弹提示而不阻塞。

## 新发现问题

1. **`npm install --legacy-peer-deps` 会破坏打包依赖树**（严重，已拦下）：重新求解整棵树，把 `@electron/windows-sign`、`electron-winstaller` 等 17 个打包依赖剔出 lock。已还原 lock 并改用 `--package-lock-only` 增量更新。**流程已更新**：装包可用 `--legacy-peer-deps`，更新 lock 必须 `--package-lock-only`。
2. **会话日志格式的正则容易写错**：DSH 的会话日志是 `session[.vN].jsonl[.zstd]`，版本号在 `jsonl` **之前**。本人初版写成 `session.jsonl.v4` 形式，被单测直接抓出，已照抄插件真实正则 `^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$`（`dsh-chat-import/lib/sources/dsh.mjs:12`）。
3. **跨进程边界易被忽略**：`chatImport` 只在 Host 进程，app 主进程拿不到。本实现选择把导入逻辑放进 ds-bot 插件，而非在 `main.mjs` 里另造 HTTP 通道——前者能拿到真实进度，也不需要新接口。
4. **`ctx.get` 的时序坑**：可选服务应统一用 `ctx.inject([...], cb)`，否则服务未就绪时静默失败。
5. **预发布版本号会打破诊断页的断言**：`ds-bot/test/diagnostics.test.js` 里诊断报告的版本行用 `\| DS Bot \| \d+\.\d+\.\d+ \|` 匹配，而 `0.2.5-rc2` 带后缀，匹配不上。这是升到 `-rc2` 后才出现的（由版本对齐提交 `dfa6827` 引出），已把正则放宽为允许可选的预发布后缀。**版本号断言不要只写死数字部分**。
6. **`file:` 依赖在 `node_modules` 里是复制，不是链接**：改了 `ds-bot/package.json` 的版本后，`app/node_modules/ds-bot` 还是旧的，打包打的就是旧内容。必须跑一次 `npm ci` 让它重新复制。这条已写进 `docs/dev/release-checklist.md` 的「改版本号」一节。

## 自我修正记录

- 首版 `factory.mjs` 的改动属需求五残留，已在工作区清理，不在本需求提交内。
- 首版 `removeDshHomeVariable` 用了 ESM 中不可用的 `require()`，改为顶层 `import { spawnSync }`。
- 首版 `detectSessions` 的会话日志正则写错，由新增单测发现并修正。
- 首版 `importUserSessions` 直接 `ctx.get('chatImport')`，改为 `ctx.inject` 取服务并允许注入，便于单测。
- 首版的挂载验证只在裸目录里手动插 patch 行，**真实 app 走的是 `BUNDLES`，两者不是同一条路**——插件当时根本没进 `BUNDLES`，会静默不加载。发现后改为按 bundle 模式验证（真实 profile 装载），这条写进了「新发现问题」。
- 方案随用户拍板改为保留 UI，headless 包装模块与 app overlay patch 全部废弃；本文档已按最终实现改写。

## 结论

需求三的开发与单测层面**已完成并通过**，插件作为 bundle 挂载、工具与 UI 都在（实测），无回归。两项真机行为（端到端导入、注册表真删）明确标注**待装机验证**，已移交小年糕（升级维护）列入装机验收清单。
