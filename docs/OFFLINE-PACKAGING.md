# DS Bot 桌面版离线打包带走清单

目标：在一块移动硬盘上带齐所有东西，到一台**完全没有网络**的 Windows 机器上，把 DS Bot 桌面版打包成 Windows 安装包（NSIS `.exe`）。

本文所有数字均为一次真实断网演练的实测值，不是估算。

---

## 1. 前提

| 项 | 要求 |
|---|---|
| 平台 | Windows x64（打 Win 包必须在 Win 上做，原生模块不交叉编译） |
| 目标仓库 HEAD | commit `c9ed411 Release 0.2.5-rc1`（`app` 与 `ds-bot` 版本一致为 `0.2.5-rc1`） |
| Node.js | 22.19+ 均可；本次演练用的是 Node `v24.21.0` |
| npm | 已知 **npm 11 有坑**（见第 5 节），但本流程绕过它，不依赖 `npm run dist` |
| 离线机网络 | **不需要任何网络**，全程 0 次外连（已实测，日志无一条 Downloading/URL） |

> 说明：electron-builder 的 `beforePack` 会触发 Office payload 的装配（内嵌 Python/Node/文档库）。正常在线时它从 GitHub、nodejs.org、PyPI 下载，**离线机上这些全部命中本地 sha256 归档缓存**，不会发请求。这是本文第 2、5 节反复强调要带齐缓存的原因。

---

## 2. 必须带走的三样（全文核心）

| # | 带什么 | 放哪 / 怎么生效 | 大小（实测） |
|---|---|---|---|
| 1 | **工程目录**（整份仓库拷贝，含依赖） | 拷到离线机任意路径，**全相对路径、盘符无关** | 干净份实测 **1.01 GB**（已排除 `dist-pack`/`tmp`/`dist-offline`/`build\runtime`）。带产物时 `DS-Bot\` 会是 2.31 GB，多出的就是 `dist-offline`(1.07 GB)+`build\runtime`(0.23 GB)，拷走前删这两处回到 1.01 GB |
| 2 | **electron-builder 缓存** | 用环境变量 `ELECTRON_BUILDER_CACHE=<绝对路径>` 重定向 | 实测 **102.2 MB**（1580 文件） |
| 3 | **electron 本体 zip** | 构建命令里 `-c.electronDist=<zip 绝对路径>` 覆盖，**必须显式传** | 151 MB（单文件） |

### 2.1 工程目录里必须包含的子项

这些是第 1 样（工程目录）内部的关键，缺一个离线就联网：

| 子路径 | 为什么必须 | 实测大小 |
|---|---|---|
| `app\node_modules\` | 依赖已装好，离线机不跑 `npm ci` | 约 908 MB |
| `app\build\runtime-cache\` | **Office payload 的原始归档，按 sha256 命名**，beforePack 命中即不发请求 | 15 个归档，实测 **90.75 MB** |
| `ds-bot\node_modules\` | 插件构建工具（esbuild 等） | 约 12 MB |
| `app\node_modules\app-builder-lib\templates\nsis\messages.yml` + `assistedMessages.yml` | 见第 5 节坑 4，需手工补进 | 22,478 + 22,554 字节 |

`app\build\runtime-cache\` 里 win-x64 打包要用的 15 项归档（2 个解释器归档 + 13 个 wheel），文件名就是 `app\scripts\primary-runtime.lock.json` 里记录的 sha256。命中规则：`prepare-runtime.mjs:47-60` 按 sha256 寻址，文件存在且哈希相符就直接返回，**不发请求**。

### 2.2 明确不用带

| 不带的 | 原因 |
|---|---|
| `app\dist-pack\` | 只是构建产物（约 1.07 GB），不带 |
| `tmp\` 及任何临时目录 | 演练残留；且 `tmp\verify-home` 里写死了源机绝对路径，带过去无用 |
| npm 全局 cache（`%LOCALAPPDATA%\npm-cache`，约 0.77 GB） | `node_modules` 已在工程里，离线机不需要再 `npm ci` |

> **拷工程时的坑**：见第 5 节坑 5——`robocopy /XD tmp` 会误伤 `app\node_modules\tmp`（那是一个正常的 npm 包，不是临时目录），要单独补拷。

---

## 3. 完整构建命令（可复制粘贴）

把 `<KIT>` 换成离线机上工程根目录的实际路径，把 `<ZIP>` 换成 electron 本体 zip 的绝对路径。

```powershell
cd <KIT>\app

