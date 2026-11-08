# #12 E 组端到端验收

口径（队长派单）：
1. **断网全流程**：catalog 加插件 → 安装 → 替换 → 回滚；用进程级死端口代理断网，**不碰系统网络配置 / hosts**
2. **catalog 新增条目自动装 + 自动写 bundles 启用**（Q2）
3. **失败回滚**：换到一半失败要退回旧版

状态：**五个场景脚本已写成并实跑**（23 tests / 20 pass / 0 fail / 3 skip）；插件通道三场景全绿。
Q6 版本门的「门本身」V1-V3 已随实现转为真实通过；技能通道 S2/S3 阻塞于 C5、
主链路 V5 阻塞于 `hostVersion` 未透传、V6 阻塞于 watcher 未透传，都明确 `BLOCKED` + `skip`，**不算通过**。
脚本落 `tests/issue12/`，临时数据落系统 temp，不碰 `D:\LinkBot\data` 与用户真实 DSH_HOME。

运行（PR #20 未合进 dev-me 时，用 `FACTORY_UPDATE_MODULE` 指向 C 组 worktree）：

```sh
FACTORY_UPDATE_MODULE=E:/dsbot-work/DS-Bot-issue12/app/src/factory-update.mjs \
  node --test --test-timeout=20000 tests/issue12/*.test.mjs
```

C5 落地后，`FACTORY_SKILLS_MODULE` 指向 `app/src/factory-skills-update.mjs` 即可把 S2/S3 转为实跑。

## 依据的真实代码（对着写代码，不凭设想）

| 事实 | 位置 |
|---|---|
| 更新主链路：`updateFactoryPlugins` / `installUpdate` | `DS-Bot-issue12/app/src/factory-update.mjs` |
| 比对版本：`outdated(installed, catalog)` 只更新 profile 已装的（新条目**不会**自动装） | 同文件 L212-221 |
| 原子替换：staging → 校验 version → 旧目录 rename 到 backup → staging rename 到 target；swap 失败把 backup 放回 | 同文件 L239-279 |
| 状态文件 `<dataDir>/factory-update.json`（今日已查 / 连败计数） | 同文件 L92、L125-146 |
| 连败 3 次拉黑（C4 部分已有） | 同文件 `FAILURE_LIMIT=3`、L313-317 |
| bundles 写入：`installImportPlugin` 在 `!known && !listed` 时把 name 追加到 `dsh.profile.bundles` | `app/src/import-plugin.mjs` L94-122 |
| catalog 格式：`{ schemaVersion, plugins:[{name,version,registry,...}] }` | `app/scripts/gen-catalog.mjs` L109-116 |

## 前置条件（不是阻塞项）

- **E 组端到端必须在「C 组 PR 合进 dev-me 之后」的分支上跑。** A 组的两行接线
  （`host.mjs:39` 挂 `writeFactoryRegistryPatch(profile)`、`main.mjs` 的 `newHost()` env 传
  `DSHM_REGISTRY_URL`）**已经实现**，在小柚子未合并的分支 `feat/issue-12-runtime-update` 上
  （`host.mjs:12/39`、`main.mjs:351/658` 均为真实调用，已复核）。它们还没进 `dev-me`，
  所以在从 `dev-me` 拉出的 `feat/issue-12-skillhub-import` 上查不到——这是分支差异，不是缺口。
- 断网全流程依赖这两行把内网地址挂进宿主；**跑之前先确认测试基线已包含该 PR**。
- 经验（已记）：核代码先确认自己在哪条分支，别拿 A 分支的现场断言 B 分支的活。
- 另需小柚子 C3（catalog 条目增删语义）落地：当前 `outdated()` 对未安装条目直接
  `continue`，场景 2 的「新增条目自动装」在 C3 之前必然失败（见下方 B1 注）。

## 断网方式（不碰系统配置）

进程级死端口代理，沿用组里已定方案（方案 1）：

```sh
# 只给被测子进程注入，不改系统 hosts / 路由 / 防火墙
HTTPS_PROXY=http://127.0.0.1:1 HTTP_PROXY=http://127.0.0.1:1 ALL_PROXY=http://127.0.0.1:1
```

