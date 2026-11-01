# 需求五「出厂预制团队 + 技能仓库 + 删导入」验收报告

- 验收人：小镊子（软件测试）
- 日期：2026-11-01（实测 17:40–17:58 +08:00）
- 被测：主工作区 dev HEAD `4353b17`（含 `ac7dee1` ds-bot 种子机制、`2f85ad6` app 侧种子复制/技能仓库/删导入、`e0072bb` 文档）
- 环境：Windows，node v24.14.1。开工与收工各核现场：分支 dev、HEAD 4353b17、status 仅未跟踪 docs/tmp、stash 未动，未 commit / 未 push / 未改分支
- 独立用例：`F:\DS-Bot\tmp\miemie-req5.test.mjs`（C1–C4）

## 结论（2026-11-01 18:05 复核 dev `d65ee40` 后更新）

- **缺陷 1（isomorphic-git 没进 lockfile）已修复、复核通过**（`37bbe5b`，R1–R3）。
- **缺陷 2（git.clone/fetch/pull 缺 `http` 参数）已修复、复核通过**（`d65ee40`，R1 确证进到网络层）；唯一残留：**真实远端 clone 的端到端成功受本机 node TLS 信任库环境所限未能演示**（系统 git 能 clone、裸 node https 报同种证书错 → 判定为环境非代码）。换到 node 可验 github 证书的机器可补验，或打包后在小年糕（升级维护）实机验。
- **需求五 8 条验收标准全部通过，予以放行。** 两处 lockfile/http 代码缺陷均已修；技能在线 clone/pull 的代码路径正确，真实成功仅差一个可联网的验证环境。

## 已验证通过

| # | 标准 | 证据 |
|---|---|---|
| 1 | 首次安装建种子团队、mainBotIds 正确 | 仓库 `factory-seed.test.js`「first launch creates the factory team」在全量里 ✔（建 2 bot、`mainBotIds=[chief]`、`factorySeedVersion='3'`）。app 侧资源落位由我 **C1** 独立验（见第 6a 条）。`rt.applySeed()` 挂载点实测在 `roster.js:705` bootstrap 内、default-Chief 之前 |
| 2 | 升级按 factoryId 覆盖出厂值、版本更新 | 我独立 **C2**：真实 `createRuntime`+非空团队+落后 version，调 `rt.applySeed()` 后 `bots.b1.name` 由 OldName→出厂值 Chief、`factorySeedVersion` '1'→'9'、state.json 落盘一致。仓库「an upgrade refreshes…」✔ |
| 3 | 用户自建 bot（无 factoryId）不动 | 仓库「a user Bot without a factoryId is never touched」✔（`mine.name/instructions` 原样、factoryId 仍 undefined） |
| 4 | 幂等（版本没变不重复写） | 仓库「same version on non-empty team is a no-op」✔（不新增 bot、version 不变）。C2 反向佐证：只有 version 落后才触发 refresh |
| 5 | 种子相对 locator 解析为 join(dshHome,locator)；挂载读该文件 | 我独立 **C2**：种子里 `locator:'skills-repo/rev'` 经 applySeed 后 state 里= `join(dshHome,'skills-repo','rev')` 绝对路径。挂载端「按 locator 读 SKILL.md + directory resourceBase」由需求四独立用例（B1/B4）+ 本全量 factory-seed locator 用例覆盖，未重复测 |
| 6a | 技能仓库内置副本首启复制、已有不覆盖 | 我独立 **C1（真实 app/resources）**：`installFactoryResources` 把 `factory-team.json` 与 `skills-repo/` 落进临时 dataDir（`seedCopied:true, repo:'copied'`，内容与内置一致）；已存在的种子再跑不覆盖（version 保持 'zzz'）。仓库「leaves a skills repo already there alone」✔ |
| 6b | pull 失败静默不阻塞 | 仓库「swallows a failing fetch…」「does nothing for a copied bundle…」✔；main.mjs 里 `installFactoryResources`/`pullSkillsRepo` 都是 void+catch 旁路（源码实测：不 await 到主启动路径），失败只 console.warn |
| 7 | 删导入团队，且需求三要用的函数还在 | 我独立 **C4**（源码级）：`offerImport/importTeam/copyTeam/checkTeam/CHECK_PROFILE/CHECK_BUNDLES/import-declined/markDeclined` 在 first-run/import/main/profile 四文件里**全部不存在**；`findTeam/copySessions/newerSessions/teamInUse/sessionIdsOf`（import.mjs）与 `unreadableSessions`（session-check.mjs）**都在且仍 export**。首启询问逻辑已从 first-run.mjs 移除（现 chooseLocations 只剩定位置） |
| 8 | 无回归 | `ds-bot/`：**1310 tests / 1309 pass / 0 fail / 1 skip**、`lint` **39 warnings / 0 errors**、`build-client --check` **exit 0**（日志 tmp\miemie-req5-dsbot.log）。`app/`：**216 / 215 pass / 1 fail**，唯一失败是既有 `move-data.test.mjs:160` EPERM（判定见需求一报告，与本改动无关）。tmp\miemie-req5-app.log |

