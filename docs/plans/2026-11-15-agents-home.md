# 出厂 AGENTS.md 与出厂技能改走 `DSH_AGENTS_HOME`

Refs #61

- 日期：2026-11-15
- 状态：**已与用户对齐，实施中**
- 相关：[出厂插件与技能的打包与预置（清单驱动）](2026-11-08-factory-packaging-manifest.md)、[出厂预制团队与技能仓库](2026-11-01-factory-team.md)

## 要解决什么

出厂规矩和出厂技能现在落地的地方，**全局规矩根本没生效**。

实测（2026-11-15）：`DSH_HOME` = `D:\LinkBot\data`，但

- `D:\LinkBot\data\AGENTS.md` **不存在**
- `D:\Users\bobowsh\.agents\AGENTS.md` **不存在**
- 那 341 字节的规矩（tmp 目录、中文、提问用工具、脚本用 Node/Python）躺在 `D:\Users\bobowsh\.dsh\AGENTS.md`，那是**另一个 DSH 实例的 home**，本实例从不读它

结果：出厂规矩一条都没注入过。本机实测会话日志（`session-e5407ba6`，6169 行）里 AGENTS.md 注入只有 1 次、来源只有项目根那一份。

## 边界

只动"出厂内容放到哪里、从哪个环境变量读"。不动：

- DSH 本身（硬规矩 1）
- 用户自己的 `~/.dsh`（硬规矩 5）
- 用户自己装的插件、自己写的技能
- 已有的自动更新机制（插件、技能各一条通道）

