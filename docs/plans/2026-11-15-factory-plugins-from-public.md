# 出厂插件改从外网拉取，之后由 dshmarket 自动升级

- 日期：2026-11-15
- 状态：**方案待确认**（本文只写调研与设计，没有实现代码）
- Refs #12（出厂插件与技能分发）

## 一、要解决什么

用户要求：**出厂插件改成打包时从外网拉下来，后续自动通过 dshmarket 升级。**

现在的情况：出厂插件在打包时从内网 registry（`http://192.168.1.10:3000/...`）用 `npm pack` 拉下来，塞进安装包的 `data/profiles/ds-bot/node_modules/`，版本写死在 `app/factory.manifest.json` 的 11 条里。内网服务一起不来，构建就回退到本地开发目录 `E:\dsbot-work\dsh-plugins-dev`（今天已经踩过一次：skillhub 目录还是 0.6.2，manifest 要 0.6.3，构建直接报「refusing to pack a drifted version」）。

## 二、现状盘点（读源码得到，非推断）

### 2.1 打包侧

| 位置 | 现状 |
|---|---|
| `app/scripts/bundled-plugin.mjs:22-24` | `factoryRegistry()` = `process.env.DS_BOT_FACTORY_REGISTRY` 或硬编码 `http://192.168.1.10:3000/api/packages/dshplugin/npm/` |
| `app/scripts/bundled-plugin.mjs:81-83` | 先探一次 registry 可达性，不可达就整体回退本地开发目录 |
| `app/scripts/bundled-plugin.mjs:sourceOf()` | 可达 → `packFromRegistry()`（`npm pack`）；不可达或拉取失败 → 本地 `dsh-plugins-dev/<leaf>` |
| `app/scripts/bundled-plugin.mjs:89` | 版本漂移硬校验：`manifest.version !== entry.version` 直接抛错拒绝打包 |
| `app/scripts/gen-catalog.mjs:13-14` | 单独脚本，`API = http://192.168.1.10:3000/api/v1`、`REG = .../npm/`，从内网 Gitea 生成目录 |
| `app/factory.manifest.json` | 11 个插件 + 4 个 skills + 2 个语言服务器 + 1 个默认关闭项 |

> `gen-catalog.mjs` 与出厂清单**不是同一条链**：它生成的是内网插件市场目录（`plugins.json`），出厂清单是 `factory.manifest.json`。改公网时两处都要动，但**理由不同**，别混为一谈。

### 2.2 运行时升级侧：dshmarket 有官方编程接口

dshmarket **不是纯 UI 层**，它对外有一套版本化 JSON API（随包自带 `UPDATE-API-V1.md`，208 行）：

```http
GET  /dsh-market/api/v1/capabilities           # 发现能力：features / endpoints / restart 归属
GET  /dsh-market/api/v1/updates/summary        # 有多少可更新
GET  /dsh-market/api/v1/updates?name=X&force=1  # 查一个包
POST /dsh-market/api/v1/updates  {"packageName": "X"}   # 提交更新，202 + operationId
GET  /dsh-market/api/v1/operations?operationId=<id>      # 轮询：queued/running/succeeded/failed/cancelled/rolled-back
POST /dsh-market/api/v1/rollback               # 回滚
```

它的可靠性与安全设计（原文）值得记下来：

1. **成功以磁盘为准**：`For npm updates, Market verifies the package version that pnpm actually placed on disk before reporting success.` 也就是它自己会防「pnpm release-age 策略或滞后镜像把 `@latest` 变成旧版」。
2. **有稳定失败码**：`DOWNGRADE_DETECTED`、`RESOLVED_VERSION_MISMATCH`（后者可重试）、`RELEASE_TOO_FRESH`、`VERSION_UNCHANGED`。
3. **有兼容回滚点**：`whether a compatibility rollback is currently available`，失败会 `restored from the pre-update recovery point`。
4. **底层是 pnpm**：`When pnpm provides it`、`the package version that pnpm actually placed on disk`。所以它确实是「底层装包靠 pnpm，自己负责编排、校验、回滚」。
5. **状态只活在本进程**：`Up to 50 operation records live in the current Host process.`，且 operationId 内嵌 boot id —— 重启后旧 operationId 失效。