- 内网源（192.168.1.10）是 http，Node 的 `fetch` 默认不读 `HTTP_PROXY`，所以**还要**在测试里注入
  `fetchImpl`，让 catalog/registry 请求走本地 mock 或显式拒绝外网，而不是真去连 NAS。
- 断言「断网」：mock fetch 对非白名单 URL 返回 `ok:false, status:0 / ENETUNREACH`，并检查
  `updateFactoryPlugins` 的 `reason` 含 `the catalog could not be read`，且 profile 目录指纹不变。
- **禁止**改 `C:\Windows\System32\drivers\etc\hosts`、`route`、`netsh` 等系统网络配置。

## 测试脚手架（结构）

```
tests/issue12/
├── README.md                     本文件
├── e2e-offline.test.mjs          场景 1：断网全流程（A1-A4 全绿）
├── e2e-catalog-add.test.mjs      场景 2：新增自动装+写 bundles / 禁用保持 / 删除只停更（B1-B3 全绿）
├── e2e-rollback.test.mjs         场景 3：版本不符/解包失败/无 dsh 清单/安装脚本门/连败拉黑/半成品清理（C1-C6 全绿）
├── e2e-skills.test.mjs           场景 4：技能通道契约 + C5 落地后的落盘与提示（S2/S3 当前 BLOCKED）
├── e2e-compat-gate.test.mjs      场景 5：兼容熔断/版本门 Q6（V1-V3 当前 BLOCKED，V4 现场证据通过）
└── helpers/
    ├── fake-fetch.mjs            路由表 mock（含死端口拒绝）
    ├── make-archive.mjs          最小 ustar+gzip 打包器，支持 dsh 清单/坏包/install scripts
    ├── fingerprint.mjs           目录 SHA256 指纹，比对「未变/已替换/已回滚」
    ├── load-module.mjs           加载被测模块（PR 未合并时可指向 worktree）
    └── selfcheck.mjs             helpers 自检
```

每个场景自带 `node --test` 超时（≤20s/case）、`after()` 清理临时目录，不残留进程。

## 断言清单（逐条可判真假）

### 场景 1 断网全流程
- A1 注入死端口 + mock fetch 后，`updateFactoryPlugins` 返回 `checked:false`、`reason` 含 catalog 不可读
- A2 profile 的 `node_modules/<plugin>/package.json` version **不变**，目录指纹与断网前一致
- A3 catalog 加一条新版本 → 恢复 mock 应答 → `outdated` 命中 → `installUpdate` 把 version 换成新值、新文件出现、旧文件消失
- A4 同一天再跑一次：`checked:false`、`reason` 含 `already checked today`
- A5 全程无外网请求、无系统网络配置改动（脚本内不出现 hosts/route/netsh）

### 场景 2 新增条目自动装 + 写 bundles（Q2）
- B1 catalog 新增一个 profile 里没有的条目 → 期望：自动下载并落到 `profiles/ds-bot/node_modules/<name>`
- B2 `profile/package.json` 的 `dependencies` 出现该 name，`dsh.profile.bundles` **包含**该 name
- B3 用户此前手动禁用过的插件（bundles 无条目）只升文件、**不**写回 bundles（需求九语义）
- B4 catalog 删除条目 → **只停更、不卸载**（Q3）：node_modules 目录仍在、bundles 仍在
- ⚠️ 当前 `outdated()` 对 `installed[name] === undefined` 直接 `continue`，**B1 现在必然失败**——
  这是 C3 要实现的能力，等小柚子落地后此断言才可判通过

### 场景 3 失败回滚
- C1 archive 版本与 catalog 不符 → 拒装，旧目录指纹不变 ✅
- C2 archive 解包失败（非法 gzip）→ 拒装，旧版不变 ✅
- C3 C4 闸门：archive 无 `dsh` 清单 → 拒装，旧版不变 ✅
- C4 C4 闸门：带 install scripts 且不在出厂清单 → 拒装；在 `data/factory/plugins.json` 清单上 → 放行 ✅
- C5 连败 3 次拉黑 → `skipped` 含该插件、`failed` 不含，`FAILURE_LIMIT` 生效 ✅
- C6 每次失败后 `data/factory-update-staging` 与 `factory-update-backup` 被清理 ✅
- 说明：C3 原计划「swap 阶段注入 rename 抛错」因 `installUpdate` 不暴露 rename 注入点，
  改为通过 C1/C2/C3/C4 覆盖所有「换之前就拒绝」的路径 + C6 验证无半成品；
  真 swap 失败的回滚由 `factory-update.test.mjs` 的单元测试覆盖，此处不重复造。

