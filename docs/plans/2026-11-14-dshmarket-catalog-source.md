# 插件市场的目录源改回 dshmarket 自己的路由

- 日期：2026-11-14
- 状态：已实现，等验收
- Refs #12（出厂插件与技能的内网分发，属另一条线，本方案不动它）

## 一、要解决什么

用户反馈「dshmarket 现在访问不到外网」，插件市场拉不到目录。

**根因不是断网，是我们把插件市场的目录源替换掉了。**

## 二、根因（第一性原理）

dshmarket 的目录源是这样来的（`dshmarket@1.73.19`，`lib/regions.js`）：

```js
// lib/regions.js:254-258
// `DSHM_REGISTRY_URL` keeps its existing meaning — the catalog URL — and
// when set it REPLACES the source list rather than heading it: someone
// pointing the market at their own catalog does not want it quietly
// reverting to ours.
const catalog = override(env, 'DSHM_REGISTRY_URL')
...
// lib/regions.js:284
catalog: catalog !== null ? [{ kind: 'url', url: catalog }] : base.catalog.map(...)
```

即：**这个变量一旦设置，就整体替换掉它自带的源列表**，而不是排在最前面。

它自带的源列表（`lib/regions.js:101-129`）：

| 区域 | 自带源 |
|---|---|
| global | `https://awesome-dsh-plugin.com/plugins.json`（`CATALOG_OFFICIAL`），失败后由 `catalogSourcesFor()` 追加 npm 包兜底 `dsh-plugin-catalog` |
| china | 先 npm 包（腾讯镜像），再官方域名，另加 npmmirror 兜底 |

我们做的是：`app/src/profile.mjs` 里 `DSHM_REGISTRY_URL = CATALOG_URL`（内网
`http://192.168.1.10:3000/...`），由 `app/src/main.mjs` 注入 Host 进程。于是：

1. dshmarket 的**官方域名源与 npm 兜底全被这一个内网地址顶掉**；
2. 那个内网端口**实测不通**（`UND_ERR_CONNECT_TIMEOUT`，外网 npm registry 正常）；
3. 结果：目录一条都读不到 → 插件市场空白。

**所以「改回它本来的地址」的正确实现不是换一个我们指定的 URL，而是别再顶掉它。**

## 三、实测证据

### 3.1 三种状态下 dshmarket 的实际路由（读它自己的源码跑 `routesFor` / `catalogSourcesFor`）

**变量缺席（改完之后的行为）**：

```
[global] routes.catalog      = [{"kind":"url","url":"https://awesome-dsh-plugin.com/plugins.json"}]
[global] catalogSourcesFor() = [{"kind":"url","url":"https://awesome-dsh-plugin.com/plugins.json"},
                                {"kind":"npm","registry":"https://registry.npmjs.org","pkg":"dsh-plugin-catalog"}]
[china]  routes.catalog      = [{"kind":"npm","registry":"https://mirrors.cloud.tencent.com/npm","pkg":"dsh-plugin-catalog"},
                                {"kind":"url","url":"https://awesome-dsh-plugin.com/plugins.json"}]
[china]  catalogSourcesFor() = [{"kind":"npm","registry":"https://mirrors.cloud.tencent.com/npm",...},
                                {"kind":"npm","registry":"https://registry.npmmirror.com",...},
                                {"kind":"url","url":"https://awesome-dsh-plugin.com/plugins.json"}]
```

**变量在场（改之前，指内网）**：global 与 china 的 `routes.catalog` 都只剩
`[{"kind":"url","url":"http://192.168.1.10:3000/..."}]` —— 官方源与 npm 兜底全没了。

### 3.2 官方目录的结构与我们 `readCatalog` 的兼容性

取 npm 包 `dsh-plugin-catalog` 内的 `plugins.json`（与官方域名发布的是同一份目录）：

```
字节数            : 15,369,345
顶层键            : name, url, source, updated, count, categories, plugins
plugins[] 总数    : 10,974
name+version 都在 : 5,643
带 registry 字段  : 0
条目键            : name, owner, url, page, category, description, npm, version, stars, ...
实例              : {"name":"dsh-j-space","version":"1.2.5","npm":"@anonyjcy/dsh-j-space","category":"agi"}
                    {"name":"dsh-preset-deep","version":"0.1.5","npm":"dsh-preset-deep","category":"agi"}
                    {"name":"dsh-prompt-polish","version":"0.2.6","npm":"@benrong/dsh-prompt-polish","category":"agi"}

我们的 readCatalog 能解析出: 5,643 条 → 兼容
```