### 2.3 关键阻塞：这个 API 拒绝外部脚本

`UPDATE-API-V1.md:79-87` 原文：

> Mutation requests require the same-origin protection used by the Market UI.
> Every endpoint here — reads included — also sits behind DSH's own browser login ... a request without the host's session cookie is answered `401`, and one from an untrusted origin `403` ... **A script or tool calling these endpoints from outside the browser is the anonymous client this refuses; there is no separate token for it.**

**这决定了运行时自动升级不能是我们宿主机进程去 `fetch` 那些路由**（会被 401/403）。原文说得也很明确：这条路没有给外部脚本留 token。

## 三、内网地址全量清单与逐处处置

`git grep -n "192.168.1.10" -- app` 实测 **11 处代码 + 3 处测试断言**（比队长扫的 9 处多：`factory-skillhub-metadata.mjs:14` 是带环境变量兜底的写法，容易漏；测试里的断言也要跟着改）。

| # | 位置 | 现在 | 处置 | 理由 |
|---|---|---|---|---|
| 1 | `app/scripts/bundled-plugin.mjs:24` | `factoryRegistry()` 兜底内网 npm | **改公网**：npmmirror → npmjs，内网靠 `DS_BOT_FACTORY_REGISTRY` 显式指 | 打包主链，本次核心 |
| 2 | `app/scripts/gen-catalog.mjs:13` `API` | 内网 Gitea API | **不动**（标注「仅内网部署用」） | 它生成的是**内网市场目录**，与出厂清单两条链；动了会破坏内网部署 |
| 3 | `app/scripts/gen-catalog.mjs:14` `REG` | 内网 npm | **不动**（同上） | 同上 |
| 4 | `app/scripts/factory-skillhub-metadata.mjs:14` | `SKILLHUB_REGISTRY` 兜底 8081 | **不动** | 技能中心，用户这次只说出厂插件 |
| 5 | `app/scripts/import-skills.mjs:21` | `SKILLHUB_REGISTRY` 写死 8081 | **不动** | 同上 |
| 6 | `app/src/profile.mjs:38` `NPM_REGISTRY` | 内网 npm → 写进 profile 的 `.npmrc` | **改公网**（npmmirror） | 用户装插件时 pnpm 用它，内网不通就会卡住；这条与 dshmarket 装包直接相关 |
| 7 | `app/src/profile.mjs:39` `SKILLHUB_REGISTRY` | 内网 8081 | **不动** | 技能中心 |
| 8 | `app/src/factory-update.mjs:85` `CATALOG_URL` | 内网 dsh-catalog 的 plugins.json | **保留内网，但默认关闭自动更新**（见下） | 它是「工厂插件自动更新」这条线；既然改由 dshmarket 管，这条应退场而不是换源 |
| 9 | `app/src/factory-update.mjs:87` `NPM_REGISTRY` | 内网 npm | **保留**（只服务第 8 条那条线） | 与第 8 条同生共死；若第 8 条关掉，它跟着不走 |
| 10-12 | `app/test/factory-registry.test.mjs:14,15`、`app/test/import-skills.test.mjs:100` | 断言内网地址 | 跟着对应改动更新 | 不更新的就是假绿灯 |

### 关于第 8 条（`CATALOG_URL`）为什么选「保留内网 + 默认关闭自动更新」

三个选项对比：

| 选项 | 后果 |
|---|---|
| 改成 dshmarket 官方目录 `awesome-dsh-plugin.com` | **不可用**：实测带宽约 10 KB/s，15.3 MB 要 25 分钟（今天刚为这个把市场改成走 npm 镜像） |
| 改成 npmmirror 的 `dsh-plugin-catalog` 包 | 技术上可行，但那是**公开插件目录**（10,974 条第三方插件），**不是我们的出厂插件清单**；拿它当「工厂插件更新源」语义完全错了，会把一堆第三方插件当出厂插件去装 |
| **保留内网、默认关闭这条自动更新** | 出厂插件的来源与升级都交给了「打包 + dshmarket」，这条线本来就该退场；内网部署想用还能显式打开 |

