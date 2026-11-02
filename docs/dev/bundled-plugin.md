# 随包分发的预置插件

一个插件要随桌面应用一起装进用户的机器，装完就能用，而且**用户能在插件管理界面里把它关掉**。
本文是这条路的做法与它背后的机制，照着做就能加下一个预置插件。

本文按**清单式**写：装进 profile 的不是一个插件，而是安装包携带的一组插件，每个都独立、都能被用户单独关掉。

范例：`dsh-chat-import`（需求九，提交 `6e30a95`、`7a0d6ac`、`ea01ed5` 的清理）；清单式改造见提交 `4e8ebc1`。

## 一句话结论

放 **app 的 `dependencies`** → 界面当它是「app 自带的」，**没有开关**。
放 **profile 的 `node_modules`** → 界面当它是「用户装的插件」，**有开关**，而且照样随包分发、不联网。

差别只在一处判定（`shipped`），但它决定了这个插件用户能不能关。


## 为什么不能放进 dependencies

插件在 app 的 `dependencies` 里时，DSH 把它当成**应用自己的一部分**：

```js
// dsh-plugin-manager/lib/index.js
const shipped = Object.hasOwn(installation.dependencies ?? {}, name);
```

`shipped` 为真时，这个包在插件管理界面里的 `availability` 是 `installation`，界面不给它启用/禁用开关——
用户看到的是「app 自带的」，不是一个能关掉的插件。实测（`dsh-chat-import` 放进 `dependencies` 时）：

```json
{ "name": "dsh-chat-import", "availability": "installation", "readOnlyReason": null }
```

界面上的开关由 `EnableSwitch` 决定，它只在 `readOnlyReason` 为空时可用；`installation` 的包被这一层排除在
「可管理的插件」之外。

> DSH 自带的实验性插件（`@deepseek-ai/dsh-experimental-*`）能关掉，是因为它们在 DSH 自己仓库里
> 硬编码的 `OPTIONAL_BUNDLES` 名单里（`dsh-app-boot/lib/index.js`）。那是 DSH 的名单，我们加不进去，
> 所以「照抄实验性插件」这条路走不通。

## 正确的做法

三步：**放在 devDependencies（npm 装它，开发时可跑）→ extraResources 随包分发（离线可用）→
首启复制进 profile 的 node_modules（手装插件的待遇）**。

清单式的做法把这三步都改成「按清单循环」，清单写在 `app/scripts/before-pack.mjs`：

```js
export const BUNDLED_PLUGINS = [
  'dsh-chat-import',
  'dsh-rule-manager',
  'dsh-session-manager',
  'dsh-tool-activator',
  '@copylee/dsh-computer-use',
  '@jayyuen66/dsh-ocr-review',
  '@j62268781-alt/dsh-skills-mcp-manager',
  '@linxin666/dsh-client-ui-git-graph',
  'deepseek-harness-intelligent-ui',
]
```

加一个预置插件 = 在这个清单里加一行；包内容从插件开发目录的 `pack/` 取（见下一节）。


### 1. app/package.json：放进 devDependencies

```json
{
  "devDependencies": {
    "dsh-chat-import": "0.26.3"
  }
}
```

- npm 照常装它，开发和测试都能用；
- electron-builder 不把它当 app 的依赖（`shipped` 为假）；
- `package-lock.json` 用 `npm install --package-lock-only` 增量更新，**不要**用带
  `--legacy-peer-deps` 的整树安装（它会重新求解，把打包要的依赖从 lock 里剔掉）。

### 2. app/electron-builder.yml：随包分发（一组压缩包）

打包时把每个插件压成一个 `.tgz`（`npm pack` 的标准形态），整组放进 `extraResources`：

```yaml
extraResources:
  - from: build/bundled-plugins
    to: bundled-plugins
```

这些归档由 `beforePack` 钩子生成（`app/scripts/bundled-plugin.mjs`，用 `tar` 包打成 gzipped tar），
装完它们在 `<安装目录>\resources\bundled-plugins\<压平的包名>-<版本>.tgz`。

