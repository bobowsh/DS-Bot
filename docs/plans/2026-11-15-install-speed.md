# 安装提速：让 data 树只解压一次到最终位置

## 要解决什么

安装一次 LinkHarness，`data/` 这棵 11,583 文件 / 242,535,502 字节的树被完整写盘 **3 次**：

```
① electron-builder 的 extractUsing7za：Nsis7z::Extract → $PLUGINSDIR\7z-out（临时目录）
② 同上宏：CopyFiles "$PLUGINSDIR\7z-out\*" → $INSTDIR
③ 我们自己的 installer.nsh customInstall：CopyFiles "$INSTDIR\data\..." → <盘>\LinkBot\data
```

①②在 `app/node_modules/app-builder-lib/templates/nsis/include/extractAppPackage.nsh` 的 `extractUsing7za` 宏里，是 electron-builder 的既有行为：它先解到临时目录再复制，注释写明是为了「atomic way」，避免升级时应用还开着导致写出半残状态。

③是我们自己的，卸载/升级语义要求 data 落在 `<盘>\LinkBot\data`（与程序目录分开，卸载不删数据），所以必须搬一次——这一步省不掉。

所以可优化的只有 ①② 这两遍。**目标：让 `data/` 只被解压一次、直接落到 `<盘>\LinkBot\data`。**

## 已拍板的决策

### 决策一：用户 2026-11-15 拍板「直接改」

> 用户原话：「直接改」

### 决策二：纠正一处对比口径（重要）

小队长给出的结论是「把 data 单独压 7z 比直接拷贝还慢 3 秒（18.3s vs 15.0s），所以 7z 这条路走不通」。

**这个对比不成立**，因为它只比了「解压 vs 拷贝」这一步，漏掉了 7z 方案真正省掉的部分：

- 现流程：`data/` 242 MB 先进安装包（NSIS 自身压缩），安装时解压到 `$PLUGINSDIR`，再 CopyFiles 到 `$INSTDIR`，再 CopyFiles 到 `<盘>\LinkBot\data`。
- 7z 方案：`data.7z` 63 MB 进安装包，安装时一次 `Nsis7z::Extract` 直接到 `<盘>\LinkBot\data`。

省掉的是 **`data/` 242 MB 在 `$PLUGINSDIR` 与 `$INSTDIR` 之间的那次 copy**（约 15 秒），以及临时目录的 242 MB 磁盘占用。代价只是解压耗时从「NSIS 解压」变成「7z 解压」，两者都是创建同样 11,583 个文件，差别很小。

**结论：7z 方案不是「更快」，而是「把 3 遍变成 2 遍」。** 这正是用户要的方向。

## 怎么做

### 1. 打包侧：生成 build/data.7z，不再把 build/data 整棵树塞进包

`app/scripts/bundled-plugin.mjs`：`prepareBundledPlugins` 装配完 `build/data` 后，用 7z 压成 `build/data.7z`。

7z 可执行文件用 electron-builder 缓存里的 `7za.exe`（`%LOCALAPPDATA%\electron-builder\Cache\7zip@*\*\bin\7za.exe`），不依赖用户装 7-Zip。

`app/electron-builder.yml`：

```yaml
extraFiles:
  - from: build/data.7z
    to: data.7z
```

### 2. 安装侧：customInstall 改为直接解压到 data home

`app/build/installer.nsh` 的 `customInstall`：

- 用 `Nsis7z::Extract` 把 `$INSTDIR\data.7z` 解压到 `<盘>\LinkBot\data`
- 解压后删掉 `$INSTDIR\data.7z`
- 插件白名单保护保留：解压到临时目录，再按 `factory/plugins.txt` 白名单搬到 profiles，**用户自己装的插件不被覆盖**

### 3. 兜底

解压失败不能给用户一个装不起来的应用：

- 解压到临时目录失败 → 保留 `$INSTDIR\data.7z` 并提示，首次启动可从它恢复
- 各步失败置 `$R7 = 1`，与现有语义一致（首次启动从 `$INSTDIR\data` 读）

## 验收标准

1. 改前基线耗时（同机静默安装，`/S /D=<临时目录>`）
2. 改后耗时，同一方法
3. 报出 X 秒 / Y 秒 / 减少 Z 秒
4. 两边装出来的目录结构与文件数一致
5. `$INSTDIR\data.7z` 装完已删除
6. 新包体积不比现在大
7. `app/test` 与 data-packaging 测试通过

## 开放问题

- 用户自己装的插件保护：现有白名单逻辑必须保留，改成整体解压会破坏它
- 安装包体积：242 MB 树压成约 63 MB，包体积应下降约 60 MB

## 变更日志

- 2026-11-15 建立；纠正「7z 更慢」的对比口径
