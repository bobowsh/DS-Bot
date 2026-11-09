# #12 A1 接线：小柚子需补的两行

A1（内网 registry 接线）的**实现与测试都在 `app/src/profile.mjs` / `app/test/factory-registry.test.mjs`**（小年糕，主工作区）。但有两个挂载点落在小柚子的文件里，必须补上，否则配置写了不会生效。

## 1. `app/src/host.mjs`（patchFiles 追加 overlay）

在 `writeAppPatch(profile)` 之后加 `...writeFactoryRegistryPatch(profile)`：

```js
patchFiles: check === undefined ? [...writeAppPatch(profile), ...writeFactoryRegistryPatch(profile), ...reconcileSearchSelector(profile), ...]
```

import 加：
```js
import { writeFactoryRegistryPatch } from './profile.mjs'
```
（或和 `writeAppPatch` 同一条 import 合并）

`writeFactoryRegistryPatch(profile)` 写 `factory-registry.patch.yml`，内容是：
```yaml
- id: astron-skillhub
  name: '@astron-team/skillhub-dsh'
  config:
    registryUrl: http://192.168.1.10:8081
```
这是 `--patch` overlay，只覆盖 skillhub-dsh 这一行，不改用户 `cordis.patch.yml`。依据：`plugins/dsh/src/host/config.ts` 的 `Config.registryUrl`、`plugins/dsh/src/host/index.ts:145` 读 `this.configuration.get().registryUrl`。

## 2. `app/src/main.mjs`（Host env 加 catalog 地址）

`newHost()` 的 env 里加 `DSHM_REGISTRY_URL: DSHM_REGISTRY_URL`，常量从 `profile.mjs` 导入：

```js
import { ..., DSHM_REGISTRY_URL } from './profile.mjs'   // 若已动态加载，则加到那批解构里
...
env: { ...process.env, ..., DSHM_REGISTRY_URL, ... }
```

依据：`dshmarket/src/regions.ts:313` `override(env, 'DSHM_REGISTRY_URL')` 是**进程环境变量**，不是 cordis config；它把 catalog 源整体替换为 `http://192.168.1.10:3000/dshplugin/dsh-catalog/raw/branch/main/plugins.json`（匿名 200 已验证）。

## 3. 无需改动的

- `.npmrc`：由 `loadAppProfile()` 自动写（profile 目录由 `initProfile` 建好），用户自写的不覆盖
- `registryUrl` overlay 与 `DSHM_REGISTRY_URL` 的常量、写函数、7 项单测都在 `profile.mjs` / `factory-registry.test.mjs`

## 验证

`node --test --test-timeout=20000 test/factory-registry.test.mjs` → 7/7
`node --test test/app-patch.test.mjs test/import-plugin.test.mjs test/host.test.mjs` → 22/22

## B2 实测结论：dsh-skill-market 暂不能进出厂清单

`pn1024/dsh-skill-market@1.0.1`（MIT，main 分支）的 host 侧 `src/index.js`：

- 支持 `config.skillhubApiBase` / `config.clawhubApiBase`（L534-535、L948-952），可指向内网；
- 但它调用的 4 个端点是 `${apiBase}/api/skills`、`/api/v1/skills/batch`、`/api/v1/skills/{slug}/file`、`/api/v1/download?slug=`；
- 内网 iflytek SkillHub 实测的是 `/api/v1/skills`（带 namespace `global`）、`/api/web/skills`、`/api/cli/v1/skills/search`、`/api/v1/skills/{ns}/{slug}/...` —— **形状对不上**（无 `/api/skills`、无 `/api/v1/download`，且 skill 需 namespace）。

即：直接把 `dsh-skill-market` 加进 `BUNDLED_PLUGINS` 会装上一个在离线/内网机上连不上的插件。**B2 需与 D2（4 端点兼容实测 / fork 改字段映射）一起做**，或改用已在出厂清单里的 iflytek 官方 `skillhub-dsh`（已配 `registryUrl` 指向 8081，端点契约已实测兼容）。这不是漏做，是依赖顺序问题，需队长拍板选哪条路。

## B1 已完成

`app/scripts/gen-catalog.mjs`：扫 Gitea `dshplugin` org 的各仓 + npm registry 的已发布版本，自动生成 13 条 `plugins.json`（`url`/`upstream` 指原作者 GitHub，人审 diff 后 `--write`）。dry-run 实测：13 条、与现有 catalog 名字零增删。
