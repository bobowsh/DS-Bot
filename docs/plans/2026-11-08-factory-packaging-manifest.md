# 出厂插件与技能的打包与预置（清单驱动）

- 日期：2026-11-08
- 状态：**设计定稿，待实施**
- 相关：Issue #12；[出厂插件与技能的内网自动更新](2026-11-07-intranet-auto-update.md)、[出厂预制团队与技能仓库](2026-11-01-factory-team.md)

## 为什么要有这份文档

#12 把「运行时自动更新」做完了，但**打包这一环没对齐**：实际打出 9 个插件、用户定的 13 个里有 8 个没进去，其中 `dshmarket` 和 `skillhub-dsh` 正是两条更新通道的插件本体——按原来的打包脚本出的包，**自动更新根本没有执行者**。

同时技能侧还在用 `skills-repo` 的 git 方式，用户已明确**废弃**。

这份文档定的是：**按一份人维护的清单，把 13 个插件和出厂技能预置进安装包**。

## 已拍板决策（用户 2026-11-08）

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 清单形态 | **两层**：`app/factory.manifest.json` 是打包输入；`data/factory/plugins.json` 是运行时清单（格式与路径不变）。**运行时要读清单**，C3/C4 靠它判出厂插件与预批白名单 |
| Q2 | 技能目录 | `data/skills/<slug>/SKILL.md`，**两层结构**，源目录的子目录就是技能 |
| Q3 | 插件来源 | 优先从内网 Gitea 拉；**连不上才从本地 `E:\dsbot-work\dsh-plugins-dev\` 拷**。放**解包后的目录**，不是 tarball |
| Q4 | 技能来源 | **从 `E:\dsbot-work\skills\` 拷**；`skills-repo` 的 git 机制**彻底废弃** |
| Q5 | 验收 | 打安装包 → **实际安装到 `D:\LinkBot`** → 跑起来确认正常加载出出厂插件与技能 |
| Q6 | 分支 | **新拉分支补 #12 未实现内容**；讨论结果同步更新到 #12，issue 正文只写要点、不写细节，引用本文档 |

### 出厂插件清单（12 个，用户定）

`dsh-chat-import`、`dsh-xdpool`、`dshmarket`、`@linxin666/dsh-client-ui-git-graph`、`dsh-rule-manager`、`dsh-tool-activator`、`skillhub-dsh`、`dsh-aide`、`dsh-better-sidebar`、`dsh-screenshot-native`、`ds-harness-remote`、`dsh-plugin-guide`

> **变更**：`dsh-computer-use-win` 用户 2026-11-08 明确**不要了**，清单从 13 个减为 12 个。

### 出厂技能清单（3 个，用户定）

`grilling`、`ub-mode`、`cua-driver`

> **变更**：用户 2026-11-08 追加 `cua-driver`。该技能来源是本机已装的 `D:\Users\bobowsh\.dsh\skills\cua-driver`（9 个文件 / 约 164 KB，frontmatter `name: cua-driver`、`version: 0.36.0`）。
>
> **依赖提示**：`cua-driver` 的 frontmatter 声明 `metadata.openclaw.requires.bins: [cua-driver]`——技能本身能用，但需要目标机器上有 `cua-driver` 可执行文件。本次**只预置技能文件，不预置该二进制**；装机端若没有这个命令，技能会加载但调用会失败。这一条要写进验收说明，由用户决定后续是否连二进制一起分发。

## 现状盘点（2026-11-08 实测）

### 插件

| 项 | 事实 |
|---|---|
| `app/scripts/before-pack.mjs` 的 `BUNDLED_PLUGINS` | **9 个**，与 13 个清单不符 |
| 13 个里缺的 | `dshmarket`、`skillhub-dsh`、`dsh-aide`、`dsh-better-sidebar`、`dsh-screenshot-native`、`ds-harness-remote`、`dsh-plugin-guide`（共 7 个） |
| 13 个之外多出的 | `dsh-session-manager`、`@copylee/dsh-computer-use`、`@jayyuen66/dsh-ocr-review`（用户明确：**不保留**） |
| 本地可用的 12 个 | `E:\dsbot-work\gitea-mirror\` 有 11 个（均无 install 脚本）；`dshmarket` 的 mirror 只有 `.git`，需从 `profiles\desktop\node_modules\dshmarket`（v1.70.2）拷 |
| `E:\dsbot-work\dsh-plugins-dev` | 只有 9 个，且 `dsh-computer-use` 是 `pack/`+`src/` 结构（无根 package.json），与清单要的 `dsh-computer-use-win` **不是同一个包** |

### 技能

| 项 | 事实 |
|---|---|
| `app/resources/skills-repo/` | 4 个技能（`grilling`、`ub-mode`、`review-skill`、`dsh-profile-plugin-ops`），均有 `SKILL.md` |
| `E:\dsbot-work\skills\` | 目前只有 `ai-sdlc`（27 个 SKILL.md），**待把 `grilling`、`ub-mode` 归集进来** |
| `dist-pack\data\skills\` | **不存在**；现在是老的 `skills-repo/` |

### 运行时清单

`<data>\factory\plugins.json` 已存在，格式 `{plugins:[{name,...}]}`，**只认 name，version 被忽略**。

- C4 预批门：`app/src/factory-update.mjs` 的 `factoryApprovedNames()`
- C3 出厂判定：`app/src/bundled-plugins.mjs`
- 生成者：`app/scripts/bundled-plugin.mjs`（打包时从装配产物写）
- **本次不改它的格式与路径**，运行时代码零改动。

## 设计

### 1. 清单文件 `app/factory.manifest.json`

人维护的打包输入。每条带版本，用来核对「包里是不是这份清单说好的东西」。

```json
{
  "plugins": [
    { "name": "dsh-chat-import", "version": "0.26.4" },
    { "name": "dsh-xdpool", "version": "2.6.1" },
    { "name": "dshmarket", "version": "1.70.2" }
  ],
  "skills": [
    { "slug": "grilling" },
    { "slug": "ub-mode" }
  ]
}
```

### 2. 来源解析（插件）

打包时按优先级找包目录：

1. **内网 Gitea npm registry**（`http://192.168.1.10:3000/api/packages/dshplugin/npm/`）——能连上就以它为准，用 registry 上的 tarball 解包
2. **本地 `E:\dsbot-work\dsh-plugins-dev\<name>\`**——连不上时的兜底，要求目录里直接有 `package.json`
3. 都没有 → **打包失败并报出缺哪个**，不许静默跳过

版本核对：解析到的 `package.json` 版本必须与清单一致，不一致就报错（避免打出一个版本漂移的包）。

### 3. 来源解析（技能）

1. 从 `E:\dsbot-work\skills\<slug>\SKILL.md` 拷
2. 找不到 → 报错

`skills-repo` 的 git 机制（`app/scripts/skills-repo-git.mjs`）**删除**，`before-pack.mjs` 里的调用一并去掉。

### 4. 输出布局

```
app/dist-pack/data/
├── factory/
│   ├── plugins.json          ← 运行时清单（C3/C4 读，格式不变）
│   └── plugins.txt           ← NSIS 安装器用（纯名字）
├── profiles/ds-bot/node_modules/
│   ├── dsh-chat-import/      ← 13 个，解包后的目录
│   ├── @linxin666/dsh-client-ui-git-graph/
│   └── ...
└── skills/
    ├── grilling/SKILL.md     ← 2 个
    └── ub-mode/SKILL.md