# electron-builder 缓存重定向（绝对路径）
$env:ELECTRON_BUILDER_CACHE = '<绝对路径>\vendor\electron-builder-cache'

# 用 node 直接调 cli，绕过 npm 11 不生成 .bin 的坑（见第 5 节坑 2）
node node_modules\electron-builder\cli.js --publish never `
  "-c.directories.output=dist-offline" `
  "-c.electronDist=<ZIP>"
```

本次演练里 `<ZIP>` 的实际值（离线机上换成你带过去的那份的绝对路径，zip 文件名不变）：

```
<...>\vendor\electron-cache\953a0a4266b4fe4d83c379b33897281a9229323d55abb2772fdb535e9f65039e\electron-v44.7.0-win32-x64.zip
```

**产物**：`<KIT>\app\dist-offline\DeepSeek-Bot-0.2.5-rc1-win-x64.exe`

### 为什么不用 `npm run dist`

`npm run dist` 展开是 `electron-builder --publish never`，依赖 `node_modules\.bin\electron-builder`。npm 11 在本机不生成 `.bin` 目录（坑 2），执行会报 `electron-builder is not recognized`。改用 `node node_modules\electron-builder\cli.js` 等价且不受影响。并且 `npm run dist` 不带你需要的 `-c.electronDist`，会在 electron 本体那步联网死（坑 1）。

---

## 4. 断网验证怎么做（演练方法，可复用）

要确认"真的不需要网"，在**打包进程**里设死端口代理，任何外连立即 `ECONNREFUSED`，不会挂住：

```powershell
foreach ($n in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy') {
  Set-Item "Env:$n" 'http://127.0.0.1:1'
}
Remove-Item Env:NO_PROXY, Env:no_proxy -ErrorAction SilentlyContinue
$env:npm_config_offline = 'true'
```

> **红线：验证断网只用进程级环境变量。禁止改 `C:\Windows\System32\drivers\etc\hosts`、禁止 flush/改 DNS、禁止加防火墙规则、禁止动系统代理。**
> 原因：① 改 hosts/DNS 影响的是整台机器的解析，本机所有程序（包括你正在用的 DSH、浏览器、IM）会一起断网，属于"为验证一个流程把全局搞瘫"；② 死端口代理只作用于这一个进程及其子进程，验证完即随进程结束消失，**不污染任何全局状态**，失败可精确归因到"哪一步试图联网"。
> （本次演练第一轮就因改 hosts 影响了用户上网，被叫停并逐字节还原，之后一律改用死端口代理。）

判定：命令 `exit=0`，且完整日志里搜 `Downloading`/`http` 命中数为 0（配置正文里出现的 `github.com/Fei2411` 是 maintainer 字段，非请求）。

---

## 5. 已知坑（现象 + 解法）

**坑 1｜不传 `-c.electronDist` 就联网**
- 现象：离线报 `connect ECONNREFUSED`，抓到的 URL 是 `https://npmmirror.com/mirrors/electron/v<ver>/SHASUMS256.txt`。
- 根因：`@electron/get` 的 `index.js:50` 注释「Never use the cache for loading checksums」——校验和**永远联网拉**，缓存只对 zip 生效。
- 解法：**必须显式传 `-c.electronDist=<zip绝对路径>`**。传了之后 `app-builder-lib` 的 `ElectronFramework.js:176` 命中 `using custom electronDist zip file`，直接解压你的 zip，既不发 zip 请求也不发 SHASUMS 请求，完全不碰 `%LOCALAPPDATA%`。

