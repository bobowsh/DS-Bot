# DS Bot 桌面版架构说明

本文说明桌面 app、DeepSeek Harness（DSH）本体、`ds-bot` 插件三者的关系，以及
`ds-bot` 是怎么被挂进 DSH 里的。读完应该能回答三个问题：谁启动谁、谁给谁能力、
代码和数据分别在磁盘的什么位置。

需要设计层面的背景（为什么这样设计）看 [vision.md](vision.zh.md)；桌面 app 的
原始设计在 [plans/2026-10-16-desktop-app.md](plans/2026-10-16-desktop-app.md)。

---

## 一、一句话总览

```
app 把 DSH 叫醒 → DSH 照清单把 ds-bot 装上 → ds-bot 在 DSH 里把 Bot 团队跑起来
→ 窗口显示 DSH 的网页，ds-bot 往里加了侧栏
```

类比：**DSH 是 Chrome，ds-bot 是一个 Chrome 扩展，桌面 app 是把 Chrome 和扩展
预先装好、双击就能开的快捷方式。** 扩展不能脱离浏览器单独跑，同理 `ds-bot/` 目录
双击是跑不起来的，必须先有 DSH 把它装进去。

---

## 二、三层关系

```
┌─────────────────────────────────────────────────────────────┐
│  app/  =  桌面壳（Electron 窗口）                             │
│  干的活：选数据目录、起进程、开窗口、升级、从旧 DSH 导入        │
│  它自己一行 Bot 功能都没有                                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ ① fork 一个子进程，塞给它
                           │   DSH_HOME=数据目录、一个端口
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  DSH 本体（@deepseek-ai/dsh + 一堆 @deepseek-ai/dsh-* 包）   │
│  干的活：AI 对话的引擎 —— agent 循环、会话、工具、模型路由、    │
│          网页前端、权限、存储                                  │
│  关键能力：它是个"插件容器"，启动时按一份清单装载插件           │
└──────────────────────────┬──────────────────────────────────┘
                           │ ② 按清单找到插件包，调它的
                           │   apply(ctx) 把它装进引擎
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  ds-bot  =  插件（ds-bot/index.js）                          │
│  干的活：Bot 团队、群聊、Bot 互发消息、头像、审批……            │
│  它不自己启动，不自己连模型，全部借用 DSH 的 API                │
└─────────────────────────────────────────────────────────────┘
```

### 各层职责

| 层 | 代码 | 负责 | 明确不负责 |
| --- | --- | --- | --- |
| 桌面壳 | `app/src/main.mjs` | 定数据目录、fork Host、开窗口、升级、导入 | AI、模型、Bot 逻辑 |
| Host 子进程 | `app/src/host.mjs`、`app/src/profile.mjs` | 准备 profile（挂哪些插件）、调 DSH 启动、回传 URL | 任何 Bot 业务 |
| DSH 本体 | `@deepseek-ai/*`（npm 安装，见 `app/package.json`） | agent 循环、会话、工具、模型路由、Web 前端、插件容器 | Bot 团队概念（它不知道） |
| 插件 | `ds-bot/index.js` | Bot 团队、群聊、消息、权限、审批…… | 自己启动、自己连模型 |

---

## 三、启动流程