## 未验证

- **实机安装首启**：装包 → 打开 → 看到种子团队，需安装包+显示器，归小年糕（升级维护）打包后实机验。
- **在线 clone / 后台 pull 的真实网络行为**：因下面第 1 号缺陷，包都没装上，现测不了；修好后需补测。
- 首次安装走真实 ds-bot `createBot` 建会话+问候的全链路：由仓库 `factory-seed.test.js` 覆盖（fakeContext），我未另起真实会话链路（依赖 sessionController 重型替身，价值低于覆盖面）。

## 新发现问题

### 缺陷 1（阻塞技能 git 更新，须修）：isomorphic-git 没进 package-lock.json

- **现象**：`app/package.json:64` 声明 `"isomorphic-git": "1.44.8"`，但 `app/package-lock.json`（**lockfileVersion 3、git 跟踪**）里没有它（`has isomorphic-git: false`），`app/node_modules/isomorphic-git` 也不存在。
- **根因**：`git show 2f85ad6 --name-only` 20 个文件**不含 package-lock.json**——加依赖时只改了 package.json，没把 lock 一起更新提交。
- **后果**：打包机 `npm ci` 严格按 lockfile 装 → **产物里根本没有 isomorphic-git**。`factory.mjs` 的 `loadGit()` 永远 `import` 失败返回 undefined → ①首启「在线 clone 最新技能」这条分支**永远走不到**；②日常「后台 git pull 更新技能」永远直接 return。**需求五承诺的「技能跟 git 仓库走、不靠安装包发版」实际失效**，技能只能停在安装包内置副本。代码有降级（不崩、warn 后用副本），所以不阻塞启动，但功能不达。
- **实测坐实**：独立 **C3**——给远程 URL 后 `installFactoryResources` 返回 `repo='copied' reason='no isomorphic-git'`，`createRequire` 解析 `isomorphic-git` 抛 Cannot find package；stderr 打出 `skills updates are unavailable without the isomorphic-git package`。
- **修法**：在 `app/` 执行 `npm install`（让 isomorphic-git 及其依赖进 lock），把 `app/package-lock.json` 的变更**一并提交**到 dev。归小柚（DSH开发）处理。修完需复核：lock 里有该包、`npm ci` 后 node_modules 有、在线 clone/pull 恢复可达。

#### 缺陷 1 复核（dev `37bbe5b`，小镊子 2026-11-01 17:52）——已修复 ✅

队长提交 `37bbe5b`「Install isomorphic-git into the app lockfile」（wangshuai，1 文件 +461/−20，只动 `app/package-lock.json`）。独立复核 `tmp\miemie-req5-recheck.test.mjs`（R1–R3，**3/3 pass**）：

- **R1**：`createRequire` 解析到 `app\node_modules\isomorphic-git\index.cjs`，装的版本 = `1.44.8`，`import` 后 `git.clone` 是 function——`loadGit()` 不再返回 undefined。
- **R3**：lock 里 `node_modules/isomorphic-git` 存在（version 1.44.8、带 11 个锁依赖），且 package.json 全部声明依赖都在 lock（`npm ci` 会装上）。`git show HEAD:app/package-lock.json` 实测 `has isomorphic-git: true`（修前 false）。
- **R2**：给死端口远程 URL，`installFactoryResources` 返回的 `reason` 不再是 `no isomorphic-git`（`undefined`）——**clone 分支确实进得去了**。
- 现场：dev HEAD=37bbe5b、工作区干净、未 push（`git branch -r --contains 37bbe5b` 空）、stash 未动。

### 缺陷 2（复核新发现，同一功能仍不可用，换了原因，须修）：git.clone/fetch/pull 缺必需的 `http` 参数

