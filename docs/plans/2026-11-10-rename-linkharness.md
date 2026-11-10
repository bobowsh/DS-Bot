# 产品名改为 LinkHarness

- 日期：2026-11-10
- 状态：**实施中**
- 相关：PR #24 已合入的「显示名 LinkBot」；本次改名

## 为什么要有这份文档

PR #24 里定的是「界面显示名统一为 LinkBot，内部产品名 `PRODUCT_NAME` 保持 `DS Bot` 不动」，理由是内部产品名决定 userData 目录，改名会把既有安装的数据指到空目录。

用户 2026-11-09 明确拍板：**产品名定为 `LinkHarness`**，全量改。这份文档记下改名范围、升级兼容怎么做的、以及验收标准。

## 要解决什么

`LinkBot` 这个名字和 DSH 宿主（DeepSeek Harness）的关系在界面上读不出来。用户要的是「LinkHarness」——一眼能看出它是 Harness 上的东西。

## 边界

**改**：
- 用户能看到的显示名（窗口标题、安装器、卸载项、exe 名、构件名、界面文案、README/文档）
- `app/electron-builder.yml` 的 `productName` / `artifactName` / linux `executableName`
- `app/package.json` 的 `productName` / `description`

**不改**：
- `appId`（`io.github.fei2411.deepseekbot`）——它是技术标识，决定 Windows 卸载项与单实例锁的 GUID 来源，改了会打断升级链
- 数据格式、会话存储、profile 名

## 升级兼容（这是本次最关键的一步）

改名会带来真实后果：安装目录从 `D:\LinkBot` 变成新的，userData 目录也跟着换。如果不管，已装用户的团队数据就「不见了」。

`app/src/legacy.mjs` 里加了「按从新到旧找回旧 userData」的名单：

```js
LEGACY_USER_DATA_NAMES = ['LinkBot', 'DeepSeek Bot']
```

启动时如果新的 userData 目录里没有数据，就按这个名单依次找旧的，找到就复用。名单按从新到旧排列，先匹配最近的上一代。

**不做**：安装目录的自动搬迁。用户重装到新目录后，旧 `D:\LinkBot` 留着不动，数据通过 userData 复用接上。

## 验收标准

1. 全新安装：界面、窗口标题、安装器、卸载项都显示 `LinkHarness`。
2. **旧数据能接上**：先有一份 `%APPDATA%\LinkBot` 或 `%APPDATA%\DS Bot` 的数据，装新版启动后，团队与 Bot 列表还在，**没有落进一个空目录**。
3. 构件名是 `LinkHarness-<version>-win-x64.exe`。
4. 门禁三件套通过：`npm test`、`npm run lint`、`build-client --check`。

## 已拍板的决策

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 产品名 | **`LinkHarness`**（用户 2026-11-09 拍板） |
| Q2 | 内部 `PRODUCT_NAME` | 跟着改成 `LinkHarness`，不再保留 `DS Bot`；旧目录靠 `LEGACY_USER_DATA_NAMES` 找回来 |
| Q3 | `appId` | **不动**，仍是 `io.github.fei2411.deepseekbot`，保住升级链 |
| Q4 | 旧安装目录 | 不自动搬迁，用户重装即可，数据靠 userData 复用接上 |

## 已知遗留

- `ds-bot/src/client/sidebar.js` 里还有一批 `LinkBot` 字面量没配翻译键，会让 `test/i18n.test.js` 的「每个字面量都有中文」失败。本次一并补齐。
- 品牌名「LinkHarness 智能工作台」是 PR #24 里定的侧栏显示名，本次不变。

Refs #24
