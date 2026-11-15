# 自动更新把上游版本装到我们头上：处置与开关选项

Refs #3 之外的独立问题；关联 issue：装机环境（`D:\LinkBot`）

## 现象

2026-11-09 23:44，已装的 LinkHarness 0.3.1 启动后自动更新，日志：

```
[main] LinkHarness 0.3.1 (win32 x64), Electron 44.7.0
[main] Checking for update
[main] Found version 0.3.2 (url: DS-Bot-0.3.2-win-x64.exe)
[main] Downloading update from DS-Bot-0.3.2-win-x64.exe
```

下载完成后落在：

```
%LOCALAPPDATA%\deepseek-bot-updater\pending\
  temp-DS-Bot-0.3.2-win-x64.exe   126,931,448 字节  11-10 00:14 下完
  temp-DS-Bot-0.3.1-win-x64.exe    40,827,539 字节
  current.blockmap                          317,841 字节
```

`pending/` 里的包**会在应用下次退出时被安装**（`autoInstallOnAppQuit`）。而上游 v0.3.2 是 `DS Bot` 品牌，**没有**我们的 AIDE 入口、`check-asar-sources` 门禁、`@trycua` extraResources、LinkHarness 改名。换上去等于定制全部丢失。

## 根因：更新源写死在上游

三处都指向同一个上游仓库：

### 1. 打包配置（写进安装包里的 `app-update.yml`）

`app/electron-builder.yml`：

```yaml
publish:
  provider: github
  owner: Fei2411
  repo: DS-Bot
```

已装包里的实际内容（实测）：

```
$ cat "D:\LinkBot\app\resources\app-update.yml"
owner: Fei2411
repo: DS-Bot
provider: github
updaterCacheDirName: deepseek-bot-updater
```

electron-updater 运行时读的就是这个文件。

### 2. 手动下载页

`app/src/updates.mjs`：

```js
export const RELEASES_URL = 'https://api.github.com/repos/Fei2411/DS-Bot/releases?per_page=20'
export const RELEASE_PAGE = 'https://github.com/Fei2411/DS-Bot/releases/latest'
```

`watchReleases()` 的默认 `feed` 就是 `RELEASES_URL`——macOS 和 Linux deb 走这条。

### 3. 触发时机

`app/src/updates.mjs`：

```js
const CHECK_EVERY_MS = 4 * 60 * 60_000
```

启动时 `run()` 一次，之后每 4 小时一次。`watchUpdates()` 设了：

```js
updater.autoDownload = true
updater.autoInstallOnAppQuit = true
```

**下载是自动的，安装在退出时自动进行**——用户不点任何东西也会被换掉。

## 已做的处置

删掉 `pending/` 里的三个文件（`installer.exe` 保留）：

```
pending_after=0
```

删之前确认没有 LinkHarness 进程在跑。**这是可逆的**——更新器会重新下载（`DS_BOT_UPDATE_URL` 不指的地方它下次又会去上游拉），所以这只是止血，不是根治。

2026-11-10 复核：`pending\` 仍是 0 个文件，`installer.exe`（386 MB）保留，无 LinkHarness / DS-Bot 进程在跑。

## 怎么关：三个选项

### 选项 A：环境变量指向我们自己的 feed（立即可用，不改代码）

`app/src/main.mjs` 已经支持：

```js
const feed = process.env.DS_BOT_UPDATE_URL || undefined
if (feed) updater.setFeedURL({ provider: 'generic', url: feed })
```

**改法**：给应用进程设 `DS_BOT_UPDATE_URL`，指向一个放 `latest.yml` 的目录（generic provider）。例如我们自己仓库的 release assets：

```
DS_BOT_UPDATE_URL=https://github.com/bobowsh/DS-Bot/releases/latest/download
```

**但**：generic provider 要 `latest.yml` 的格式，且我们的仓库目前**没有发过 release**（`bobowsh/DS-Bot` 是我们的内网仓，`release.yml` 工作流里的 npm trusted publisher 还指向 `Fei2411/DS-Bot`）。所以这条路要先有我们自己的发布产物。

**另外 `watchReleases` 的默认 feed（`RELEASES_URL`）不读这个环境变量的默认值**——`main.mjs` 把同一个 `feed` 变量传给了 `watchReleases`，所以设了环境变量时 macOS/deb 也走它。**这条路是通的。**

### 选项 B：打包时把 publish 指向我们自己的仓库（治本）

改 `app/electron-builder.yml`：

```yaml
publish:
  provider: github
  owner: bobowsh
  repo: DS-Bot
