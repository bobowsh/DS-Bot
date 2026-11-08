# 出厂插件与技能的内网自动更新

- 日期：2026-11-07（需求与设计对齐）；2026-11-08 补齐落盘
- 状态：**已实现（A/B/C/D 组），E 组验收待合并后正式重跑**
- 相关：Issue #12；[桌面应用](2026-10-16-desktop-app.md)、[出厂预制团队与技能仓库](2026-11-01-factory-team.md)、[固定数据位置与导入提示](2026-11-01-fixed-data-location.md)

## 为什么

内网环境装不了外网。出厂插件和技能如果只能靠「重打一个安装包、再让用户手动换掉」，每次上游更新都要重新分发整包，装机的机器永远停在出厂那天的版本。要的是**装机端不出外网、也能持续拿到新版**：插件走内网 Gitea，技能走内网 SkillHub，两者在 22:00 自动更新，用户零操作。

## 双通道

| 通道 | 管什么 | 用什么 | 更新源 |
|---|---|---|---|
| **插件通道** | 插件 | `dshmarket` | 内网 Gitea 的 catalog（`plugins.json`）+ Gitea 自带 npm registry |
| **技能通道** | 技能 | `skillhub-dsh`（官方 iflytek skillhub 的 `plugins/dsh`，fork 放宽 peer） | 内网 SkillHub 实例 |

两个市场插件本身也出厂预置、也登记进 catalog，实现「自举更新」。

`pn1024/dsh-skill-market` 名字带 skill 但**不入出厂清单**：它调的是不带 namespace 的平铺路径（`/api/skills`、`/api/v1/skills/batch`、`/api/v1/skills/{slug}/file`、`/api/v1/download?slug=`），与内网开源版 SkillHub 的 `{code,msg,data}` + `/api/v1/skills/{namespace}/{slug}/...` 结构不符，装上去会是一个连不上的坏插件。

## 已拍板的决策（用户逐条定，附理由）

| 决策点 | 结论 | 理由 |
|---|---|---|
| 更新源 | 插件 Gitea 公开仓、技能内网 SkillHub；装机端不出外网 | 内网机器的硬约束 |
| 触发 | app 运行时判「已过 22:00 且今日未查」补查；不注册系统计划任务 | 用户明确不想要高频定时任务，也不要动系统 |
| 版本标准 | 插件认 git tag；技能用 SkillHub 自身版本管理 | 复用两者已有的版本语义 |
| 清单能变 | catalog 新增条目 = 上新，自动安装；删除 = 下架 | 出厂清单要能演进，不能钉死 |
| 禁用语义 | 用户禁用过的（bundles 无条目）只升文件、不写回 bundles | 新装 ≠ 解禁用户手动禁用 |
| 生效方式 | 22:00 全自动：检查 → 下载 → 安装落盘，装完提示「已更新 N 项，重启生效」 | 用户特别强调：不是只挂角标让用户自己点 |
| 技能通道 | 技能由 SkillHub 分发，不并进插件通道 | 两条链路的治理与版本模型不同 |
| npm 依赖源 | Gitea 自带 npm registry，打包机预导依赖树 | 装机端不能联网装依赖 |
| 新插件语义 | catalog 新增条目自动装**且自动启用**（写 bundles） | 上新即生效，否则等于没装 |
| 下架语义 | 只停止更新，不自动卸载 | 卸载是破坏性操作，不能自动做 |
| 错过 22:00 | 不补查，只认当天 22:00 | 避免一天内反复触发 |
| 信任链 | catalog 的 `allowBuilds` 预批白名单；出厂插件尽量预构建分发（dist 进仓、无 install 脚本） | 没人审过的安装脚本不能自动跑 |
| 兼容熔断 | 装前过 `discovery-compatibility`（`engines.dsh` 匹配），不兼容跳过次日再看 | 新版不兼容宿主时不能把机器搞坏 |
| 失败熔断 | 同一版本连败 3 次拉黑，等 catalog 出新版 | 防止对坏包无限重试 |
| 多机 | 各机独立检查，接受版本短时漂移 | 内网无中心调度 |
| DS Bot 本体 | **out of scope**：内核升级手动装新包，不走自动更新 | 自动换内核风险太大 |
| 分支 | 默认分支 `dev-me`（2026-11-08 改名为 `master`） | 与上游 `dev` 区分自己的线 |

## 怎么实现的

### 插件通道（`app/src/factory-update.mjs`）