**文件名要把 scope 压平**：`@copylee/dsh-computer-use` 打成 `copylee-dsh-computer-use-0.8.1.tgz`。
`bundled-plugins` 是**平铺的一层目录**，名字里带 `/` 会变成子目录，安装器只读这一层，永远找不到它。
包里真正的包名仍带 scope，首启解包时从归档的 `package.json` 读回来（`archivePackageName`）。

> **为什么用压缩包而不是一堆散文件**：安装包里少几百个文件，占的地方也小得多。
> 归档是 npm 自己发布的格式，将来想改成 `npm install <tgz>` 也不用换文件。

### 2.1 包内容从哪来：插件开发目录

包内容**不从 profile 的 `node_modules` 现取**，而是从插件开发目录：
`E:\dsbot-work\dsh-plugins-dev\<插件名>\`，每个插件一个子目录：

```
<插件名>\
├─ src\             ← git 源码（作者仓库的默认分支最新代码，供以后改插件）
├─ pack\            ← 打包用的包内容（实际进 tgz 的就是这一份）
└─ SOURCE-NOTE.md   ← 来源、版本、有没有真源码
```

`prepareBundledPlugins` 按这个顺序找包：`<dev>/<名字不带 scope>/pack` → `<dev>/<全名>/pack` →
`app/node_modules/<全名>`（最后一个兜住 `dsh-chat-import` 这种只在 app 里装的）。
开发目录由 `DS_BOT_PLUGINS_DEV` 指定，默认是仓库上一级的 `dsh-plugins-dev`。

**`pack/` 用哪个版本**：要出厂的那一版。可以在 `src/` 里构建出来再拷进 `pack/`（本例的
`dsh-tool-activator 0.4.3` 就是这样：`pnpm install && pnpm run build` 后按 `package.json` 的
`files` 列表拷进 `pack/`），也可以直接用 npm 已装的那一版。

**`src` 里有真源码的才算「源码仓」**：有的插件 `repository` 指向空仓库（作者没发布源码，如
`@linxin666/dsh-client-ui-git-graph`、`deepseek-harness-intelligent-ui`），这两个只有 `pack/`，
`SOURCE-NOTE.md` 里写清原因。

### 3. 首启解包进 profile

解包发生在 **Electron 主进程**（`app/src/main.mjs`），在 Host 启动之前，**按清单逐个装**：

```js
for (const entry of bundledPlugins(resourcesDir())) {
  // 文件名是压平的，真正的包名从归档自己的 manifest 读回来。
  const name = await archivePackageName(entry.path) ?? entry.name
  await installImportPlugin({ profileDir, archive: entry.path, name, version: entry.version })
    .catch(error => { console.error(`LinkBot: the plugin ${name} was not put in place:`, error) })
}
```

一个插件装失败只影响它自己（`catch` 拦住），不会让启动失败，也不会挡住清单里后面的插件。

**解包只靠 Node 内建的 `zlib`**（`app/src/import-plugin.mjs` 的 `readTgz` / `unpackTgz`）——
tgz 就是 gzip 压的 tar，tar 的格式很简单（每 512 字节一个头），几十行就能读，
**不用给安装包加一个 tar 依赖**。

> **依赖必须一起打包**：插件从 profile 里跑，Node 从 profile 的 `node_modules` 找它的依赖。
> 只解包插件本身的话，依赖还留在 app 的 `node_modules` 里，插件加载就失败——
> 表现为 `import-claude (dsh-chat-import): failed to import: Cannot find package 'fzstd'`，
> 整行没激活，`import_chat` 工具和首启自动导入**一起消失**，而日志里看不出原因。
> 所以 `prepareBundledPlugins` 会把插件的依赖（和依赖的依赖）一起收进归档，
> 解包时放在 profile 的 `node_modules` 根——**紧挨着插件**，Node 才找得到。
>
> 同一类失败的另一个例子：`@jayyuen66/dsh-ocr-review` 缺 `@jayyuen66/dsh-plugin-shared`
> （它自己的依赖，不是宿主包），加载报 `Cannot find package '@jayyuen66/dsh-plugin-shared'`。
> 把这个依赖放进它的 `pack/node_modules/` 之后就能加载了。
>
> **要分清「缺宿主包」和「缺自己的依赖」**：`@deepseek-ai/*` 由宿主 DSH 提供，profile 里本来就没有
> （实测装机后的 `profiles/ds-bot/node_modules` 只有插件本身和它的依赖），不需要也没法打进去；
> 其余名字的包都是插件自己的依赖，必须随归档带。

profile 是 DSH 管的目录，插件放在它的 `node_modules` 里，就是**用户手装插件的待遇**：

| | 放在 app 的 dependencies | 放在 profile 里 |
|---|---|---|
| `availability` | `installation` | `profile` |
| 插件界面的开关 | ❌ 没有 | ✅ **有** |
| 能不能被用户关掉 | ❌ | ✅ |
| 随包分发 | ✅ | ✅（解包进 profile） |
| 要联网才能装 | ❌ | ❌（本地解包） |

解包完还要把插件写进 profile 的 `dependencies` 和 bundle 列表（`app/src/import-plugin.mjs`），
DSH 才知道去哪里找它。

## 禁用语义：DSH 自己记着

用户在插件界面关掉插件时，DSH 做的**只有一件事**——从 profile 的 `bundles` 列表里移除它的名字：

```js
// dsh-plugin-manager/lib/index.js, selectBundle
const bundles = enabled ? [...previous, ...] : previous.filter((item) => item !== name);
```

**`dependencies` 不动**。所以 app 读一下 profile 就能知道用户的选择：

| profile 状态 | 含义 |
|---|---|
| dependencies 有 + bundles 有 | 已装、启用 |
| **dependencies 有 + bundles 没有** | **用户禁用了** |
| dependencies 没有 | 还没装过 |

app 照这个信号走：**用户禁用过的，不写回 bundle 列表**。这样禁用是持久的，重启、升级都在。

不需要额外的状态文件——这正是之前那套实现里唯一麻烦的地方，删掉之后净减 75 行代码。

> DSH 的 `reconcile` 会把「在 dependencies 但不在 bundles」的包加回列表，但它**只在安装操作之后**
> 跑（`activateNewBundles`），正常启动不跑，所以这个信号是稳的。

### 三种用户动作

| 用户在插件界面做的 | 效果 |
|---|---|
| **启用** | 正常使用；出厂默认就是启用 |
| **禁用** | **持久有效**：插件还在，但不运行，重启也不回来。想再开就在界面里打开 |
| **移除** | **恢复出厂**：插件被卸载了，但它是出厂自带的核心功能，app 下次启动会把它装回来 |

「移除 = 恢复出厂」是有意的：app 保证这个功能在场上（首启自动导入靠它），而用户想长期关掉它时用「禁用」。
所以「移除」后重启又装回来，不是 bug，是这套语义的一部分。

## 版本同步

profile 里存着上一版插件，app 升级会带来新版。每次启动时比一下版本：

- 安装包里的**更新** → 重新解包到 profile；
- 版本相同 → 不动（避免每次启动都重写文件）；
- profile 里的**更新**（用户自己放了新版）→ 不动；
- **用户禁用过的 → 不动**（尊重选择）。

版本比较用 `newerVersion()`（`app/src/import-plugin.mjs`）：先比三段数字，再比预发布后缀
（`0.26.3-rc2` 比 `0.26.3` 老）。这是 app 自己的更新检查（`ds-bot/src/host/update.js`）用的同一条规则，
没有引入新依赖。

## 两个进程的分工

| 进程 | 做什么 | 为什么 |
|---|---|---|
| Electron 主进程（`main.mjs`） | 解包插件进 profile、比对版本 | 它读得了安装目录里的资源文件 |
| Host 进程（`host.mjs`） | 只管 app 自己的 bundles | 插件归 profile 管，`claimBundles` 不碰它 |

`app/src/profile.mjs` 的 `claimBundles()` 只写 app 自己的三个 bundle，**不碰可选插件**——
它一旦把插件加回去，用户的禁用就失效了。

## 实操清单

加一个新的预置插件：

1. 把包内容放进 `dsh-plugins-dev\<插件名>\pack\`（需要有 `package.json`、`cordis.patch.yml`、入口文件）；
   有 git 源码的放 `src\`，并写一份 `SOURCE-NOTE.md` 记来源与版本；
2. `app/scripts/before-pack.mjs` 的 `BUNDLED_PLUGINS` 里加一行包名；
3. `app/electron-builder.yml` 的 `extraResources` 已有 `from: build/bundled-plugins`，**不用改**；
4. `app/src/main.mjs` 和 `app/src/import-plugin.mjs` **也不用改**（它们按清单循环，包名从归档读）；
5. 如果这个插件有自己的 npm 依赖（不是 `@deepseek-ai/*`），把它放进 `pack/node_modules/`，
   否则装到用户机器上会 `Cannot find package`；
6. 测试：`app/test/import-plugin.test.mjs` 里「the other bundled plugins」那组覆盖了多插件、scoped 包名、
   互不干扰、禁用保持；新插件按需补断言；
7. 打包后实测：归档在 `resources/bundled-plugins/` 里、首启后 profile 的 `node_modules` 里有它、
   profile 的 `dependencies` 和 `dsh.profile.bundles` 里都有它。

### 加插件前的加载测试（必做）

**装进 profile ≠ 能加载**。插件装好后要能在宿主环境里 `import()` 成功，缺自己的依赖就会失败，
而那时用户看到的是「插件在列表里但功能没出现」。

测试方法要注意一点：**不能在一个空目录里直接 `import()` 插件入口**。实测那样连
`dsh-chat-import`（装机验证过能用的）都会报 `Cannot find package '@deepseek-ai/dsh-llm'`——
因为 `@deepseek-ai/*` 由宿主提供，profile 里没有。要按宿主的方式解析：为 `@deepseek-ai/*`
加一层 fallback 到宿主的 `node_modules`（开发时是 `ds-bot/dev/harness/node_modules`，
装机后是安装目录里的 DSH），其余从 profile 解析。

判定三类结果：

| 结果 | 含义 |
|---|---|
| OK | 在宿主环境里能加载 |
| PATCH-ONLY | 只有 `cordis.patch.yml`、没有运行时入口（纯补丁型，正常） |
| FAIL | 缺包/入口缺失，**不能出厂**，除非把缺的依赖补进归档 |


## 怎么验证它真的生效

「测试全绿」不等于「装到机器上真的能用」——这条路有三段（打包 → 首启解包 → DSH 认它），
单元测试只覆盖第二段的逻辑。装好的包要用真实进程验一遍，四条断言缺一不可：

| 断言 | 读哪里 | 说明 |
|---|---|---|
| 压缩包随包分发了 | `<安装目录>/resources/bundled-plugins/<包名>.tgz` | 不存在说明 `extraResources` 没配上 |
| 插件的文件进了 profile | `<data>/profiles/<profile>/node_modules/<包名>/` 有内容 | 只有 `package.json` 没有 `lib/` 说明解包漏了 |
| **profile 依赖它** | profile `package.json` 的 `dependencies[<包名>]` | 没有这一条，`shipped` 判定和启用状态都会错 |
| **启用列表里有它** | profile `package.json` 的 `dsh.profile.bundles` | 不在列表里 = 出厂就是关闭的，用户开机看不到功能 |
| 子依赖也在旁边 | profile `node_modules/` 下能找到 `fzstd` 这类 | 少了插件加载直接失败，整行不激活 |

跑法：用 `DS_BOT_HOME` + `DS_BOT_SHELL_DATA` 指到临时目录启动打包后的 exe，等 Host 打印
`dsh web: http://127.0.0.1:<port>/`（说明启动走到位了），再从 Node 读上面几个路径。
`app/scripts/check-packed.mjs` 是同一思路的完整版（它还驱动界面发一条消息）。

> **`DS_BOT_HOME` 会跳过首次启动的分支**。只在验「首启解包」时才用它；验「真首启自动导入」
> 必须用装机后的固定目录（不设 `DS_BOT_HOME`、且 `locations.json` 不存在），这两件事的触发条件不同。

本次实现（`dsh-chat-import` 0.26.3）实测结果，可作为对照：

```
压缩包：1,368,240 字节，解出来 "version": "0.26.3"
profile 依赖：true (0.26.3)
启用列表包含：true
插件目录：10 项，含 cordis.patch.yml
旁边的包：dsh-chat-import, fzstd
```

## 已知代价

- **profile 里有一份运行副本**：安装目录里是压缩包（一个文件），data 目录里是解开的副本（用户数据区）。
- **用户禁用后，压缩包还在**：用户关掉的是插件的运行，不是安装包里的文件。

## 压缩包对速度的影响（实测）

常被问「压成包会不会变慢」。用本次的 `dsh-chat-import-0.26.3.tgz`（1,368,240 字节，解开后
215 个文件 / 3,188,181 字节）实测，结论是**安装更快、启动无感**：

| 环节 | 散文件形态 | 压缩包形态 |
|---|---|---|
| 安装器复制插件 | 100–114 ms（215 个文件） | **2.2–4.1 ms（1 个文件）** |
| 首启 / 升级后解压 | 无此步 | 164–179 ms（一次性） |
| 日常启动（只比版本号） | — | **0.039 ms**（300 次中位数） |
| 占用的字节 | 3,188,181 | **1,368,240（省 57%）** |

安装阶段快约 40 倍，因为少了几百次小文件 IO。日常启动只读两个版本字符串，不做任何解压
——解压只在**首启**和**安装包带来新版插件**时发生。文件名里带版本号时（现在就是这样），
连解压读 manifest 都省了；只有文件名不带版本才需要读一眼归档（实测 8.6 ms）。


## 备选方案：交给 npm / pnpm 装 tgz

也可以把 tgz 交给包管理器：`pnpm add <tgz> --prefix <profile>`，让它自己解压、处理依赖、写
manifest，比手写 manifest 更标准。**本项目没有采用**，理由：

- **装机环境里没有 npm**：Electron 自带自己的 Node 运行时，不带 npm CLI（实测 `npm --version`
  在这个环境里是 `ENOENT`）。app 只随包带 pnpm（`app/node_modules/pnpm`，Host 进程启动时用它），
  所以这条路实际只能用 pnpm 走，不是 npm。
- **离线是硬要求**：`pnpm add` 即使拿到本地 tgz，也可能为了解析 peer 依赖去问 registry。首启时
  网络没通，用户看到的就是卡住或者报错。要真离线得加 `--offline` 并确认 store 里已有全部依赖，
  这又多一层要在真机上验的东西。
- **失败点挪到了启动路径上**：现在解包失败只是 `installImportPlugin` 返回 `installed: false`，
  启动照走；换成包管理器就多了一个可能卡住启动的子进程。
- 现在的做法是**解包 + 自己写 profile 的 manifest**，`dependencies` 与 `bundles` 两行都在
  `app/src/import-plugin.mjs` 里，一眼能看完。

### 子依赖不是问题：tgz 里已经带了

这条容易误解，写清楚：`prepareBundledPlugins` 打包时会把插件的依赖一起收进 tgz 的
`package/node_modules/`（本次是 `fzstd`，215 个文件里的 8 个）。`unpackTgz` 专门处理这一层——
把它摊到 profile 的 `node_modules` 根、紧挨着插件，Node 才找得到。所以「目录直拷要手动处理依赖」
这件事**已经做了**，不是待办。

实测：解包后 profile 的 `node_modules` 下并排出现 `dsh-chat-import` 和 `fzstd` 两个包。