**坑 2｜npm 11 不生成 `node_modules\.bin`**
- 现象：`npm run dist` / `npm run pack` 报 `'electron-builder' is not recognized as an internal or external command`。
- 解法：用 `node node_modules\electron-builder\cli.js` 直调，见第 3 节。（或手工补出 `.bin`，不推荐，多一步易错。）

**坑 3｜`start.ps1` 在本机中断**
- 现象：全局 `.npmrc` 里有 `electron_mirror` → npm 11 往 stderr 打 `Unknown user config` 告警 → `start.ps1` 的 `$ErrorActionPreference='Stop'` 把 stderr 当致命错误，脚本第一条 npm 就崩。
- 解法：**离线打包根本不需要 `start.ps1`**（它是"开发运行拉起 Electron"用的，见 `app\README.md`）。打包走第 3 节的 `node ...cli.js`。

**坑 4｜npmmirror 的 app-builder-lib 26.17.0 缺 NSIS 模板**
- 现象：打包跑到最后一步报 `ENOENT ... app-builder-lib\templates\nsis\messages.yml`（和 `assistedMessages.yml`）。
- 根因：镜像同步的这个包少了这两个 yml（官方 npm 上的 tgz 里有）。
- 解法：从官方 tarball `app-builder-lib-26.17.0.tgz` 里抽出这两个文件，放进 `app\node_modules\app-builder-lib\templates\nsis\`。**这两个文件已随工程目录一起带过去（见 2.1），离线机无需再补。**

**坑 5｜`robocopy /XD tmp` 误伤一个真实依赖包**
- 现象：拷完工程后，某些环节报 `app\node_modules\tmp` 缺失。
- 根因：`/XD tmp` 会跳过**任何**名为 `tmp` 的目录，包括 npm 包 `app\node_modules\tmp`，不只临时目录。
- 解法：拷完单独把 `app\node_modules\tmp` 补回来：
  ```powershell
  robocopy <SRC>\app\node_modules\tmp <DST>\app\node_modules\tmp /E
  ```

**坑 6｜预置 runtime 归档（Office payload）的方法**
- 若离线机上 `app\build\runtime-cache\` 不全，beforePack 会去 GitHub/nodejs.org/PyPI 下载对应归档。
- 解法：把每个归档**按 lock 里的 sha256 命名**放进 `app\build\runtime-cache\`（默认路径），或设 `DS_BOT_RUNTIME_CACHE=<绝对路径>` 指向缓存目录。归档清单见 `app\scripts\primary-runtime.lock.json` 的 `targets.win-x64`。
- 关键 sha256（文件名即哈希）：node `158f7685…e541`（37,618,919 字节）、CPython `7c45c962…1b14`（21,980,728 字节）；其余 13 个 wheel 见同 lock。

---

## 6. 验收清单（4 项，含本次实测值）

| # | 判据 | 本次实测值 |
|---|---|---|
| 1 | 构建 `exit=0`，且日志无任何 `Downloading`/联网 URL | `exit=0`；联网行命中数 = **0** |
| 2 | 安装包存在：`dist-offline\DeepSeek-Bot-<ver>-win-x64.exe` | `DeepSeek-Bot-0.2.5-rc1-win-x64.exe` = **229.5 MB** |
| 3 | `dist-offline\win-unpacked\DeepSeek Bot.exe` 能起来（起得来就关） | 起来且稳定（5 进程存活 45 秒），已关；文件 246,338,048 字节 = **234.9 MiB** |
| 4 | payload Python 六库 import 全过 | `python 3.12.14`：`docx 1.2.0 / pptx 1.0.2 / openpyxl 3.1.5 / pandas 3.0.1 / lxml 6.1.3 / PIL 12.3.0` 全 OK；`node v24.21.0` |

第 4 项命令：
```powershell
& '<KIT>\app\dist-offline\win-unpacked\resources\primary-runtime\dependencies\python\python.exe' `
  -I -B -c "import docx,pptx,openpyxl,pandas,lxml,PIL; print('ALL OK')"
```

