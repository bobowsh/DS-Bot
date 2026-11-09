# 0.3.0 装机验收操作清单（#12 打包通道）

> 面向亲手双击安装的人：照着这条线走，每一步都有「看什么」和「算过还是不过」。
> 与另外两份文档的分工：
> - [2026-11-08-issue12.md](2026-11-08-issue12.md)：自动更新**链路**的验收（22:00 触发、catalog 增删、回滚），不是装机操作
> - [2026-11-08-factory-packaging-manifest.md](../plans/2026-11-08-factory-packaging-manifest.md#验收标准)：**打包产物**的 7 条判据
> - 本文：**装到机器上之后**，12 插件 + 4 技能到底有没有真加载

## 被测对象

| 项 | 值 |
|---|---|
| 安装包 | `app/dist-pack/LinkBot-0.3.0-win-x64.exe` |
| 字节数 | 353,741,877（337.4 MiB），2026-11-08 16:41 |
| 安装路径 | `D:\LinkBot\app`（安装器路径页默认就从这里起） |
| 数据路径 | `D:\LinkBot\data`（安装目录上一级） |

目标清单：**12 个插件 + 4 个技能**。

## 先分清两个 `data`（这里最容易误判）

| 路径 | 是什么 | 装完之后 |
|---|---|---|
| `dist-pack\win-unpacked\data` | **安装包内部**的随包资源，来自 `electron-builder.yml` 的 `extraFiles: from build/data to data` | 被安装器复制到 `<安装目录上一级>\data`；原位置仍留一份副本（`D:\LinkBot\app\data`），安装器只 Copy 不删 |
| `dist-pack\data` | **运行时**数据目录：直接跑 `win-unpacked\LinkBot.exe` 时，程序按「exe 所在目录的上一级」算出来的 DSH_HOME | 不属于安装包 |

安装器的搬运（`app/build/installer.nsh` 的 `customInstall`，L231-310）：

- 12 个插件按 `plugins.txt` 逐个替换到 `<上一级>\data\profiles\ds-bot\node_modules\<名>`（L260-266）；清单之外的用户插件不动
- `factory\*` 整个拷过去（L279-282）
- 4 个技能覆盖到 `<上一级>\data\skills\<slug>`，被替换的旧内容各留一份 `.bak`（L294-299）

所以装到 `D:\LinkBot\app` 之后：程序在 `D:\LinkBot\app\`，真正的数据在 `D:\LinkBot\data\`。

## 第 0 步：装之前必须先处理这两处（否则验不出东西）

### 0.1 `%APPDATA%\LinkBot\locations.json` 现在指向测试目录

实测内容（2026-11-08 16:4x）：

```json
{
  "dataDir": "E:\\dsbot-work\\DS-Bot\\app\\dist-pack\\data",
  "workspace": "E:\\dsbot-work\\DS-Bot\\app\\dist-pack\\workspace",
  "freeAtStart": 7867215872
}
```

这是打包后跑测试留下的。**它存在就不会重新选数据目录**，装完启动会拿 `dist-pack\data` 当数据目录，你验的是打包机的产物树，不是新装好的这台机器。

处理：备份后删掉。

```powershell
Copy-Item "$env:APPDATA\LinkBot\locations.json" "$env:APPDATA\LinkBot\locations.json.bak-1108"
Remove-Item "$env:APPDATA\LinkBot\locations.json"
```

### 0.2 `D:\LinkBot\data` 是旧版本数据（旧布局）

实测：里面有 `skills-repo`、没有 `skills`；`factory` 最后改动 11-05。旧 `factory/plugins.json` 会挡掉新包里的 12 条清单，旧 `skills-repo` 也会让「4 个新技能落盘」这件事看不出来。

处理：**改名保留**（别删，里面是旧会话数据）。

```powershell
Rename-Item 'D:\LinkBot\data' 'D:\LinkBot\data.bak-1108'
```

如果要保留旧会话继续用，那就不能改名——但那样只能验「覆盖升级」，验不了「首启预置」，两者选一，自己定。

`D:\LinkBot\app` 现在是**空目录**（0 个文件），安装器往里写不会有冲突。

## 第 1 步：安装

1. 双击 `E:\dsbot-work\DS-Bot\app\dist-pack\LinkBot-0.3.0-win-x64.exe`
2. 路径页确认是 **`D:\LinkBot\app`**，不是 `D:\LinkBot`（安装器会自己追加，别手动补）
3. 装完**先别急着点启动**，让它退出

## 第 2 步：启动并等首启跑完

启动后**等 30 秒以上**再取证据——首启的资源复制是 `setImmediate` 不 await 的，复制没完就去看会看到「目录缺失」的假象。

## 第 3 步：验 4 项硬指标

### 3.1 数据目录与首启标记

```powershell
Get-Content "$env:APPDATA\LinkBot\locations.json" -Raw
```

过：`dataDir` = `D:\LinkBot\data`。

### 3.2 12 个插件真落地

```powershell
Get-ChildItem 'D:\LinkBot\data\profiles\ds-bot\node_modules' -Directory |
  ForEach-Object {
    if ($_.Name -like '@*') { Get-ChildItem $_.FullName -Directory | ForEach-Object { '@' + $_.Parent.Name.Substring(1) + '/' + $_.Name } }
    else { $_.Name }
  }
```

应该正好是这 12 个（多一个少一个都不算过）：

```
@astron-team/skillhub-dsh
@linxin666/dsh-client-ui-git-graph
ds-harness-remote
dsh-aide
dsh-better-sidebar
dsh-chat-import
dsh-plugin-guide
dsh-rule-manager
dsh-screenshot-native
dsh-tool-activator
dsh-xdpool
dshmarket
```

**光目录在不算过**——还要看应用里插件管理器是否把 12 个都列为已启用。

### 3.3 4 个技能落地

```powershell
Get-ChildItem 'D:\LinkBot\data\skills' -Directory | Select-Object Name
```

应该是 `cua-driver`、`grilling`、`skillhub-cli`、`ub-mode`。

### 3.4 cua-driver 二进制能跑

```powershell
& 'D:\LinkBot\data\skills\cua-driver\bin\cua-driver.exe' --version
```

过：返回版本号（打包侧记录为 0.36.0）。

## 第 4 步：抽查功能（别只验「加载了」）

挑 2 到 3 个，实际操作一遍：

- **截图插件**：让它截一张，图能出来
- **git-graph**：打开仓库面板，图能画出来
- **侧栏**：`dsh-better-sidebar` 的布局生效
- **cua-driver**：让它读一次窗口的可访问性树

## 第 5 步：写结论

只认四种写法：

| 结果 | 含义 |
|---|---|
| PASS | 有真实输出/截图/文件比对作证 |
| FAIL | 实测不符，附实际与期望 |
| BLOCKED | 缺前置条件，写明解除条件 |
| 不写 | 等于未验证，不许当通过 |

## 已知不覆盖

- 内网 Gitea registry 真实拉取：打包侧标 `BLOCKED`（内网断），本次装的是本地兜底产物，验不了这条
- 自动更新链路（22:00、catalog 增删、回滚）：归 [issue12 验收说明](2026-11-08-issue12.md)，本文不覆盖
