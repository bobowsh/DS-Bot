# 出厂预制团队、技能仓库更新与去掉导入团队

- 日期：2026-11-01
- 状态：已实施
- 相关：[桌面应用](2026-10-16-desktop-app.md)「首次启动和导入」、[固定数据位置与导入提示](2026-11-01-fixed-data-location.md)、[按 bot 挂载文件技能](2026-11-01-bot-skill-files.md)、[自动导入系统中已有 dsh 的会话数据](2026-11-01-auto-import-sessions.md)

## 为什么

用户希望出厂安装包里预置一批 bot（含私有能力包），开箱即用，而不是让用户从自己的 DSH 复制团队：

- **新用户**：装完就有团队可用，不用自己配。
- **老用户升级**：预制团队的 bot 更新到出厂值（名字、角色、指令、能力），用户自己建的 bot 不动。
- **技能更新**：技能跟着 git 仓库走，不靠安装包发版；bot 的 skill 目录做成 git 管理的，通过 git 更新。
- **去掉导入团队**：之前那个「从用户 DSH 复制 Bot 团队」的功能不要了，以后都用预制团队。

需求三（自动导入 `~/.dsh` 的**历史会话数据**）保留：它导的是会话记录，和「复制 Bot 团队」是两件事。

## 调研结果

### state.json 的结构

`ds-bot/src/host/store.js:22` 定义了 state 的完整形状：

```js
{ version: 1, workspaceId?, mainBotIds: [], bots: {}, privateArchives: [], rooms: {},
  agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {},
  requests: {}, questions: {}, views: {}, prefs: {}, switching: {}, revision: 0 }
```

- `bots` 的 key 是 **session id**（由 `createSession` 生成），不是逻辑 id。
- 一个 bot 记录（`ds-bot/src/host/roster.js:157`）：
  `{ id, name, role, color?, avatar?, model?, effort?, workDir?, instructions, createdAt, createdBy, capabilities: [] }`
- 一个 capability 条目（`ds-bot/src/host/capabilities.js`）：
  - skill：`{ name, kind: 'skill', description, createdBy, createdAt, updatedAt, locator?, content }`
  - mcp：`{ name, kind: 'mcp', description, createdBy, createdAt, updatedAt, transport, command|url, args|env|headers, approved }`

### 种子由谁写入

**ds-bot 插件自己写**，不交给 app 手写 state.json。理由：

- state.json 的结构由 ds-bot 维护，app 手写容易写出 ds-bot 不认的字段。
- 种子 bot 需要走 `buildBot`（`roster.js:140`）：创建 Session、解析模型、生成问候消息、写 `mainBotIds`。
- 升级覆盖也要改 `state.bots` 里的记录，这是 ds-bot 的地盘。

### 技能挂载机制（需求四已落地）

`ds-bot/src/host/capabilities.js` 已经支持：

- `itemInput`：`kind === 'skill'` 时存 `locator`（技能目录路径）。
- `configFor`：有 `locator` 时从 `<locator>/SKILL.md` 读 content，并返回 `resourceBase: { kind: 'directory', path }`。
- `mountOne`：注册 skill 时带上 `resourceBase`。

所以需求五直接用这个机制，技能的 locator 指向 `<dataDir>/skills-repo/<技能名>/` 即可。

### ds-bot 怎么拿数据目录

`rt.dshHome` 就是 app 传给 Host 的 `DSH_HOME`（= `<dataDir>`，见 `app/src/main.mjs:186`）。种子文件放在 `<DSH_HOME>/factory/`，技能仓库放在 `<DSH_HOME>/skills-repo/`。

### isomorphic-git

- npm 包 `isomorphic-git`，当前版本 `1.44.8`，许可证 MIT。
- 纯 JavaScript 的 git 实现，支持 `clone` / `pull`，Node 环境用 `node:fs` 即可。
- 体积约 1~2 MB（打进 app 的 node_modules）。

## 已定的行为

### 一、种子机制

**种子文件**：`factory-team.json`，随安装包内置，放在 `app/resources/factory/`（具体路径随打包结构调整）。首启时由 app 复制到 `<dataDir>/factory/factory-team.json`。