### 3.3 可达性（本机实测）

| 地址 | 结果 |
|---|---|
| `https://awesome-dsh-plugin.com/plugins.json` | HTTP 200（队长实测 15,323,893 字节；本机 node fetch 多次超时，curl 可连） |
| `https://registry.npmjs.org/dsh-plugin-catalog` | HTTP 200 ✅（npm 包兜底这条路一定通） |
| `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` | **ECONNRESET，不可达**，且其条目**无 `version` 字段**（5,643 条全无），与我们 `readCatalog` 不兼容 |
| `http://192.168.1.10:3000/...`（现状） | **UND_ERR_CONNECT_TIMEOUT，不可通** |

> 结论：把地址换成 jsdelivr 是错的（不可达 + 格式不兼容）。dshmarket 自己的官方域名 +
> npm 包兜底才是它「本来的地址」，而 npm 包这条路在本机实测 https 200。

## 四、做法（已实现）

**方案2：宿主不再向插件进程注入 `DSHM_REGISTRY_URL`。**

- `app/src/profile.mjs`：删掉 `CATALOG_URL` 与 `DSHM_REGISTRY_URL` 两个导出，注释写明
  为什么这里不再命名插件市场的目录（附 dshmarket 的 `routesFor` 行为与本机实测）。
  `NPM_REGISTRY` 与 `SKILLHUB_REGISTRY` **不动**。
- `app/src/main.mjs`：从 Host 的 env 里去掉 `DSHM_REGISTRY_URL`（以及对应的变量声明与
  解构）。Host 的 env 仍然是 `{ ...process.env, ... }`，所以**用户自己在环境里设的值照旧透传**
  —— dshmarket 把那个变量视为「用户对自己网络的声明」，我们不该改写或丢弃它。

**为什么选方案2 而不是方案1（改成 `awesome-dsh-plugin.com`）**：

1. 方案1 仍然是「我们强制指定单一源」，会继续把 dshmarket 的 npm 兜底顶掉；本机实测官方域名
   多次超时，只剩一条源就等于没有兜底。
2. 方案2 让它用它自己的路由（含兜底），不必跟着它升级而维护地址。
3. 用户说的是「改回 dshmarket 本来的地址」——它的「本来」就是一整套源，不是某一个 URL。

**范围区分（重要）**：`app/src/factory-update.mjs` 里还有一个**独立的** `CATALOG_URL`，供
我们自己的「工厂插件自动更新」（`readCatalog` / `updateFactoryPlugins`）使用，指向内网工厂源。
那是另一条线（内网自研插件分发），**本次不动**。两处本来就是两个独立常量，不需要拆分。

> 需要说明的一点：内网工厂源（`NPM_REGISTRY` 的 3000 端口）当前也不通。它影响的是「工厂插件
> 自动更新」与我们自研插件的 npm 分发，**不影响 dshmarket 的公开目录**。内网服务起来后照旧可用。

## 五、测试

| 文件 | 改动 |
|---|---|
| `app/test/factory-registry.test.mjs` | 删掉「`CATALOG_URL` 是内网地址」「`DSHM_REGISTRY_URL === CATALOG_URL`」两条断言；改为断言这两个导出**不存在**（防止有人再加回来把市场源顶掉） |
| `app/test/host-env.test.mjs` | 原断言是「内网目录地址传到了 Host」，已不成立。改为：① 应用不再导出这两个常量；② **用户自己设的** `DSHM_REGISTRY_URL` 原样透传到 Host（不改写、不丢弃） |

## 六、验收标准

1. 新安装的应用启动后，Host 进程的环境里**没有**应用写入的 `DSHM_REGISTRY_URL`。
2. 用户自己设置该变量时，它原样到达 Host。
3. dshmarket 能读到目录（拿它自己的源：官方域名或 npm 包兜底），插件市场可用。
4. `npm test` 失败集合与基线逐条一致；`--check` exit 0；lint 不新增。
5. 安装包 asar 完整性校验通过（Electron 实际读取，数据区起点 4 字节对齐）。

## 七、还没定的

1. 内网 3000 / 8081 服务恢复后，是否要再给 dshmarket 加一个内网源。**当前不做**：那需要
   dshmarket 支持「追加源」而不是「替换源」，属它自己的接口能力，等用户需要再说。
2. `NPM_REGISTRY` 与 `SKILLHUB_REGISTRY` 仍指内网且当前不通。这是内网工厂源，本次按要求不动。
