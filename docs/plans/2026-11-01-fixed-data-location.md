# 固定数据位置与导入提示

- 日期：2026-11-01
- 状态：已实施——方案改为 **app 首启写 `locations.json`**（方案 B），不用安装器，见「变更」
- 相关：（待提 PR）

## 为什么

要把应用装在一个固定的地方（例如 `d:\LinkBot\app`），数据固定在**安装目录上一级的
`data`**（`d:\LinkBot\data`），工作区固定在同级的 `workspace`（`d:\LinkBot\workspace`）；
并且**首启时如果发现用户自己的 DSH 里已有 Bot 团队，仍然要提示"要不要复制过来"**。

现有机制满足不了后一条，原因在 `app/src/first-run.mjs` 的 `chooseLocations()`：

- 设 `DS_BOT_HOME` → 第一行就 `return`，欢迎框、目录选择、`offerImport` 全部跳过（它是开发/测试用的 throwaway 语义）。
- `locations.json` 存在 → 直接读它返回，同样不走 `offerImport`。
- 而 `offerImport`（"发现已有团队，要复制吗"）**只在首跑分支里被调用**，也就是只在 `locations.json` 不存在的那一次。

取舍：

- **由 app 在首启时写 `locations.json` 来固定目录，而不是安装器宏，也不是新增环境变量或内置默认值。** 这样不硬编码任何路径（`data` 跟着安装目录走），不加新的配置项，首跑的欢迎框、目录选择和 `placeProblem()` 校验自然全部跳过。JSON 用 `JSON.stringify` 在 JS 里拼，转义零成本、可单测，和现有 `saveLocations()` 同一条代码路径。
- **代价是文件比安装器方案晚一个启动周期落盘。** app 起不来时位置还没固定——那种情况下数据位置也没有意义。
- **导入提示必须与首跑解耦。** 把"发现已有团队就问一次"的判断从"首跑分支"里提出来，只要条件成立就问，并给"用户拒绝过"加一个记忆标记，避免每次启动都问。
- 不改 `DS_BOT_HOME` 的语义：开发模式（`start.ps1` 设的 `.ds-bot-local/data`）优先级仍然最高，行为不变。

## 已定的行为

### 首启预置（`app/src/first-run.mjs`，`fixedPlaces()`）

- 打包的 Windows 应用（`app.isPackaged` 且 `win32`）首启时取安装目录（`installFolder(app.getPath('exe'))`，即 `programFolder()`）的上一级，把 `dataDir` 定为 `<上级>\data`、`workspace` 定为 `<上级>\workspace`，创建这两个目录并用 `saveLocations()` 写入 `locations.json`——不弹欢迎框、不弹目录选择。
- **只在 `locations.json` 不存在时生效**：用户后来在设置里移动过数据不能被改回去。升级安装本来就不跑这段（文件已存在）。
- 上一级就是自身或是盘符根时不固定，照常走首跑询问（装到 `d:\LinkBot` 这种没有 `\app` 一层的位置，不会得到 `d:\data`）。
- 不硬编码 `d:\LinkBot`：装到 `d:\LinkBot\app` 时结果就是 `d:\LinkBot\data`，换地方安装结果跟着换。
- 非打包运行（开发）和其他平台不固定：macOS 的程序文件夹是 .app bundle，数据不能进签名封印里面；开发跑在仓库目录里，固定了会把数据写进 checkout。

### 首启与后续启动

- `locations.json` 已存在 → 不弹欢迎框、不弹目录选择，数据和工作区就是文件里那两个路径（"固定"生效）。
- 但只要同时满足这三条，就照旧弹"发现已有团队，要复制吗"：
  1. 数据目录里还没有团队（`hasTeam(dataDir)` 为假）；
  2. 用户自己的 DSH（`DSH_HOME`，没设就是 `~/.dsh`）里有团队（`findTeam()` 返回非 `undefined`，即 `bot/state.json` 存在且 `bots` 数 > 0）；
  3. 这个数据目录里没有"拒绝过"的标记。
- **拒绝记忆**：用户点了"不复制"或在团队被占用的警告里选"跳过"（且确实发现了团队，不是"根本没发现"）→ 写 `<dataDir>/bot/import-declined`，此后不再问。选"退出"不写标记，下次启动还问，与现有首跑行为一致；"会话格式过新"处选"不带团队开始"也不写标记——那条提示要用户更新后回来复制，更新了必须还能再问。
- 复制的前置检查与首跑一致：团队锁（60 秒内有效则拒绝）、更新格式的会话（只能"退出"或"不带团队开始"）、多份模型设置时问用哪一份。
- 复制本身仍是 `importTeam()`：只读旧家，暂存后落位，写 `<dataDir>/bot/imported.json`。

### 卸载

- 数据在 `$INSTDIR` 之外，卸载只删程序文件夹，不删数据和工作区。

## 不做什么

- 不硬编码 `d:\LinkBot` 或任何绝对路径。
- 不改安装器：`app/build/installer.nsh` 保持原样，不加 `customInstall` 宏。
- 不用 NSIS 禁止用户选择安装目录（`allowToChangeInstallationDirectory` 保持不变）。
- 不改 `DS_BOT_HOME` 的 throwaway 语义，也不新增环境变量。
- 不禁止在设置 → 通用 → 位置里移动数据；移动后 `locations.json` 已是新位置，首启预置只在文件不存在时生效，不会覆盖。
- 不改 `placeProblem()` 的校验规则。

## 已知限制

- 数据位置相对安装目录：装到别处，`data` 也跟着去那个位置的上一级。用户自己装的时候要注意选对目录。
- 固定位置的首启不走 `placeProblem()` 询问校验（组合非法时只能在运行期暴露）；这是"不弹任何框"的既定代价。
- "拒绝过"的标记存在数据目录里：移动数据时它跟着 `bot/` 一起搬过去，不会重问；手工换一个全新的数据位置则会再问一次——这是想要的行为，不是 bug。

## 变更

- 2026-11-01：初稿，记录方案；代码与安装器尚未改动。
- 2026-11-01：方案从"安装器写 `locations.json`"改为"app 首启写"（方案 B）。原因：NSIS 里拼带 `\\` 和 `\"` 的 JSON 转义难验证（`StrRep` 宏在 3.0.4.1 模板下不自动可用，`\"` 不是合法转义），为一次性的预置背一套转义不值；JS 里 `JSON.stringify` 转义零成本、可单测、与 `saveLocations()` 同路径。代码落在 `app/src/first-run.mjs`：`fixedPlaces()` + `chooseLocations()` 首启分支；解耦导入提示为 `locations.json` 存在时也走 `offerImport`，拒绝记忆 `import-declined`。`installer.nsh` 不动。