```
双击 DeepSeek Bot 图标
      │
      ▼
Electron 主进程  app/src/main.mjs → start()
   ├─ ① chooseLocations() 读 <userData>/locations.json → 数据目录 dataDir
   │     （没有这个文件就是首次运行：默认 ~/.ds-bot，弹窗可改；
   │       设了 DS_BOT_HOME 则直接用它，不询问、不导入）
   ├─ ② 分配本地端口 hostPort()
   └─ ③ fork 子进程，环境变量写入：
          DSH_HOME      = dataDir          ← app 的 DSH_HOME 只在这里注入
          DS_BOT_PORT   = 端口
          DS_BOT_APP    = 1
          DS_BOT_USER_DSH_HOME = 用户自己 ~/.dsh 的位置（只读，用于防止误写）
          cwd           = <dataDir>/profiles/ds-bot
      │
      ▼
Host 子进程  app/src/host.mjs
   ├─ loadAppProfile()（app/src/profile.mjs）
   │     ├─ resolveProfileDir('ds-bot') → <dataDir>/profiles/ds-bot
   │     ├─ initProfile(dir, BUNDLES)   → 建/更新 profile 的 package.json
   │     ├─ claimBundles(dir)           → 把 app 自己的三个 bundle 补到列表头部
   │     └─ loadProfileDirectory(..., INSTALL_ANCHOR)
   │                                      → 以 app/package.json 为依赖锚加载
   ├─ reconcileSearchSelector() / reconcileOfficeRuntime()
   │                                      → 应用搜索、Office 的 profile 补丁
   └─ runProfile()   ← @deepseek-ai/dsh/profile-boot，DSH 的文档化启动入口
         ├─ 读 profile 的 bundle 清单
         ├─ 顺着 installation 的依赖图去 node_modules 找这些包
         ├─ 应用每个插件自带的 cordis.patch.yml
         ├─ 调插件的 apply(ctx) 装进 cordis 容器
         └─ 起本地 web 服务器
      │
      ▼
   host.mjs 拿到 URL：http://127.0.0.1:<port>/?token=…
      │  通过 IPC 发回主进程（type: 'ready'）
      ▼
Electron 窗口 loadURL
      │
      ▼
你看到的界面 = DSH 的网页前端 + ds-bot 注入的侧栏/面板/主题（client.js 那一半）
```

退出时反过来：主进程发 `shutdown` → Host 调 `application.shutdown.shutdown(0)` →
发 `shutdown-complete` → 主进程 `app.quit()`。

---

## 四、插件是怎么"挂进去"的（四步）

### 1. 依赖声明：app 的 package.json 就是 installation

`app/package.json`：

```json
"dependencies": {
  "@deepseek-ai/dsh": "0.2.1-rc.4",
  "ds-bot": "file:../ds-bot",
  ...
}
```

DSH 只从 installation 的依赖图里导入插件，锚点由 `app/src/profile.mjs` 的
`INSTALL_ANCHOR` 指向 `app/package.json`。就像 Chrome 只加载"已安装"的扩展，
不认你随便丢在桌面上的文件夹。

### 2. 清单：profile 的 bundles 列表

`app/src/profile.mjs`：

```js
export const PROFILE  = 'ds-bot'
export const BUNDLES  = ['@deepseek-ai/dsh-base',    // DSH 核心
                         '@deepseek-ai/dsh-web-app',  // 网页前端（窗口里那个界面）
                         'ds-bot']                    // ← Bot 团队插件，就是这行
export const CHECK_PROFILE    = 'import-check'        // 首跑导入检查用，故意不挂 ds-bot
export const CHECK_BUNDLES    = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
export const RETIRED_BUNDLES  = ['deepseek-bot-engine'] // 早期版本的壳层，已退役
```

落到磁盘就是 `<dataDir>/profiles/ds-bot/package.json`：

```json
{
  "name": "dsh-profile-ds-bot",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "ds-bot"
  ] } }
}
```

`dependencies` 为空是正常的：包从 installation 的依赖图解析，不由 profile 自己装。

`claimBundles()` 的存在是因为 `initProfile` 只在 profile **新建**时写 bundle 列表，
所以每次启动都要把 app 自己的三个补到头部、剔除退役的、把用户自己装的排在后面。

> **profile = 一份"装哪些插件"的配置单。** DSH 启动时读它才知道这次加载谁。
> 桌面 app 有自己的 profile（名字就叫 `ds-bot`），数据也在自己的 `DSH_HOME`，
> 所以和用户自己的 `~/.dsh` 完全隔离。

### 3. DSH 侧的启动入口

`app/src/host.mjs` 调的是 DSH 官方提供的函数，不是自己写的内部逻辑：

