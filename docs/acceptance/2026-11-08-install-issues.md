# 装机实测问题台账（2026-11-08 起）

> 每次用户装包实测报的问题都记在这里，逐条给状态、证据、责任人。
> 证据口径：只写实测到的东西，没验证的标「未验证」，不写「应该可以」。

## 被测对象

| 项 | 值 |
|---|---|
| 安装包 | `app/dist-pack/LinkBot-0.3.0-win-x64.exe` |
| 字节数 | 404,763,321（386.2 MiB），2026-11-08 23:03:20 |
| 对应提交 | `b1dde63c`（2026-11-08 22:44:16） |
| 安装路径 | `D:\LinkBot\app` |
| 数据路径 | `D:\LinkBot\data` |

## 问题清单

| # | 现象 | 状态 | 证据 / 根因 | 责任人 | 下一步 |
|---|---|---|---|---|---|
| 1 | 设置里「工作步骤展示」改了存不住，重启回「完全展开」 | 修法中 | 扫 `D:\LinkBot\data` 全部配置：**没有任何文件记录用户选的档位**；`profiles\ds-bot\cordis.patch.yml` 里 `transcriptView` 已删，仅剩空 `ui-chat` 条目（该整条删）。结论：不是被覆盖，是从未落盘——设置行是自绘的，只改了内存状态 | 小柚子（DSH开发） | 落盘到团队偏好并启动回写宿主；验收必须「改一次→重启→还是它」 |
| 2 | 任务栏图标显示成一页纸默认图标 | 待用户验证 | `LinkBot.exe` 的 PE 里 `RT_GROUP_ICON` 存在，16/20/24/32/36/40/48/64/72/96/128/256 全尺寸；`FileDescription`/`ProductName` 均为 LinkBot；托盘 ico 也正常。判定 Windows 按路径缓存旧图标 | 我 | 用户取消固定→重开→再固定，看是否恢复 |
| 3 | AIDE 在 DS Bot 界面打开时，Bot 列表不隐藏，要再点「切回经典界面」才完全切换 | 修法中 | `aide-button.js` 原先点击只 `requestAideWorkbench()`；现改为观察工作台开合并收起列 | 小柚子（DSH开发） | 提交 + 装机复验 |
| 4 | 用量状态条完全不见了（上下文那一项也没了） | 需定方案 | 解已装 `app.asar`：`bt-stat-pill`、`UsageLine`、`bt-usage`、`USAGE_LINE_CSS` **全部不存在**——自研那份被删，**宿主没有在 Bot 界面接管**。此前「宿主 pill 已能显示同样数字」的判断被实测推翻 | 我 | 回退自研 usage-line 或补注册，二选一 |
| 5 | 经典界面 footer 没有 AIDE 快捷图标 | 修法中 | 源码里 `sidebar.footer.action` 注册了 `bot-aide`（order −190），但 Agent 模式下不显示 | 小柚子（DSH开发） | 提交 + 装机复验 |
| 6 | 设置 → 本地 Agent 点击即崩 | 上游已修，待升级 | 上游 0.3.1 的 `02afd07b`（PR #1017，Fixes #1016）：设置页从 `run()` 取数据，而 `run()` 返回的是调用成功与否的布尔，渲染 `view.detected.length` 即 `true.detected.length` → TypeError；无错误边界，DSH 直接禁用整个 overlay slot。本地探针实测服务端正常（`available=true, detected=0, custom=0`） | 我 | 合并上游 v0.3.1（`6559c9e7`） |
| 7 | 设置 → 电脑操控报 `library open failed: ...app.asar\node_modules\@trycua\cua-driver-win32-x64-msvc\cua_driver_sdk.dll: Could not open library: 找不到指定的模块 (os error 126)` | 修法中 | 实测两条路径：真实路径 `app.asar.unpacked\...\cua_driver_sdk.dll` **加载成功 6 ms**；asar 内路径**不存在并报同一句错**。DLL 已正确解包，问题是 `createRequire().resolve()` 在 asar 内返回 asar 路径，`existsSync` 因 Electron 补丁返回 true 骗过校验，`dlopen` 不走 asar 透明层 | 我 | `@trycua` 移出 asar，改走 `extraResources` 落到 `resources/node_modules/@trycua` |
| 8 | AIDE 界面右侧的 DSH 对话窗口一直出不来（之前见到过出来） | 未定位 | AIDE 为第三方插件 `dsh-aide` 0.12.0。用户说明「之前见到过出来的」→ 属回归 | 待派 | 先确认最近一次能出来是哪个包/版本，缩小到是升级引起还是配置引起 |

## 备注

- #6 与 #7 不是同一个问题：#6 是设置页渲染层异常（上游已修），#7 是原生库加载路径（上游未修，v0.3.0→v0.3.1 的 17 个文件里无 cua 相关改动）。
- #2 若用户重建固定项后仍不对，则改判为产品缺陷，转我重新定位。