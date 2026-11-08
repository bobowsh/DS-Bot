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
