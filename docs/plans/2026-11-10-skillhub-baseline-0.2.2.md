# 技能装不上：宿主依赖基线不匹配

Refs #（技能安装失败，待小队长开 issue 号回填）

## 要解决什么

用户在 LinkHarness 桌面端点技能中心的「安装」，技能装不上。
服务端完全正常，五个端点全 200：

```
GET /api/v1/skills                              → 200  2939B
GET /api/v1/skills/global/ub-mode                → 200
GET /api/v1/skills/global/ub-mode/versions       → 200
GET .../resolve                                  → 200
GET .../download?version=20261108.022844         → 200  2745B
```

所以问题不在网络、不在服务端，而在客户端的安装落盘那一段。

## 根因

`@astron-team/skillhub-dsh` 0.6.2 把宿主依赖基线写死成一组：

| 依赖 | 插件要求的版本 | LinkHarness 桌面端实际版本 |
|---|---|---|
| `@deepseek-ai/cordis` | `4.0.4`（另接受 `4.0.5`） | **4.1.0** |
| `@deepseek-ai/dsh-fs` 等 9 个 | `0.2.0-rc.2`（另接受 `0.2.1-rc.2` / `0.2.1-rc.5`） | **0.2.2-rc.1** |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.5` / `1.0.6` | **1.1.0** |
| `@deepseek-ai/cordis-plugin-include` | `1.0.9` / `1.0.10` | **1.1.0** |
| `@deepseek-ai/cordis-plugin-timer` | `1.1.6` / `1.1.7` | **1.2.0** |

桌面端跑的是 DSH `0.2.2-rc.1`（见 `app/package.json` 的 `@deepseek-ai/dsh*: 0.2.2-rc.1`），
基线对不上，于是：

1. `assertHostDependencies()` 抛 `Host dependency baseline does not match; local writes are disabled.`
2. `assertRuntimeCompatibility()` 抛 `Host runtime baseline could not be verified; local writes are disabled.`
3. `getCompatibility()` 于是返回 `{ dependencyBaseline: 'unverified', localWritesAllowed: false }`
4. 客户端的 `useWritableHost()` 得到 `canWrite === false`，**安装、升级、卸载、恢复写入全部被禁**

这不是安装流程里的某个分支出错，而是整个写入门禁在入口就被关掉了。

### 实测证据

离线复现脚本 `tmp/skillprobe/probe-baseline.mjs`，读已安装 `app.asar` 解包后的真实包版本：

```
FAIL @deepseek-ai/cordis  actual=4.1.0  expected=4.0.4
FAIL @deepseek-ai/dsh-fs  actual=0.2.2-rc.1  expected=0.2.0-rc.2
...（10 项全 FAIL）
release = 0.2.2-rc.1  cordis = 4.1.0
assertHostDependencies 结果 = 抛错: Host dependency baseline does not match; local writes are disabled.
assertRuntimeCompatibility 结果 = 抛错: Host runtime baseline could not be verified; local writes are disabled.
=> SkillHub getCompatibility().localWritesAllowed = false
```

复现脚本在本仓库 `tmp/` 下，不入库。

## 边界

- 只改 `@astron-team/skillhub-dsh`（第三方插件的**内网 fork**），
  不改已安装的 profile 里的那份、不改上游 GitHub。
- 不放宽「缺包 / 混版 / 未验证的中间版本一律拒绝」这条安全边界。
- 不改 DS Bot 仓库自身代码；本仓只留方案文档与验收记录。

## 怎么做

把「一组写死的版本」改成**按宿主版本表校验**。

### 1. `src/host/compatibility.ts`

- `hostDependencyReleases`：一张表，每行是一个宿主版本，列出它对应的 DSH 依赖版本，
  以及它允许使用的 Cordis 版本与 Cordis 家族下标。
- `matchHostRelease(resolved)`：按实际解析结果匹配宿主版本。
- `matchCordisFamily(resolved)`：按实际解析结果匹配 Cordis 家族。
- `assertHostDependencies()`：先匹配宿主版本，再检查 Cordis 是否在该版本允许的家族里。

新增一行宿主版本 = 新增一行表，不是再加一段硬编码。

### 2. `src/host/runtime-compatibility.ts`

- 读包的名单从表里取（`hostDependencyReleases` + `cordisFamilies` 的键），
  不再另有一份硬编码名单。
- 校验：`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-app-boot` 必须同版本；
  `matchHostRelease` 的结果必须等于 `dsh` 的版本；Cordis 家族必须完整且在该版本允许列表里。
- 保留原有「检查宿主自身的依赖解析，不只看插件的 peer 副本」这一层。

### 3. `package.json`

`peerDependencies` 放宽到四个宿主版本，cordis 放宽到 `4.0.4 || 4.0.5 || 4.1.0`。
不放宽的话插件在新宿主上根本装不上。

### 4. `scripts/smoke-native-host.mjs`

原生冒烟脚本里的 `selectDshVersion` 改成按版本取对应 Cordis 家族，
不再写死「只有 0.2.0-rc.2 能用 retained 家族」。

## 验收标准

1. **真实宿主上判定为可写**：用已安装 `app.asar` 解包出的真实版本跑
   `assertRuntimeCompatibility`，返回 release `0.2.2-rc.1` 且不抛错。
2. **旧宿主不被破坏**：模拟 rc.2 / rc.2 / rc.5 三组版本，仍分别匹配到各自宿主版本。
3. **安全边界不松**：缺包、混版、未验证的中间 RC（`0.2.1-rc.3` / `0.2.1-rc.4` /
   `0.2.2-alpha.3`）、畸形的 manifest，一律仍然拒绝。
4. **上游测试全绿**：`bun test` 759 pass / 4 skip / 0 fail。
5. **类型与 lint**：`bun run typecheck` 与 `bun run lint` 退出码 0。
6. **真机**：装机后打开技能中心，不出现「依赖基线未通过」的红条，
   点「安装」能弹出安装确认并走完。

## 已拍板的决策与理由

- **改内网 fork，不改上游**：用户 2026-11-07 定了「Gitea 出厂插件仓不做自动同步，
  有外网上游仓库时人工先拉到本地再推送」。本机已有上游完整仓库
  （`E:\dsbot-work\gitea-mirror\_skillhub_extract\skillhub-main`），
  改动以它为基线，再推到内网 Gitea。
- **不靠「关掉校验」蒙混**：把校验关掉会让插件在任意宿主上乱写文件，
  比装不上技能更危险。改成「认得这个宿主版本」才是正解。
- **表驱动而不是加 if**：DSH 会继续出版本，写死清单每升一次宿主就要改一次代码。
  表驱动让「加一个宿主版本」变成「加一行表」。

## 还没定的开放问题

- 装机 profile 里的插件是**手改文件**换上的 0.6.3。正式做法应该是走插件管理器
  从内网 npm 装 `@astron-team/skillhub-dsh@0.6.3`，等小队长定打包流程时一并处理。
- 0.6.2 与 0.6.3 的 npm 包都在内网 registry 上，`latest` 指向哪个需要在打包前确认，
  避免用户装到旧版。
- 真机「安装」落盘的最终验收，需要在打包后的新版本上再走一遍（当前是手改 profile 验证的）。