```

重打包后 `app-update.yml` 就指向我们自己的 release。**这是根治**：装出去的包只认我们的源。

**要一起改的**：`app/src/updates.mjs` 的 `RELEASES_URL` 和 `RELEASE_PAGE` 也指向 `bobowsh/DS-Bot`。

**风险**：如果我们的仓库不发 release，用户就永远收不到更新（自动更新静默失败，About 页会显示 failed）。这比被上游换掉好，但要先确定我们会不会发 release。

### 选项 C：关掉自动下载与自动安装（**小队长已定方向**）

依据是用户 2026-11-07 定 #12 时说过的话：**「内核升级 = 手动装新安装包，不走自动更新」**。

**目标**：更新源继续检查上游，但只当「有新版本了」的信使——**绝不自动下载，绝不自动安装**。

#### C 的具体改法

**改一：`app/src/updates.mjs` 的 `watchUpdates()`**

现在（`app/src/updates.mjs:170-172`）：

```js
export function watchUpdates({ updater, beforeInstall, ask, feed, log = console }) {
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
```

改成：

```js
export function watchUpdates({ updater, beforeInstall, ask, feed, log = console }) {
  // The user installs a new build by hand (2026-11-07). The updater may notice a
  // newer release, but it never downloads it and never installs it: autoDownload
  // would fetch the upstream package into pending\, and autoInstallOnAppQuit
  // would replace this build with it at the next quit.
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
```

**为什么这样就够**：electron-updater 的 `autoDownload = false` 时，`checkForUpdates()` **不会**把包拉进 `pending\`——它只查元数据，把 `update-available` 事件发出来。`autoInstallOnAppQuit` 只有在 `update-downloaded` 之后才有意义；不下载就没有 `downloaded` 状态，退出时无从装起。**两个开关一起关，自动安装路径就不存在。**

**改二：`update-available` 的处理**

现在（`app/src/updates.mjs:182`）：

```js
updater.on('update-available', (info) => { holder.set({ phase: 'downloading', version: info?.version }) })
```

**这一行必须改**：`autoDownload = false` 时不会有 `download-progress` 事件，状态会永远卡在 `downloading`，而 `UPDATE_BUSY` 里正有 `'downloading'`——**从此每 4 小时的检查都会被自己挡住，不再检查**。

改成：

```js
updater.on('update-available', (info) => { holder.set({ phase: 'available', version: info?.version }) })
```

**改三：`update-downloaded` 的处理可以留着，但不再是自动路径**

现在（`app/src/updates.mjs:190-197`）在 `update-downloaded` 时问用户要不要立刻重启。**在 C 之下这个事件不会自然发生**（不下载就没有 downloaded），但留着无害，且将来若改成手动下载即可复用。**不动它。**

#### C 之后的行为

| 场景 | 之前 | C 之后 |
|---|---|---|
| 启动 | 自动检查 → 自动下载 → `pending\` 里躺一个上游包 | 自动检查 → 只报「有新版」 |
| 退出应用 | `autoInstallOnAppQuit` 装上 `pending\` 里的包，**定制全丢** | **什么也不装**（没有 downloaded 状态） |
| About 页的相位 | downloading → downloaded | available（显示有新版） |
| 4 小时后的下一次检查 | 正常 | 正常（`available` 不在 `UPDATE_BUSY` 里） |

**上游的更新源先保持不动**（继续查 `Fei2411/DS-Bot`），它现在只是个信使。等我们自己真有了发布链路，再单独议要不要换成 `bobowsh/DS-Bot`——那是另一件事。

#### C 的证据：证明自动安装路径已断

**证据一（静态）**：`app/src/updates.mjs` 里 `autoDownload = true` 与 `autoInstallOnAppQuit = true` 都换成 `false`，且没有任何别处再把它们设回 `true`：

```
$ grep -n "autoDownload\|autoInstallOnAppQuit" app/src/*.mjs
app/src/updates.mjs:171:  updater.autoDownload = false
app/src/updates.mjs:172:  updater.autoInstallOnAppQuit = false
```

（只有这两行，再无别处。）

**证据二（行为）**：`update-available` 之后不再有 `download-progress`、不再有 `update-downloaded`；`pending\` 里不会新增任何文件。

**证据三（相位）**：`update-available` 把相位改成 `available`（不再是 `downloading`），下一次 4 小时的检查仍会跑（`available` 不在 `UPDATE_BUSY` 里）。

**证据四（单元测试）**：在 `app/test/` 里加一条用例，用一个假的 updater 驱动 `watchUpdates()`：

- 假 updater 在 `autoDownload = false` 时不产生 `update-downloaded`；
- 相位从 `checking` 到 `available`，**不会**到 `downloading` 或 `downloaded`；
- **`quitAndInstall` 从头到尾没有被调用过**——这是「自动安装路径已断」最直接的断言。

**证据五（真机）**：装一个按 C 改过的包，跑一次更新检查，`%LOCALAPPDATA%\deepseek-bot-updater\pending\` 保持 0 个文件。

**未验证**：证据五要等 #30 合并后重打的包；证据二、三、四在实现 PR 里补齐。

## 三件事要用户拍板

1. **走哪条路**（A / B / C）——**C 的方向小队长已定**，理由是用户 11-07 定过「本体升级手动装包、不走自动更新」。**B（把 publish 指向我们自己的仓库）另议**：等我们自己真有了发布链路再说，那时 C 里的「信使」也可以一并换成我们自己的源。
2. **我们自己的 release 怎么发**：`.github/workflows/release.yml` 目前的 npm trusted publisher 写的是 `Fei2411/DS-Bot`（上游），我们内网仓要改成自己的 npm 组织和包名吗？这会影响 `npm publish ds-bot` 这一步。
3. **上游的更新要不要断干净**：C 之下上游以后发 0.3.3 我们的用户**看不到**（只报「有新版」，不自动装）。这是有意的隔离。

## 另一件相关的事

`D:\LinkBot` 现在装的 0.3.1 **就是我们那个 asar 坏包**（`app.asar` 里 43 个 src 条目 17 个内容错位），所以它白屏是必然的，跟渲染无关。用户要等 #30 合并后重打的包。

**这次的 0.3.2 如果装上，白屏可能会消失**（上游的包是干净的），但代价是我们的定制全丢——AIDE 入口、门禁、cua 修复、改名，全没有。**所以「让它装上」不是解法。**