> 关于第 3 项体积：同一个 exe，按二进制 MiB（÷1024²）是 **234.9 MiB**，按十进制 MB（÷1000²）是 246.3 MB。两者是同一个数，只是单位口径。本表以 MiB 口径 234.9 为准。

---

## 7. 复用的演练目录

`E:\offline-kit\` 是本次演练用的一份完整可复用拷贝，当前合计 **2.55 GB**（含 `vendor\` 两个缓存）。分解：

| 目录 | 当前实测 |
|---|---|
| `E:\offline-kit\`（含 vendor 全部） | **2.55 GB** |
| └ `DS-Bot\`（工程，带产物） | 2.31 GB |
| &nbsp;&nbsp;&nbsp;└ `app\dist-offline\`（产物） | 1.07 GB |
| &nbsp;&nbsp;&nbsp;└ `app\build\runtime\`（装配产物） | 0.23 GB |
| └ `vendor\`（两个缓存） | 约 0.25 GB |

结构：

```
E:\offline-kit\
├─ DS-Bot\                     工程目录整份拷贝（不含 dist-pack / tmp）
│   └─ app\
│       ├─ node_modules\       含补回的 tmp 包、补齐的 nsis 模板
│       └─ build\
│           ├─ runtime-cache\    15 个 sha256 归档（90.75 MB，必需）
│           └─ runtime\          已装配的 payload（0.23 GB，可选加速项，见下）
└─ vendor\
    ├─ electron-builder-cache\ electron-builder 缓存（配合 ELECTRON_BUILDER_CACHE）
    └─ electron-cache\         electron-v44.7.0-win32-x64.zip（配合 -c.electronDist）
```

### 拷去离线机前删什么

产物 `dist-offline\` 一定要删（1.07 GB 无用）。`build\runtime\` 删不删取决于你选哪条路：

- **只带归档（推荐，最省）**：删 `dist-offline\` 和 `runtime\`，工程份回到 **1.01 GB**。打包时 beforePack 从 `runtime-cache\` 的 15 个归档离线重装 payload（实测可行，见验收第 4 项）。
- **带装好的 payload（更快）**：只删 `dist-offline\`，保留 `runtime\`，工程份 1.24 GB。beforePack 的 `runtimeReusable()`（`prepare-runtime.mjs:143-150`）会读 `runtime\primary-runtime\runtime.json` 里的 `payloadDigest`，与按当前 lock 算出的比对；一致且 python/node/pythonPackages 三个路径都在就命中，命中后只打一行 `payload ... is current`、下载装配全跳过，零网络。

> 保留 `runtime\` 的三个前提：① `payloadDigest` 只跟 lock 走，**lock 一变（升 Python/Node/库版本）digest 就失效**，会回头从归档重建——所以归档仍是必需项，`runtime\` 只是加速项，不能只带 `runtime\` 不带 `runtime-cache\`；② 装配产物 233.81 MB / 5686 文件 vs 归档 90.75 MB / 15 文件，只想带一份就带归档；③ 拷贝时**别用 `/XD build` 这类规则**，会把 `runtime` 和 `runtime-cache` 一起排除掉。

```powershell
# 最省：删产物 + 删装配产物（保留 runtime-cache）
Remove-Item E:\offline-kit\DS-Bot\app\dist-offline -Recurse -Force
Remove-Item E:\offline-kit\DS-Bot\app\build\runtime -Recurse -Force
```

真上离线机时，把 `E:\offline-kit\` 整个拷到移动硬盘带过去，按第 3 节命令把 `<KIT>`/`<ZIP>` 指到对应路径即可，不用再从零准备缓存。

---

*本文档基于 commit `c9ed411`（DS Bot 0.2.5-rc1）的一次真实断网演练写成；演练在 Windows 11 (10.0.22631) x64、Node v24.21.0 上通过。*