```

### 5. 打包脚本改动

- `app/scripts/bundled-plugin.mjs`：来源从「`app/node_modules` 或 `pack/`」改为「Gitea → `dsh-plugins-dev`」，按 manifest 遍历
- `app/scripts/before-pack.mjs`：`BUNDLED_PLUGINS` 常量删掉，改读 manifest；去掉 `ensureSkillsRepoGit`；新增技能预置步骤
- `app/scripts/skills-repo-git.mjs`：**删除**
- `app/electron-builder.yml` / `app/build/installer.nsh`：`extraFiles` 与安装器搬运逻辑跟上 `skills/`（替代 `skills-repo/`）

## 验收标准

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 清单 12 个插件全部进包 | `dist-pack/data/profiles/ds-bot/node_modules/` 下有 12 个对应目录，版本与 manifest 一致 |
| 2 | 清单 3 个技能全部进包 | `dist-pack/data/skills/{grilling,ub-mode,cua-driver}/SKILL.md` 存在 |
| 3 | 运行时清单正确 | `dist-pack/data/factory/plugins.json` 的 `plugins[].name` = 12 个 |
| 4 | 不多不少 | 不出现 `dsh-session-manager`、`@copylee/dsh-computer-use`、`@jayyuen66/dsh-ocr-review`、`dsh-computer-use-win` |
| 5 | **实际安装可用** | 打安装包 → 装到 `D:\LinkBot` → 启动程序 → 插件与技能**正常加载**，界面/日志可见 |
| 6 | 断网可打包 | 内网不可达时，从 `dsh-plugins-dev` 与 `skills` 兜底，打包成功 |
| 7 | 缺件不静默 | 故意删一个包，打包应失败并报出名字 |

## 后续怎么更新（两种机制，互不依赖）

### 运行时自动更新（已实现，本次不改）

**插件通道**读的是两边实时数据，**不读包里的清单**：

| | 从哪读 |
|---|---|
| 本地装了什么 | `<data>/profiles/ds-bot/package.json` 的 `dependencies` |
| 远端最新是什么 | **Gitea catalog 的 `plugins.json`**（`DSHM_REGISTRY_URL` 指过去） |

`outdated(installed, catalog)` 逐条比对版本；只在 `dependencies` 里的才更新（用户禁用的不碰）。

**技能通道**同理：

| | 从哪读 |
|---|---|
| 本地有什么 | `<data>/skills/` 目录 |
| 远端最新是什么 | SkillHub `/api/v1/skills` |
| 上次同步到哪版 | `skills-sync.json` |

所以**包里的清单不需要更新**——更新靠远端实时数据。包里的清单只是「出厂基线快照」，用于：C3 判断哪些是出厂插件、C4 的 `allowBuilds` 预批、安装器搬运白名单。

### 换安装包（覆盖安装）

`installer.nsh` 现有逻辑：读 `data/factory/plugins.txt` 逐行 → 把 `<INSTDIR>\data\profiles\ds-bot\node_modules\<名>` 整体替换到数据目录。**只动清单上的名字**，用户自己装的插件不碰。

**技能侧要改**（因为 `skills-repo` 废弃了）。用户 2026-11-08 定：**(c) 覆盖但先备份 `.bak`**。

新逻辑：

1. 对 manifest 里的每个技能 `<slug>`：
   - 目标目录已存在 → 先把现有内容复制到 `<data>/skills/<slug>.bak/`（同名多次升级只保留最近一次备份）
   - 用包里的覆盖
2. 包里有、数据目录里没有的技能 → 直接复制进去
3. 数据目录里有、包里没有的技能（用户自己加的）→ **不动**
4. 原 `skills-repo` 的 `.git` 脏检查逻辑 → **删除**

`skills-sync.json` 的处理：技能文件被安装包覆盖后，其记录的版本可能已过时。第一次运行时 C5 会发现「本地版本 ≠ SkillHub 版本」并重新落盘——这是安全的，因为覆盖本身就来自同一个源。若要让升级后不重复下载，可在安装器覆盖后删掉 `skills-sync.json` 里对应 slug 的记录（让它走「首次只记录」分支）。**采用后者**，避免无谓的下载。

## 不做的事

- 不改 `<data>/factory/plugins.json` 的格式与路径（运行时代码不动）
- 不改 #12 的运行时更新逻辑（C1/C2/C3/C4/C5/C6）
- 不碰用户自己的数据目录
- `dsh-plugins-dev` 里的 `dsh-computer-use`（`pack/` 结构）不参与本次清单
- **不预置 `cua-driver` 二进制**，只预置技能文件（依赖风险见上）

## 开放问题

- **Gitea 恢复后**要不要重新从 registry 拉一遍做交叉校验（本地已装副本 vs registry tarball 是否一致）？建议恢复后补一次，本次先按本地。
- `dsh-plugins-dev` 目前缺 8 个，本次实施第一步就是把它们归集进去（内含 `dshmarket` 从已装副本拷这件特殊处理）。