## 已拍板决策（用户 2026-11-15）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | `DSH_AGENTS_HOME` 指向哪里 | **`<数据目录>\.agents`**，与 `DSH_HOME=<数据目录>` 并排，跟用户真实的 `~/.agents` 脱钩 |
| Q2 | 出厂技能落点 | `<数据目录>\.agents\skills\<slug>\` |
| Q3 | 出厂 AGENTS.md 落点 | `<数据目录>\.agents\AGENTS.md`，内容从 `D:\Users\bobowsh\.dsh\AGENTS.md`（341 字节）拷来预置 |
| Q4 | 预置那份 `<数据目录>\AGENTS.md` | **预置一份空的**，留给用户自己写 |
| Q5 | 老的 `<数据目录>\skills` | **完全不动**；只把与出厂同名的技能改名让出 rank（方案 B） |
| Q6 | 安装器 `.bak` 备份 | **不要**，直接把安装包内容覆盖到目标目录 |

## Q5 为什么必须让出 rank：这是我们踩到的真问题

`@deepseek-ai/dsh-skill-filesystem` 的两套用户技能根，rank 数值小的先赢：

| rank | 根 | 本机路径 |
|---|---|---|
| 400 | `user-dsh` = `$DSH_HOME/skills` | `D:\LinkBot\data\skills` |
| 500 | `user-agents` = `$DSH_AGENTS_HOME/skills` | `D:\LinkBot\data\.agents\skills` |

源码证据：`compareIndexedCandidates` 是 `left.candidate.rank - right.candidate.rank` 升序，`collectLayer` 里 `seen` 集合先到先得，后来者打日志 `ignored because a higher-priority skill already exists`。

所以老目录留着同名技能，`.agents\skills` 里的出厂新版**永远加载不到**。用户选方案 B：

- 老的 `data\skills` 目录本身不动
- 只把与出厂同名的三个（`grilling`、`ub-mode`、`cua-driver`）**改名**（加 `.old` 后缀），一个字节都不删
- 改名可一条命令回退

> 注意：`data\skills` 里的 `agent-skills`、`skillhub-cli` 不与出厂同名，不动；三个 `.bak` 目录名带点、不合法，本来就被过滤掉。

## 怎么做

### 1. `app/src/main.mjs`：注入环境变量

`newHost()` 与 `newCheck()` 的 env 都加：

```js
DSH_AGENTS_HOME: join(places.dataDir, '.agents')
```

`newCheck()` 也要加，否则首启检查会去读真实的 `~/.agents`。

`watchFactorySkills` 的 `repoDirOf` 改为 `join(places.dataDir, '.agents', 'skills')`。

### 2. 出厂 AGENTS.md 的预置

新增 `app/resources/factory/AGENTS.md`，内容 = 那 341 字节。

`app/src/factory.mjs` 的 `installFactoryResources` 里加一步：把它拷到 `<数据目录>\.agents\AGENTS.md`。

**更新语义**：出厂件，每次启动覆盖（跟着安装包版本走）。用户自己要写的规矩写在 `<数据目录>\AGENTS.md`，那份优先级更高、永不被覆盖。

同时预置一份**空的** `<数据目录>\AGENTS.md`（Q4）。注意：只在该文件不存在时创建，绝不覆盖用户已有的内容——这条必须有测试守着。

### 3. 打包：出厂技能改落 `.agents/skills`

`app/scripts/factory-skills-pack.mjs` 的 `bundledSkillsDir`：
`build/data/skills` → `build/data/.agents/skills`

### 4. 安装器：搬运路径改到 `.agents\skills`，删掉 `.bak`

`app/build/installer.nsh` 里技能那一段：

- 源：`<INSTDIR>\data\.agents\skills\<slug>`（**两处都要带 `.agents`**）
- 目标：`$R1\.agents\skills\<slug>`
- **删掉** 317–321 的 `.bak` 备份逻辑
- `skills-sync.json` 的处理保留

### 5. 出厂种子的 locator

`app/resources/factory/factory-team.json` 里三个 `locator`：
`skills/xxx` → `.agents/skills/xxx`

`ds-bot/src/host/factory-seed.js` 是 `join(dshHome, locator)`，拼出来正好对，**宿主代码零改动**。

顺带修一个既有缺陷：种子引用 `skills/dsh-profile-plugin-ops`，但该目录在数据目录里根本不存在，这个种子技能一直挂不上。本次按实际存在的技能修正。

### 6. 测试

- `app/test/data-packaging.test.mjs`：`bundledSkillsDir` 断言跟着改
- `app/test/factory.test.mjs`：locator 正则 `^skills/` → `^\.agents/skills/`
- `app/test/helpers/app-harness.mjs`：补临时 `DSH_AGENTS_HOME`，测试绝不指向真实 `~/.agents`
- 新增：`newHost` 的 env 里带正确的 `DSH_AGENTS_HOME`
- 新增：`<数据目录>\AGENTS.md` 已存在时**不被覆盖**

## 验收标准

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 启动 Host 的 env 里有 `DSH_AGENTS_HOME` | 测试里读 fake host 的 `state.envs`，值 = `<dataDir>\.agents` |
| 2 | 首启检查（`DS_BOT_CHECK`）也带 | 同上，找 `env.DS_BOT_CHECK` 那条 |
| 3 | 出厂 AGENTS.md 落到 `.agents\AGENTS.md` | 文件存在且内容 = 341 字节那份 |
| 4 | 预置空 `<数据目录>\AGENTS.md` | 文件存在；**已存在时内容不变**（写测试） |
| 5 | 出厂技能打包到 `build/data/.agents/skills` | `bundledSkillsDir` 下三个 SKILL.md 都在，cua-driver 的 bin/ 也在 |
| 6 | 安装器不带 `.bak` | `installer.nsh` 里 grep 不到 `\.bak` 相关的技能备份段 |
| 7 | 种子 locator 指向 `.agents/skills/` | `factory.test.mjs` 正则通过 |
| 8 | `npm test` 全过 | `app/` 下跑 |
| 9 | 本机 `.agents` 技能真的生效 | 三个同名技能改名后重启，技能目录只剩 `.agents` 那份 |

## 不做的事

- 不迁移、不删除老的 `<数据目录>\skills` 里的任何内容（只改名三个）
- 不改 DSH 本身
- 不改插件的自动更新通道
- 不碰用户真实 `~/.agents`

## 开放问题

- 出厂 AGENTS.md 每次覆盖，用户若直接改那份文件，改动会在下次启动被冲掉——已在文档写清，用户规矩写 `<数据目录>\AGENTS.md`。若日后要"只写一次"，改 `installFactoryResources` 一个判断即可。
