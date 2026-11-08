# #12 E 组端到端验收（准备稿，未实跑）

口径（队长派单）：
1. **断网全流程**：catalog 加插件 → 安装 → 替换 → 回滚；用进程级死端口代理断网，**不碰系统网络配置 / hosts**
2. **catalog 新增条目自动装 + 自动写 bundles 启用**（Q2）
3. **失败回滚**：换到一半失败要退回旧版

状态：**只准备，不实跑**。等小柚子 C3/C4 落地、两行接线补齐后再跑。
脚本落 `tests/issue12/`，临时数据落 `tmp/`，不碰 `D:\LinkBot\data` 与用户真实 DSH_HOME。

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
├── README.md                 本文件
├── e2e-offline.mjs           场景 1：断网全流程（catalog 加插件→安装→替换→回滚）
├── e2e-catalog-add.mjs       场景 2：新增条目自动装 + 写 bundles 启用
├── e2e-rollback.mjs          场景 3：换到一半失败回滚
└── helpers/
    ├── fake-fetch.mjs        路由表 mock（含死端口拒绝）
    ├── make-archive.mjs      最小 ustar+gzip 打包器（照 factory-update.test.mjs）
    └── fingerprint.mjs       目录文件 SHA256 指纹，比对「未变/已替换/已回滚」
```

每个场景自带 `node --test` 超时（≤20s/case）、`t.after()` 清理临时目录，不残留进程。

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
- C1 archive 版本与 catalog 不符 → `installUpdate` 返回 `updated:false`、reason 含 `not <version>`，旧目录指纹不变
- C2 archive 解包失败（非法 gzip）→ `updated:false`、reason 含 `unpack failed`，旧目录不变
- C3 swap 阶段失败（注入 rename 抛错 / 目标占用）→ backup 放回，**旧版 version 与文件都在**
- C4 连败 3 次 → state.failures 累计到 3，次日之前 `skipped` 含该插件、`updated` 不含
- C5 每次失败后 `data/factory-update-staging` 与 `factory-update-backup` 被清理，不留半成品

## 门禁（实跑后要贴的真实输出）

- `node --test --test-timeout=20000 tests/issue12/*.mjs`：全绿、无挂起
- 关键回归：`app/test/factory-registry.test.mjs`(7/7)、`data-packaging.test.mjs`(12/12)、
  `DS-Bot-issue12/app/test/factory-update.test.mjs`(14/14)
- 贴每个场景的日志末行（含 outcome JSON 与指纹比对结果），不是「应该通过」

## 未验证（准备阶段如实标注）

- 三个场景脚本尚未写、尚未跑；以上断言是**对着源码推导的判据**，不是实测结论
- helpers 已自检通过（`node tests/issue12/helpers/selfcheck.mjs` → `OK`，仅验证工具本身可用，未跑场景）
- E 组实跑条件：C 组 PR（含 C3/C4 + 两行接线）合进 dev-me 后，在最新基线上跑
- 断网方式只设计了进程级方案，未在本机对被测 app 实跑验证