所以选第三条：`CATALOG_URL` 不换源，把 `updateFactoryPlugins` 的**默认开关关掉**（内网部署用环境变量或配置显式启用）。**离线场景**因此不受影响——离线装机本来就靠包内已带的那份插件，不靠这条自动更新。

## 四、三种理解方式的可行性与代价

用户说的「从在线 dshmarket 安装」可以落成三种形态：

| | 形态 | 可行性 | 代价 | 结论 |
|---|---|---|---|---|
| **A** | 安装包**不内置**出厂插件，首启由宿主调 dshmarket 从在线目录装 | **技术上被 2.3 挡住**：宿主进程不在浏览器里，调 `/dsh-market/api/v1/updates` 会被 401/403。除非我们在宿主侧自己实现 pnpm 安装（那就不是「用 dshmarket」了），或者让用户在 UI 里点一次 | 首启必须联网；离线装机直接没有插件；首次打开要等下载 | **不推荐** |
| **B** | 仍内置，但打包时**从公网拉**（npmmirror 优先，回退 npmjs），版本按 manifest 固定 | **完全可行**，就是改 `factoryRegistry()` 的默认值与兜底顺序 | 构建需要联网；版本由 manifest 说了算 | **推荐（打包侧）** |
| **C** | B + 运行时由**用户**在 dshmarket 里升级（市场已能检查/更新/回滚，改动零成本） | **完全可行**，dshmarket 本来就是这个职责 | 升级是用户动作，不是自动 | **推荐（运行时侧）** |

用户原话是「打包时从外网拉下来，后续自动通过 dshmarket 升级」。**B 段与用户说的完全一致**；C 段需要说清一件事：

> **「自动」到什么程度？** dshmarket 的 API 只接受同源浏览器请求，我们**不能在宿主进程里偷偷替用户升级**（技术上被拒、语义上也不该）。能做的「自动」是：
> - (i) **市场自己会检查**：打开插件页就有更新红点和「可更新 N 个」；
> - (ii) 若用户要「连点都不点」，那就得**改 dshmarket 或让它支持宿主令牌**——那超出「用 dshmarket」的范围，且它是第三方插件，我们不该改它包内代码（用户此前也定过：第三方插件改动要落在源码仓库并保持 dist 同步，我们不能替上游做）。
>
> 所以我建议：**打包从公网拉（B）+ 升级走市场 UI 一键（C）**，并额外做一件**只读**的事 —— 宿主启动后**检查**有没有可更新（读市场公开的 `updates/summary` 也受同源限制，所以改为**我们自己按 npm registry 比对 manifest 版本**，只提示、不动手），把「有新版本」写进日志/设置页。

## 五、推荐方案

### 5.1 A 段：打包从公网拉

1. `factoryRegistry()` 默认值改为 **npmmirror 优先、npmjs 回退**：
   - 首选 `https://registry.npmmirror.com`（实测：`dsh-plugin-catalog` 5 MB / 0.52 秒，比官方域名快三个数量级）
   - 回退 `https://registry.npmjs.org`（实测：HTTP 200 正常）
   - 保留 `DS_BOT_FACTORY_REGISTRY` 环境变量覆盖（内网装机时指向内网源，**不删这条能力**）。
2. **版本策略：manifest 继续写死精确版本**，不做「拉 latest 再回写清单」。理由：
   - 我们的构建是**可复现的**：同一 tag 打出来的包插件版本必须一样，否则出问题无法定位；
   - `dsh-plugin-guide` 这类插件带 `engines.dsh` 的版本门（实测 `0.5.9` 要求 `>=0.2.2-0 <0.3.0`），`latest` 随时可能越过宿主范围，**拉 latest 迟早打出装不上的包**；
   - 已经有过教训：skillhub 目录 0.6.2 vs manifest 0.6.3，漂移直接拒绝打包。
   - 升级版本的方式改为**显式改 manifest**（一条命令或手工），改完版控可见。
3. `gen-catalog.mjs` 的内网常量：它生成的是**内网市场目录**，与出厂清单无关。本次**改公网后它就用不到了**，建议保留但标注「仅内网部署用」，或单独 issue 处理。本 PR 不删它。

### 5.2 B 段：运行时只做「检查 + 提示」，升级交给市场