```js
import { runProfile } from '@deepseek-ai/dsh/profile-boot'   // 文档化入口

runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: PROFILE,
  resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
  patchFiles: [...],                        // 搜索选择器、Office 的 profile 补丁
  args: ['--no-open', '--port', process.env.DS_BOT_PORT || '0'],
  packageManager: { ... },                  // 让 DSH 用 app 自带的 pnpm 装用户插件
})
```

### 4. 插件本体：被 DSH 调用的那一个

`ds-bot/package.json` 的 `dsh` 字段是自我声明：

```json
"dsh": {
  "client": { "platform": "web" },              // 我还有一半在浏览器页面里
  "bundle": { "patch": "./cordis.patch.yml" }   // 装我的时候应用这个补丁
}
```

`ds-bot/cordis.patch.yml` 往 DSH 的插件表里插两行：

```yaml
- insert:
    - id: bot              # 服务端的 Bot 团队
      name: ds-bot
    - id: web-search-auto  # 自带的网页搜索
      name: ds-bot/web-search
```

DSH 读到 `name: ds-bot`，就加载 `ds-bot/index.js` 的 `apply(ctx, config)` →
`createRuntime()`，按 `MODULES` 顺序（约 40 个模块）逐个 `install(rt)`：注册工具、
消息监听、UI。

插件要用 DSH 的什么能力必须先声明：

```js
// ds-bot/index.js
export const name   = 'ds-bot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController',
                       'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']
//                     模型   工具   系统提示词       会话控制      …… 全是 DSH 提供的
```

**ds-bot 自己不连模型、不跑 agent 循环，全是借 DSH 的。** 浏览器那一半通过
`dsh.client.platform: web` + 包的 `./client` 导出（构建生成的 `client.js`）注入页面，
这就是侧栏、面板、主题的来源。

---

## 五、磁盘布局

### 运行时数据（app 的 DSH_HOME）

```
D:\DeepSeekBot\bot-data                    ← DSH_HOME（app 启动时塞给子进程）
├── profiles/
│   ├── ds-bot/package.json                ← 装哪些插件（清单，profile）
│   └── office.patch.yml
├── bot/                                   ← ds-bot 插件的数据：state.json、密钥、日志
│   └── logs/diagnostics.jsonl
├── sessions/                              ← DSH 的会话记录
├── storages/
└── .credentials.yaml                      ← 模型密钥（DSH 管，绝不能提交）
```

数据目录本身不是硬编码的，来源优先级（`app/src/first-run.mjs` 的 `chooseLocations`）：

1. `DS_BOT_HOME` 环境变量 —— 开发/测试用的临时目录，设了就不询问、不导入
2. `<userData>/locations.json` —— 正常启动都走这里
   （Windows：`%APPDATA%\DeepSeek Bot\locations.json`，内容是 `{ "dataDir", "workspace" }`）
3. 都没有时首次运行默认 `~/.ds-bot`，弹窗可改

改位置的正规入口是 **设置 → 通用 → 位置**（`app/src/move-data.mjs`），移动成功后
由主进程 `saveLocations()` 写回 `locations.json`。**不要手工改这个文件。**

### 插件源码与副本

```
F:\DS-Bot\ds-bot                 ← 插件源码（你改代码的地方）
F:\DS-Bot\app\package.json       ← installation：声明 "ds-bot": "file:../ds-bot"
F:\DS-Bot\app\node_modules\ds-bot ← npm install 复制出来的副本（app 实际加载的）
```

打包后（`electron-builder.yml` 把整个 `node_modules` 打进 asar）：

```
<安装目录>\resources\app.asar\node_modules\ds-bot\          ← 主体
<安装目录>\resources\app.asar.unpacked\node_modules\ds-bot\office.js
                                                            ← 单独解包，独立 Node 读不了 asar
```

---

## 六、`file:../ds-bot` 是什么