**种子结构**（直接对齐 state.json 的 bot / capability 形状，另加 `factoryId`）：

```json
{
  "version": "1",
  "bots": [
    {
      "factoryId": "factory-chief",
      "name": "小队长",
      "role": "Chief of Staff",
      "instructions": "你是用户的主 Bot……",
      "main": true,
      "model": "llm-deepseek/deepseek-chat",
      "capabilities": ["code-review", "gitea-mcp"]
    }
  ],
  "capabilities": {
    "items": {
      "code-review": {
        "kind": "skill",
        "description": "代码评审技能",
        "locator": "skills-repo/code-review"
      },
      "gitea-mcp": {
        "kind": "mcp",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-gitea"],
        "env": { "GITEA_URL": "..." },
        "approved": true
      }
    }
  }
}
```

- `locator` 用相对数据目录的路径（`skills-repo/<技能名>`），ds-bot 加载时解析为绝对路径：`join(rt.dshHome, locator)`。
- `factoryId` 是种子 bot 的稳定标识：创建时写进 `state.bots[sessionId].factoryId`，升级时按它匹配，不随名字变。

**加载时机**：ds-bot 启动、state 加载完成之后、Bot 启动之前。

**首次安装**（`state.bots` 为空）：按种子逐个 `buildBot` 创建，`main: true` 的写进 `mainBotIds`。

**升级**（`state.factorySeedVersion !== 种子 version`）：

1. 种子 capabilities 条目按名字覆盖：种子里有的覆盖到出厂值，用户自建的不动。
2. 种子 bot 按 `factoryId` 匹配 `state.bots` 里的记录，把 `name` / `role` / `instructions` / `capabilities` / `model` 更新到出厂值；没有的按种子新建。
3. 用户自己建的 bot（没有 `factoryId`）不动。
4. `state.factorySeedVersion` 记成种子版本。

**覆盖语义（已确认）**：用户改过预制 bot 的名字 / 指令，升级时会被**出厂值覆盖回去**。这是「更新预制团队」的含义。用户真想保留改动，改完自己另存一个 bot。

**幂等**：种子版本没变就跳过，不重复写。

**模型**：种子 bot 的 `model` 必须能在 app 的模型池里解析。解析失败时退化为 `pickModel`（首启让用户选模型）。**具体预置哪几个 bot、各自什么模型，由用户给清单**——机制先做，种子内容先用占位示例。

### 二、技能仓库与 git 更新

**仓库结构**：一个 git 仓库，每个技能一个子目录：

```
skills-repo/
  code-review/
    SKILL.md
    scripts/*.mjs
  cpp-standards/
    SKILL.md
    ...
```

**位置**：`<dataDir>/skills-repo/`。

| 场景 | 行为 |
|---|---|
| 出厂首启（离线） | 安装包内置仓库初始副本 → 复制到 `<dataDir>/skills-repo/` → 开箱即用 |
| 出厂首启（在线） | `git clone` 最新 → 失败回退内置副本 |
| 日常启动 | 后台 `git pull`（不阻塞启动），失败静默用现有版本 |
| app 升级 | bot 按 `factoryId` 覆盖更新；技能靠 git pull，安装包里的副本只作离线兜底，已有 clone 不被覆盖 |

**locator 指向**：`<dataDir>/skills-repo/<技能名>/`。

### 三、去掉导入团队功能

删除范围：

- `app/src/first-run.mjs`：`offerImport`、`import-declined` 标记（`markDeclined` / `declined`）、首启导入询问弹框全删。`TEXT` 里的 `found` / `foundDetail` / `whichModels` / `newer` / `failed` 等导入文案删。
- `app/src/import.mjs`：`importTeam` / `findTeam` / `teamInUse` 等团队导入逻辑删。`copySessions` 等会话相关函数看需求三是否复用再定（需求三保留，若它需要，就拆出去留用）。
- `app/src/main.mjs`：`copyTeam` / `checkTeam` 以及 `CHECK_PROFILE` 相关调用删。
- `app/src/profile.mjs`：`CHECK_PROFILE` / `CHECK_BUNDLES` 删。
- 首启流程简化为：选 / 固定位置 → （无团队则）写种子 → 启动。