| 做什么 | 怎么做 | 约束 |
|---|---|---|
| **检查** | 宿主启动后（延迟、异步、失败静默）用 npm registry 的元数据比对本机已装版本，得出「哪些出厂插件有新版本」 | 只读；不装包；不写 profile |
| **提示** | 写进日志一行；设置页插件区显示「有 N 个可更新，去插件市场升级」 | 不给「一键升级」按钮（避免误导为自动完成） |
| **升级** | 用户在 dshmarket 里点，走它自己的编写好的 API（校验、回滚、失败码都是它的） | 我们**不碰** pnpm，不碰 profile 的 node_modules |

**为什么不让宿主自己装包**：dshmarket 那套「装完核对磁盘版本、漂移就回滚到 recovery point」的逻辑，我们复刻不了也没必要复刻；自己装就等于绕开它的保护。

### 5.3 必须保留的兜底

| 场景 | 行为 |
|---|---|
| 构建时公网不可达 | 依次试 npmmirror → npmjs → 本地 `dsh-plugins-dev` → **失败就报错停构建**（不静默出一份版本不对的包；现有 `manifest.version !== entry.version` 校验保留） |
| 内网装机 | `DS_BOT_FACTORY_REGISTRY` 指内网源，行为不变 |
| 运行时检查失败 | 静默（只写日志），不影响启动 |

## 六、风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 版本漂移 | 公网 `latest` 可能越过宿主 `engines.dsh` 范围 | manifest 写死精确版本；升级前人工核对 `engines` |
| 首启无网 | 内置插件随包分发，**首启不需要网**（这正是保留内置的价值） | 本方案默认内置，不改成 A |
| 用户改过插件 | 用户可能已经在市场里升/降过某个插件 | 打包只决定「包内初始版本」；用户已改的以用户为准（首启不覆盖已存在且用户动过的） |
| 检查打扰 | 每次启动都查会慢/吵 | 异步、延迟、失败静默；一天最多一次（写个小状态文件） |
| 第三方插件被我们改 | 有人会想「干脆让宿主帮用户自动升级」 | **明确不做**：那要改 dshmarket 包，且绕开它自己的校验与回滚 |

## 七、验收标准

1. **打包从公网**：断掉内网（或用假 registry）后，`npm run dist` 仍能从 npmmirror 拉到 11 个插件，版本与 `factory.manifest.json` **逐条一致**，构建结束打印每个插件的来源（registry URL 或 dev 目录）。
2. **内网仍可用**：`DS_BOT_FACTORY_REGISTRY=http://192.168.1.10:3000/...` 时行为与今天一致。
3. **漂移必拒**：故意把 manifest 的某个版本改错，构建必须报 `refusing to pack a drifted version` 并失败。
4. **运行时检查**：能列出「哪些出厂插件有新版本」，数字可核对（至少一条真更新的证据：本地版本 vs 线上版本的实测数字）。
5. **不动用户环境**：检查逻辑不写 profile、不装包；有测试钉住「只读」。
6. 三项门禁与基线对比；打包后给路径/大小/sha256 + asar 完整性校验（`base = headerEnd + ((4 - headerEnd % 4)) % 4`）。

## 八、待用户/队长拍板

1. **「自动升级」的确切含义**：接受「市场里一键升级 + 我们只做检查提示」，还是要求连点都不点（那需要让 dshmarket 支持宿主令牌，属改第三方包，需要单独授权）？
2. **版本策略**：同意「manifest 写死精确版本、升级靠显式改 manifest」，还是坚持「构建时拉 latest」？（我强烈建议前者，理由见 5.1-2）
3. `gen-catalog.mjs`（内网市场目录生成）本次**不动**，是否同意？
4. 运行时检查的提示落在哪里：只写日志，还是同时在设置页显示（后者要动 UI，另算工作量）？

## 九、本方案的边界

- **不动** `D:\LinkBot\app`（正式版替换由队长执行）。
- **不改** dshmarket 包内任何代码。
- **不删** 内网兜底能力（环境变量仍可指回内网）。
- 本 PR 只做 A 段（打包从公网）+ 可选的只读检查；**B 段「帮用户自动装」不做**，理由见第四节。