1. **定时器**：每小时检查一次，`dueForCheck()` 判断「过 22:00 且 `factory-update.json` 里没有今日已查标记」。
2. **主链路**：读 catalog → 比对 profile `package.json` 的 dependencies → 取 tarball → 解到 staging → **版本校验**（归档必须带 catalog 声明的版本）→ 旧版移入 backup → 原子替换 → 失败回滚旧版。
3. **三道闸**：① 归档版本不符即拒、保留旧版；② 归档不带 `dsh` 清单即拒；③ 构建脚本（preinstall/install/postinstall）只许出厂清单上的包携带。连败 3 次当天拉黑。
4. **增删语义**：新增条目自动装并记入 manifest（dependency + bundles）；删除条目只停更不卸载；禁用过的插件只升文件、绝不写回 bundles。
5. **提示**：`dialog.plugin.updated` 文案 + 窗口出现后提示「已更新 N 项，重启生效」。
6. **接线**：`host.mjs` 的 `patchFiles` 挂 `writeFactoryRegistryPatch(profile)`（给 skillhub-dsh 写 `registryUrl`）；`main.mjs` 的 `newHost()` env 传 `DSHM_REGISTRY_URL`；地址常量统一在 `profile.mjs`。

### 技能通道

- **出厂导入**（`app/scripts/import-skills.mjs`）：走官方 SkillHub CLI，`login` → `publish --dry-run`（全量校验）→ `publish`（只发服务端缺的 slug）。缺 frontmatter 的在一次性副本里补全，源文件不动。token 只走环境变量。
- **每日更新**（`app/src/factory-skills-update.mjs`）：比对已装技能与 SkillHub latest，拉 zip 落盘。契约是 `resolve → documentation`，路径必须带 **namespace + version** 两段（不带 version 段不可用，这一点实测过）。
- 出厂技能 4 个：`grilling`、`ub-mode`、`review-skill`、`dsh-profile-plugin-ops`，已全部发布进内网 SkillHub。

### 离线工具

内网 SkillHub CLI 及操作技能落在仓库外 `E:\dsbot-work\skillhub-cli\`（官方 `@astron-team/skillhub` 0.3.1 的 1.19 MB 自包含 bundle，单文件 + package.json 可离线跑），不进 git。

## 验收标准

- **断网全流程**：首启拿到出厂 data → Gitea 打新 tag / SkillHub 传新版 → 22:00 后出现「已更新 N 项，重启生效」→ 重启后版本已升。
- **catalog 加一条新插件** → 自动装出且可禁用；**禁用过的更新后仍禁用**。
- **下架**：catalog 删条目 → 只停更，不卸载。
- **失败路径**：源不可达 / 装失败 → 回滚旧版、日志可查、次日重试。
- **兼容熔断**：`engines.dsh` 不满足的条目跳过，次日再看。
- **skills-repo 用户本地改动不被覆盖**（沿用 #2 硬约束）。

## 还没定的开放问题

- **Q6 版本门的约束来源**：`engines.dsh` 写在哪里？三个候选——(a) 插件 `package.json` 的 `engines.dsh`（issue 原文点名，需解包后判）；(b) catalog 新增字段（要改 `gen-catalog.mjs` 与人审流程）；(c) 归档内 manifest 的 `dsh.engines`（与现有 dsh 清单门同源，改一处即可）。内网 catalog 现有字段为 `name, owner, url, npm, registry, category, description, page, added, installedVersion, tag, source, upstream`，其中 `installedVersion` 是已装插件版本，不是宿主要求。

## 实现中的踩坑记录

- **启动即崩**：`factory-update.mjs` 曾 `import { unpackTgz } from './import-plugin.mjs'`，而 #10 把随包分发改成纯文件夹后删了这个导出 → ESM 解析失败、主进程起不来。修法：解包能力由 C2 自己持有（`readTgz` + `unpackTgz` 移进本模块）。
- **`app/node_modules/ds-bot` 是副本**：改 `ds-bot/` 不更新它，打包会带旧插件。打包前必须 `npm ci`。
- **SkillHub file 端点**：不带 version 段返回 401/500，带 `namespace + version` 才 200 返真内容。测端点先对准契约形状。

## 落地状态

| 组 | 内容 | 状态 |
|---|---|---|
| A | profile 三处内网地址 + 两行接线 | PR #20 |
| B1 | catalog 生成器（13 条） | 已合（PR #17） |
| B2 | dsh-skill-market 出厂 | 不做（见上） |
| C1-C4, C6 | 定时器、主链路、增删语义、三道闸、提示 | PR #20 |
| C5 | 技能更新 | 技能通道分支 |
| D1 | skills-repo 导入 SkillHub 4/4 | PR #21 |
| D2 | 4 端点兼容实测 | PR #21 文档 |
| E | 端到端五场景 | PR #21（预跑，合并后正式重跑） |