首启不再问「要复制团队吗」。种子 bot 开箱就有。

**需求三的关系**：需求三（自动导入历史会话）也要动 first-run，所以排在需求五合并之后串行做。

## 实现分布

| 改动 | 在哪 | 说明 |
|---|---|---|
| 种子创建 / 覆盖 / `factorySeedVersion` | `ds-bot/` | 插件启动时读种子，走 `buildBot`；给 `buildBot` 加 `factoryId` 选项 |
| locator 绝对路径解析 | `ds-bot/` | 加载种子时把相对 locator 拼成 `join(rt.dshHome, locator)` |
| 删导入团队 | `app/` | first-run / import / main / profile 四处清理 |
| 种子文件内置 + 首启复制 | `app/` | `factory-team.json` 放 `app/resources/factory/`，首启复制到 `<dataDir>/factory/` |
| 技能仓库内置副本 | `app/` | skills-repo 打包进 app，首启复制 / clone |
| isomorphic-git clone / pull | `app/` | 首启 clone，日常启动后台 pull，失败静默 |

## 不做什么

- 不动需求三（自动导入历史会话数据）。
- 不把技能放在全局 `~/.dsh/skills/`（全局 skill-filesystem 会自动加载）。
- 不改 dsh-chat-import 插件的源码（需求三用）。
- 不在升级时动用户自己建的 bot。
- 不用系统 git 命令（用户机器不一定装了 git），只用 isomorphic-git。

## 已知限制

- isomorphic-git 打进 app 会增加约 1~2 MB 体积。
- 种子 bot 的模型解析依赖 app 的模型池；模型池里没有的模型会退化为 `pickModel`。
- 覆盖用户改动是有意为之，用户改过的预制 bot 升级后回到出厂值。
- 技能 git 更新依赖网络；离线时用安装包内置副本。

## 验收标准

1. **首次安装**：全新数据目录首启后，`<dataDir>/bot/state.json` 里有种子 bot，`mainBotIds` 正确，bot 能启动。
2. **升级覆盖**：把 `factorySeedVersion` 改成旧版本 / 改种子 bot 的 `name` / `role` / `instructions` / `capabilities`，重启后种子 bot 更新到出厂值，`factorySeedVersion` 更新。
3. **用户 bot 不动**：升级前后，用户自己建的 bot（无 `factoryId`）完全不变。
4. **技能 git 更新**：`<dataDir>/skills-repo/` 是 git 仓库；首启 clone 成功（在线）或复制成功（离线）；日常启动后台 pull 不阻塞启动；pull 失败静默。
5. **locator 解析**：种子 bot 的技能挂载后，`configFor` 读到的 content 来自 `<dataDir>/skills-repo/<技能名>/SKILL.md`，`resourceBase` 指向该目录。
6. **导入功能已删**：`first-run.mjs` 无 `offerImport`，`import.mjs` 无 `importTeam`，首启不再弹导入询问。
7. **无回归**：`ds-bot/` 的 `npm test` 全绿、`npm run lint`、`node scripts/build-client.mjs --check` exit 0；`app/` 的 `npm test` 与基线一致。
8. **测试覆盖**：种子首次安装、升级覆盖、用户 bot 不动、locator 解析、技能仓库复制 / clone、导入功能删除，各有测试。

## 变更

- 2026-11-01：初稿，方案已定。三点拍板：isomorphic-git（方案 A）、升级覆盖用户改动、需求三保留。
- 2026-11-01：已实施。种子在 ds-bot 启动时应用（`src/host/factory-seed.js`，首装建队、升级按 `factoryId` 覆盖、用户 Bot 不动、幂等）；app 侧 `src/factory.mjs` 首启把内置种子与 skills-repo 落到数据目录，isomorphic-git 在线 clone、离线/失败回退内置副本，日常启动后台 pull 静默；导入团队整条链路删除（first-run/import/main/profile/host 与相关测试），保留需求三要用的会话级原语（findTeam/copySessions/newerSessions/teamInUse/sessionIdsOf/unreadableSessions）。