- **现象**：R2 里 clone 分支进去后，stderr 不是网络错误，而是 `The function requires a "http" parameter but none was provided.`
- **根因**：isomorphic-git 从 v1.8 起把网络层拆成独立子包，`clone/fetch/pull` **必须显式传 `http`**（如 `import http from 'isomorphic-git/http/node'`）。`app/src/factory.mjs` 三处调用（第 57 行 `git.clone`、88 行 `git.fetch`、89 行 `git.pull`）都只传了 `fs: nodeFs`，**没传 `http`**。
- **后果**：`loadGit()` 修复后能拿到模块、能进 clone 分支，但一进 `git.clone` 就同步抛缺参数错误 → 被 `installFactoryResources` 的 try/catch 吞掉 → 静默回退内置副本。日常启动的 `pullSkillsRepo` 里 `git.fetch` 同理抛错被吞。**「技能跟 git 在线 clone / 后台 pull」仍然不生效**——和需求五承诺的核心目标还是没达到，只是失败点从"包没装上"挪到了"没传 http"。
- **对照实验坐实**：独立 `tmp\miemie-req5-recheck2.test.mjs`（R4a/R4b，**2/2 pass**，只调库本身不碰仓库代码）：
  - R4a：不传 http 复现现状用法 → 抛 `requires a "http" parameter`（联网前就抛）。
  - R4b：传 `http = await import('isomorphic-git/http/node')` → 错误变成 `connect ECONNREFUSED 127.0.0.1:1`（进到网络层，说明修法成立）。`app\node_modules\isomorphic-git\http\node` 实测存在。
- **修法**：`factory.mjs` 里 `import http from 'isomorphic-git/http/node'`（或在 `loadGit` 一并返回），三处 `git.clone/fetch/pull` 调用加 `http` 参数。归小柚（DSH开发）修。修完我复跑 R2/R4 确认 clone 真能走到网络层。

### 缺陷 2 复核（dev `d65ee40`，小镊子 2026-11-01 18:05）——已修复 ✅（真实端到端 clone 受本机环境所限未演示）

队长提交 `d65ee40`「Pass the http client to the skills repo git calls」（wangshuai，`app/src/factory.mjs` +6/−4）：`loadGit()` 改为同时加载 `isomorphic-git` 与 `isomorphic-git/http/node`（`httpModule.default ?? httpModule`），三处调用（现第 59/90/91 行）补 `http: git.http`。`git show d65ee40` 复核 diff 与此一致、只动 factory.mjs。

独立复核 `tmp\miemie-req5-recheck3.test.mjs`：

- **R1 通过**：死端口 URL 下 `installFactoryResources` 的 warn 是 `the skills repo was not cloned from https://127.0.0.1:1/never.git: connect ECONNREFUSED 127.0.0.1:1`——**不再是 `requires a "http" parameter`**，进到 TCP 网络层，失败后仍回退内置副本。这确证 http 参数修复生效。
- **R2/R3 真实远端 clone 成功——未能在本机演示（环境所限，非代码缺陷）**：用生产代码路径 clone `github.com/octocat/Hello-World` 报 `unable to verify the first certificate`。对照定性：
  - 系统 `git clone` 同一仓库 **exit=0 成功**（Git for Windows 用自带 CA bundle）；
  - 裸 `node https.get('https://api.github.com')` 也报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`——与 isomorphic-git 的证书错同源。
  - → 该证书错是**本机 node 的 TLS 信任库环境特征**（isomorphic-git 的 http/node 走 node https），不是 `factory.mjs` 的代码问题。`http` 修复本身正确（错误链：缺参数 → ECONNREFUSED → 真实主机进到 TLS 校验，三点都证明调用真走到网络层）。本机 node 信任库修复不属于被测代码、也不该我动，故真实成功 clone 记为「未在本机验证」。R2/R3 脚本已 skip 并注明原因，换到 node 能验 github 证书的机器可复跑。
- 回归：app 测试由队长跑到 216/215/1（唯一失败既有 move-data EPERM），与本改动文件一致。

### 观察 1（非缺陷）：种子内容仍是占位

`factory-team.json` 的 bot（小队长/小助手）instructions 写着「占位示例：预置清单由用户后续给出」、model 未给、技能是占位 review-skill。符合设计「机制先做、清单用户后给」，等用户给清单再填。

### 自我记录（与被测代码无关）

我第一版 C2 用最小 runtime 想让 locator 技能挂载生效，缺初始化导致 attach 不生效（诊断 mounts 空），是脚本 setup 问题；改成用非空团队走 applySeed 的 refresh 分支后独立验通（C2 ✔）。挂载读文件那半不重复测，引需求四结论。

## 复核方式（可复跑）

```
cd F:\DS-Bot\ds-bot
npm test                                            # 1310/1309/0/1 skip
npm run lint                                        # 39 warnings / 0 errors
node scripts/build-client.mjs --check               # exit 0
node --import ./test/harness-resolve.mjs --test ..\tmp\miemie-req5.test.mjs   # C1–C4 4/4 pass
cd F:\DS-Bot\app && npm test                        # 216/215/1（既有 move-data:160）
# 缺陷1复核：
node -e "const l=require('./app/package-lock.json');console.log(!!l.packages['node_modules/isomorphic-git'])"  # 修前 false
```