`file:` 是 npm 的本地路径依赖协议，`../ds-bot` 是相对路径，**基准是这个
package.json 所在的目录**：

```
F:\DS-Bot\app\package.json      ← 基准
        └── "../ds-bot"  =  F:\DS-Bot\ds-bot    ← 仓库里的插件源码包，不联网
```

`npm install` 时按 `ds-bot/package.json` 的 `files` 白名单把包**复制**到
`app/node_modules/ds-bot`（`index.js`、`client.js`、`cordis.patch.yml`、`src/` 等）。

为什么是复制而不是软链，`app/.npmrc` 写了原因：

```ini
# 通过 symlink 的话，Node 会从 ds-bot/ 去解析 import，
# 而 DSH 那些包装在 app/node_modules/，那边没有 → 插件一 import 就崩
install-links=true
```

两个实际影响：

- **改了 `ds-bot` 的代码要重新 `npm ci`**：版本号没变时 `npm install` 不刷新这个副本，
  跑的还是旧拷贝（`app/README.md`）。
- `package-lock.json` 里记着 `"resolved": "file:../ds-bot"`，锁的就是这份本地路径。

DSH 能"顺着依赖图找到 ds-bot"，正是因为它就在 installation 的 `node_modules` 里。

### `npm install` 会不会重装本地依赖

结论：**不会**。npm 只比对 `package-lock.json` 和 `node_modules` 里已有的条目，两边一致
就报 `up to date`，根本不会回头去读 `../ds-bot` 源目录。实测（npm 11.11，玩具项目复现）：

| 操作 | 副本会不会刷新 |
| --- | --- |
| `npm install`（源码改了内容、版本号不变） | ❌ 不刷新 |
| `npm install`（源码版本号变了） | ❌ 也不刷新 |
| `npm install`（删掉 `node_modules/.package-lock.json`） | ❌ 仍不刷新 |
| `npm install`（删掉 `node_modules/<包>` 副本本身） | ✅ 重新复制 |
| `npm ci` | ✅ 刷新（清空 `node_modules` 按 lock 全量重装） |

所以**改了插件代码只有两条路**：`npm ci`（干净但慢，跑之前先关掉 app），或删掉那一个
副本目录再 `npm install`（最快，只补这一个包）。

---

## 七、再加一个内置插件怎么挂

前提：插件源码在本地（和 `ds-bot` 同类），要**内置**——所有用户一开 app 就有，
而不是让用户去插件页自行安装。

### 1. 插件包骨架

新目录 `plugins/<name>/`，最少四样东西（对照 `ds-bot/` 抄结构）：

```
plugins/<name>/
├─ package.json        ① name、type:module、main、dsh 字段、peerDependencies
├─ .npmrc              ② legacy-peer-deps=true（必须）
├─ index.js            ③ apply(ctx, config) 入口，export name / inject / apply
└─ cordis.patch.yml    ④ 往 DSH 插件表 insert 你的服务行（纯服务端插件才需要）
```

② 必须照抄 `ds-bot/.npmrc`，它的注释解释了原因：

```ini
# The @deepseek-ai peers come from the dsh profile that loads the plugin. Keep npm from
# installing them here: only the build tools in devDependencies belong in node_modules.
legacy-peer-deps=true
```

`@deepseek-ai/*` 是 peer 依赖，由**加载它的 DSH profile** 提供；不加这行，
`npm install` 会把整套 DSH 又装一份进插件目录。

有前端 UI 的插件还要 `dsh.client.platform: web` + `./client` 导出（做法同 `ds-bot`）。

### 2. 要动的三处

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `app/package.json` | `dependencies` 加 `"file:../plugins/<name>"`（和 `"ds-bot"` 并列） |
| 2 | `app/src/profile.mjs` | `BUNDLES` 数组里加包名 |
| 3 | 插件自己的 `package.json`、`cordis.patch.yml` | `dsh.bundle.patch` 指向补丁，补丁里 `insert` 你的服务 |

