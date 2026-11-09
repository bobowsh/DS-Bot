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

### 选项 C：关掉自动更新（最保守）

`app/src/updates.mjs` 的 `watchUpdates()` 里去掉 `autoDownload`，或者 `main.mjs` 的 `startUpdates()` 里加一个开关（比如读 `prefs` 或环境变量），让用户手动点「检查更新」。

**代价**：用户拿不到自动更新，每次要手动。

## 三件事要用户拍板

1. **走哪条路**（A / B / C）——我推荐 **B 为主、A 为过渡**：先把 `publish` 和 `RELEASES_URL` 指向我们自己，B 落地前用环境变量兜底。
2. **我们自己的 release 怎么发**：`.github/workflows/release.yml` 目前的 npm trusted publisher 写的是 `Fei2411/DS-Bot`（上游），我们内网仓要改成自己的 npm 组织和包名吗？这会影响 `npm publish ds-bot` 这一步。
3. **上游的更新要不要断干净**：如果选 B/C，上游以后发 0.3.3 我们的用户就收不到了——这是有意的隔离，还是我们也要跟上游？

## 另一件相关的事

`D:\LinkBot` 现在装的 0.3.1 **就是我们那个 asar 坏包**（`app.asar` 里 43 个 src 条目 17 个内容错位），所以它白屏是必然的，跟渲染无关。用户要等 #30 合并后重打的包。

**这次的 0.3.2 如果装上，白屏可能会消失**（上游的包是干净的），但代价是我们的定制全丢——AIDE 入口、门禁、cua 修复、改名，全没有。**所以「让它装上」不是解法。**