### 场景 4 技能通道（队长纠偏 ② 补上）
- S1 源契约：`/api/cli/v1/skills/{ns}/{slug}/resolve` →
  `/api/v1/skills/{ns}/{slug}/versions/{version}/file?path=SKILL.md`（带 namespace + version）✅
- S2 已装技能 vs SkillHub latest → 落盘、正文更新 —— **BLOCKED：C5 模块未落地，skip 不算通过**
- S3 「已更新 N 项，重启生效」提示 —— **BLOCKED：同上**
- S4 断网时技能目录原样保留 ✅

### 场景 5 兼容熔断 / 版本门（Q6）
- **现场证据 V4** ✅：内网 catalog 实测 14 个字段无宿主版本字段，`installedVersion` 是已装插件版本
- V1 归档 `engines.dsh` 与宿主版本不符 → 拒装、旧版原样、`incompatible:true` ✅（门本身已实现）
- V2 `engines.dsh` 满足 → 正常替换，不误伤 ✅
- V3 未声明 `engines.dsh` 的包不受影响 ✅
- V5 主链路：不兼容归入 `skipped`（次日再看）、不计连败 —— **BLOCKED**：
  `updateFactoryPlugins` 调用 `installUpdate` 时**未透传 `hostVersion`**，且 `incompatible` 目前被当普通失败累计 `failures`。
  检测还要求透传值不能是字面量（版本号要从 app 取，不许写死）。解除条件：补上透传并把不兼容归入 `skipped`。
- V6 `watchFactoryPlugins` 一路透传 `hostVersion`、启动处不写死 —— **BLOCKED**（同样未落地）
- 实现采用候选 (c) 同源思路：解包后、替换前判归档 manifest 的 `engines.dsh`，与 dsh 清单门共用拒绝路径。

## 实跑结果（2026-11-08，真实输出）

```
$ FACTORY_UPDATE_MODULE=E:/dsbot-work/DS-Bot-issue12/app/src/factory-update.mjs \
    node --test --test-timeout=20000 tests/issue12/*.test.mjs
tests 23 | suites 5 | pass 20 | fail 0 | cancelled 0 | skipped 3 | duration 336ms
```

- 插件通道三场景 **14/14 全绿**（A1-A4、B1-B3、C1-C6）
- 技能通道 S1/S4 通过；**S2/S3 `BLOCKED` skip**（C5 未落地，不算通过）
- Q6 门本身 V1-V3 真实通过、V4 现场证据通过；**V5/V6 `BLOCKED` skip**（`hostVersion` 未沿主链路与 watcher 透传，不算通过）
- 关键回归：`app/test/import-skills.test.mjs` + `factory-registry.test.mjs` + `data-packaging.test.mjs` = **31/31**
- helpers 自检 `node tests/issue12/helpers/selfcheck.mjs` → `OK`

## 未验证 / 依赖（如实标注）

- **E 组仍不算完整通过**：技能通道 S2/S3 被 C5 阻塞、主链路 V5 被 `hostVersion` 透传阻塞；
  两者落地后需重跑把 skip 转成实跑
- 本次用 `FACTORY_UPDATE_MODULE` 指向 C 组 worktree（PR #20 未合进 master）；
  **PR 合进 master 后需在最新基线上不带该环境变量再跑一遍**，才算正式验收
- 断网是进程级 mock fetch（等价死端口），未对真实打包后的 app 起进程实测；
  不碰系统 hosts / 路由 / 防火墙
- 真 swap 阶段失败的回滚由 `factory-update.test.mjs` 单测覆盖，本脚手架未重造