**不用改 `electron-builder.yml`。** 打包靠的是依赖图：`app/README.md` 原文
"electron-builder packs only the packages that it finds through `dependencies` and
`optionalDependencies`"，`files:` 只管 app 自己的文件（`package.json`、`src/**`、
`assets/**`），里面并没有 `node_modules/ds-bot/**`，而 `scripts/check-packed.mjs`
校验的正是 `app.asar.unpacked/node_modules/ds-bot/office.js` 确实被打进去了。
所以只要进了 `dependencies`，`npm run pack` 就会带上它。

**"内置"的判定也在这里**：DSH 的插件管理器用 `Object.hasOwn(installation.dependencies, name)`
判断一个 bundle 是不是出厂自带（shipped），在 `app/package.json` 的 `dependencies` 里
= 内置、插件页上不可卸载。

**bundle 从哪解析**（决定了包必须装在哪）：解析器按两个锚点找包目录——
**installation 锚点（`app/node_modules`）优先，profile 目录次之**。
内置插件走第一个（`npm ci` 装进 `app/node_modules`），用户在插件页装的走第二个
（pnpm 装进 `<DSH_HOME>/profiles/ds-bot/node_modules`）。

### 3. 改完必须 `npm ci`

在 `app/` 下（**先关掉 app**）：

```sh
npm ci            # 或：删掉 node_modules/<name> 再 npm install，只补这一个包
npm run pack      # 要出安装包时
```

只跑 `npm install` 是没用的，见上一节的实测表。

开发时**用根目录的 `start.ps1` 启动就不用手动管**：它对插件的 package files 算哈希
（`npm pack --dry-run --json` 拿文件清单，加上 app 的 `package.json`/lock/`.npmrc`），
哈希变了就自动对 `app/` 跑 `npm ci --include=dev` 刷新副本，没变就跳过——
专门绕开"版本没变 npm 不刷新"这个坑。

`.gitignore` 的 `node_modules/` 是全局匹配，`plugins/<name>/node_modules` 不会被误提交。

### 4. 插件包被 DSH 接受的最低要求

从 `@deepseek-ai/dsh-plugin-manager`、`dsh-app-boot`、`dsh-client-modules` 的实现读到的：

1. **是可被 pnpm 装的 npm 包**（registry / git / 本地路径 / tgz）。
2. **`package.json` 必须声明 `dsh.bundle`，且指向的 patch 文件必须真实存在**——
   缺了直接按 `not-bundle` 失败并回滚 `package.json` / `pnpm-lock.yaml`。
3. **兼容性声明二选一**：`engines.dsh` 覆盖当前 DSH 版本（app 固定 `0.2.1-rc.4`），
   或声明 `@deepseek-ai/dsh*` 的 peerDependencies（`ds-bot` 是四项 `"*"`，靠
   `app/package.json` 的 `overrides` 钉到 DSH 版本——npm 不会为 `*` 选预发布版）。
4. **纯服务端插件可以没有客户端半边**：没声明 `dsh.client` 或平台非 `web` 就直接跳过。
   但**一旦声明了 `dsh.client.platform: web`，`exports` 里必须有 `"./client"`**，
   否则加载时抛错。前端那半就是靠这个导出注入页面的。
5. **patch 文件的内容**是 cordis 配置，负责把插件本体 insert 进服务树
   （范例 `ds-bot/cordis.patch.yml`）。
6. **每个插件自带的 `.npmrc`（`legacy-peer-deps=true`）**，见骨架第 ② 项。

### 5. 改动会影响的测试

- `app/test/profile.test.mjs`：断言 profile 的 layers 就是 `BUNDLES` 常量本身，
  改常量后要确认它仍通过。
- `app/test/package.test.mjs`：peer-only 的包必须出现在 `dependencies` 里
  （electron-builder 只打包生产依赖，DSH 的 peer npm 会装但打包会漏，所以都列进去）；
  另有 `app` 版本 === `ds-bot` 版本的断言（新插件不触发，除非你也学着做版本联动）。
- CI 跑的是 `npm test` + `node scripts/build-client.mjs --check` + `npm run lint`。

### 6. 另一条路：可选安装（用户在插件页自己装）

机制原生支持，不必改 app 代码：

- 插件页的 **Add plugin** 就是 `pnpm add <spec>`，跑在 profile 目录里，
  用的是 app 自带的 pnpm，装进 `<DSH_HOME>/profiles/ds-bot/node_modules/`；
  装完把包名**追加**到 profile `package.json` 的 `dsh.profile.bundles` 末尾。
- spec 支持 registry 名、git 地址、**本地路径**、tgz（`README.md` 里就写了用
  `ds-bot-0.2.1.tgz` 或 `github:Fei2411/DS-Bot#v0.2.1&path:/ds-bot` 的离线装法）。
- 走 registry 要联网；没有 `dsh.bundle` 声明的包只会被当普通依赖，插件页标 `not-bundle`。
- **用户装的不会被 app 更新抹掉**：每次启动 `reconcileProfilePlugins` 按 profile 的
  `dependencies` 重建 bundles 列表，`claimBundles` 保留所有非内置项（只剔除
  `RETIRED_BUNDLES`）。
- 两边的分界线就是 `app/package.json` 的 `dependencies`：在里面 = 内置不可卸载，
  不在里面 = 用户装的、可卸载。开发期想先试某个插件，可以先走插件页装本地路径验证，
  确认没问题再"转正"进 `dependencies` + `BUNDLES`。

---

## 八、和 DSH 本体的关系：三条铁钉子

1. **ds-bot 是搭在 DSH 上的，不是改 DSH。** 仓库硬规则第 1 条：只用文档化的插件
   API，永远不 patch DSH 的代码，也不依赖 DSH 安装目录里的文件。DSH 升级了插件照常
   跑；哪天发现缺 API，正确做法是"停下来说 DSH 缺这个"，而不是绕过去改它内部。
2. **桌面 app 不是 DSH，是 DSH 的司机。** 它钉死一个 DSH 版本（`app/package.json`
   里的 `@deepseek-ai/dsh`），通过文档化入口（`@deepseek-ai/dsh/profile-boot`、
   `dsh` CLI）把它跑起来，数据在自己的 `DSH_HOME`，绝不写 `~/.dsh`。
3. **三者版本各自独立。** `app` 与 `ds-bot` 用本仓库的版本号，`dsh` 是外部依赖，
   从 npm 装，三者不必同步。

---

## 八、关键文件索引

| 文件 | 作用 |
| --- | --- |
| `app/src/main.mjs` | Electron 主进程：`start()` 决定数据目录、fork Host、开窗口 |
| `app/src/host.mjs` | Host 子进程：`loadAppProfile()` + `runProfile()`，回传 URL |
| `app/src/profile.mjs` | profile 的名字、bundles 清单、创建与更新（`INSTALL_ANCHOR`） |
| `app/src/first-run.mjs` | 首跑对话框、`chooseLocations()`、`saveLocations()` 写 `locations.json` |
| `app/src/move-data.mjs` | 设置里"移动数据位置"的复制与回写 |
| `app/src/import.mjs` | 从用户自己的 `~/.dsh` 只读复制一个已有团队 |
| `app/package.json` | installation：依赖、`ds-bot` 的 `file:` 引用 |
| `app/.npmrc` | `install-links=true`：本地依赖装成副本而非软链 |
| `app/electron-builder.yml` | 打包：哪些进 asar、哪些 unpack、Office 运行时 |
| `ds-bot/package.json` | 插件的 `dsh` 声明（`client.platform`、`bundle.patch`） |
| `ds-bot/cordis.patch.yml` | 往 DSH 插件表 insert `bot` 和 `web-search-auto` 两行 |
| `ds-bot/index.js` | 插件入口：`inject` 声明依赖、`MODULES` 逐个 `install(rt)` |
