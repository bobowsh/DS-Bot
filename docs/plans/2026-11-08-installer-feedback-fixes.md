# 装机后反馈的五件修正

- 日期：2026-11-08
- 状态：**实施中**
- 相关：Issue #12（打包与出厂清单）；PR #24

## 为什么要有这份文档

用户装了 2026-11-08 23:03 那一版安装包，反馈五件事：

1. 设置里的「工作步骤展示」选什么都存不住，重启又回「完全展开」。
2. 任务栏上的 LinkBot 图标不对，还是一页纸那种默认图标。
3. AIDE 在 Bot 界面打开时，左边 Bot 列表没收起，要再点一次「切回经典界面」才完全切换。
4. 用量状态条不见了，完全没有。
5. AIDE 的图标在经典界面下没有出现在「导入会话 / Bot」那个快捷区域。

这份文档记下每一件的根因、做法与验收标准。

> **第一版文档的根因判断是错的，这里更正。** 第一版说「profile 的 patch 行盖住了用户的选择」，并把修法定为「把 patch 行里的 `transcriptView` 删掉」。**实测证明这是反的**：宿主的设置文档**就是** profile 的 `cordis.patch.yml`（`dsh-config-editor` 的 `documentPath` = `profileContext.patchPath`），所以 patch 行里的 `transcriptView` **就是用户层**，不是压在用户之上的东西。删掉它等于把用户的选择删掉，档位于是回落到基础层的 `detailed`——而 `detailed` 的中文正是「完全展开」。这就是第一版修完反而更糟的原因。

## 一、工作步骤展示存不住

### 现象与根因

用户在设置页选「标准」，重启 LinkBot，又是「完全展开」。

查出来是**我们自己写的**：`75b346ea`（11-07 19:56，提交说明写着「open the work details by
default」）在**每次启动时把档位写成 `verbose`**：

```js
if (value?.transcriptView === undefined) void chatSettings.set('transcriptView', DEFAULT_WORK_DETAILS)
```

用户改了档位，宿主把它写进设置文档；下一次启动，这行又把它改回 `verbose`。改一轮、重启、又
是「完全展开」——这就是「存不住」的全部。

> **前两版判断都错了，这里记下来免得再来一遍。**
>
> - 第一版说「profile 的 patch 行盖住了用户的选择」，修法是「把 patch 行里的 `transcriptView`
>   删掉」。**这是反的**：宿主的设置文档**就是** profile 的 `cordis.patch.yml`
>   （`dsh-config-editor` 的 `documentPath` = `profileContext.patchPath`），所以 patch 行里的
>   `transcriptView` **就是用户层**。删掉它等于把用户的选择删掉，档位于是回落到基础层的
>   `detailed`——而 `detailed` 的中文正是「完全展开」。修完反而更糟。
> - 第二版说「用户的选择根本没落盘」。落盘是有的：宿主的设置页把值写进了设置文档，只是我们
>   每次启动又覆盖它。

宿主自己的档位有四档（`dsh-client-ui-chat` 的 `TranscriptViewMode`）：`compact` 简洁、
`standard` 标准、`detailed` 详细、`verbose` 完全展开。

### 做法

**客户端**（`ds-bot/src/client/index.js` + `work-details.js`）：

- **启动时不再写任何默认档位**。profile 没有选择就用宿主自己的值。
- 团队自己的偏好里**另存一份**（`state.prefs.workDetails`，走既有的 `set-prefs` 通道），
  启动时若团队有值就把它交给宿主——这是用户选择的第二个落点。
- 用户在设置页改档位时，宿主的字段与团队偏好一起写。

**宿主侧**（`app/src/own-ui-patch.mjs` + `app/src/host.mjs`）：存量 profile 的 `ui-chat` 行里
那个旧默认值**归位成 `standard`**；只有 id 与 name 的空壳条目**整条删掉**。

### 验收标准

- 全新机器：设置页选「标准」→ 重启 → 仍是「标准」；选「紧凑」→ 重启 → 仍是「紧凑」。
- 存量机器（旧版写过 `verbose`）：升级后启动一次，旧值被归位成 `standard`；之后用户选什么存什么。
- `ds-bot/test/work-details.test.js` 覆盖「团队没有值时什么都不写」这条（它就是这次修好的那条）；
  `app/test/own-ui-patch.test.mjs` 覆盖归位的幂等、空壳条目被删、用户已选的值不被改。

## 一之二、「显示思考过程」开关放回来

这个开关原来有，`49969130`（11-07 13:21，「Render tool calls and the token rate with the host's
own UI」）把它**退休**了，理由是「工作步骤档位已经决定思考过程是否显示」——`compact` 档折叠它，
其余三档显示。

用户要它回来，而且要**能单独开关**。

**做法**：`prefs.thinking` 回到偏好里（`set-prefs` 接受 `true`/`false`/`null`）。

- **未设置**：跟随档位（只有 `compact` 折叠思考）。
- **用户设了**：用户的开关赢过档位——思考该显示就显示、该藏就藏，与档位无关。

`ds-bot/test/install.test.js` 里那条「prefs 不保留 thinking 开关」的断言改回「保留」。

## 二、品牌名

用户要宿主侧栏左上角的品牌显示名是「LinkHarness 智能工作台」。

**为什么第一版没生效**：DS Bot 已经 shadow 了 `sidebar.brand.mark` 与 `sidebar.brand.name`，
但那两个注册挂在 `installShell` 里——只在 **Bot 模式**装；用户截图那个是 **Agent 模式**
（宿主原生界面），那时 shell 组没装，shadow 不在，于是宿主自己的品牌渲染了出来。

**做法**：把这两个注册从 `installShell` 挪出来，和 `BotReturn` 一样挂在两个组之外——两种界面
都生效。`BrandName()` 的文案改成「LinkHarness 智能工作台」，样式从内联 style 改成
`.bt-brand-name` 类。

**验收标准**：Bot 模式与 Agent 模式的侧栏左上角都显示「LinkHarness 智能工作台」。

## 三、页脚只留图标

用户指的那一行是宿主侧栏页脚：`sidebar.footer.action`（账号、AIDE、导入会话）与
`sidebar.settings`（设置）两个 slot。宿主给每个 slot 传 `wide`，组件按 `wide` 决定是否画
文字——所以宽态下三个按钮后面都带着字。

**做法**：

- 我们自己的 `BotReturn`：不再画 `bt-return-name` 那个文字节点，只剩图标。
- 宿主那一行：用 CSS 把页脚里按钮的文字收掉——`font-size:0` 让文字节点不占位，图标用自己的
  尺寸不受影响。按钮的文字本来也没有统一的类名（导入按钮是裸文本节点），所以按容器而不是
  按类名来收。

**已知边界**：这是用样式把文字藏起来，不是改别人的组件。宿主换版本时这条选择器可能失效，
表现为文字又回来了——那时再按新结构改。

**验收标准**：Bot 模式与 Agent 模式的侧栏页脚都只剩图标，没有文字。

## 四、AIDE 打开时收起 Bot 列

AIDE 工作台注册在宿主的 `main` slot，展开时**占住主区域**；而我们的 Bot 列是**自绘的浮层**
（`bt-leftcol`），不随主区域切换而收起——于是工作台和 Bot 列并排，用户得再点一次
「切回经典界面」才完全切换。

**做法**：AIDE 在页面上留下自己的根节点（`.dvw-overlay`）。我们用 `MutationObserver` 看着它
（`aide-bridge.js` 的 `watchAideWorkbench`），它在时把我们的列按「收起」处理——与用户手动收起
列走同一条路径，动画与占位都对。

**验收标准**：在 Bot 界面点 AIDE，左列立刻收起；关掉工作台，左列回来。

## 五、AIDE 按钮在经典界面的页脚

**为什么没出现**：`AideFooterButton` 注册在 `installShell` 里——只在 Bot 模式装。经典界面
（Agent 模式）没有 shell 组，所以宿主侧栏页脚里没有这个按钮。

**做法**：与品牌名一样，把这个注册挪到两个组之外。`FooterAccount`（账号菜单）同样是宿主
页脚的东西，也一并挪出去。

**验收标准**：经典界面的侧栏页脚里有 AIDE 图标，与导入会话、设置按钮同一行。

## 六、任务栏图标

**实测**：安装后的 `D:\LinkBot\app\LinkBot.exe` 与打包出的 `dist-pack\win-unpacked\LinkBot.exe`
**字节完全相同**（246,338,048 字节），exe 的图标资源里 16/20/24/32/36/40/48/64/72/96/128/256
全套尺寸都在，`assets/icon.ico` 与 `assets/icon.png` 的内容也是白底蓝鲸鱼。

所以**不是包里的图标丢了**。用户看到的「一页纸」是 Windows 的**任务栏图标缓存**：exe 的路径
没变而内容变了，Windows 按路径缓存图标，不会立刻刷新。

**做法**：这一条没有代码改动。给用户的办法是让 Windows 重新读图标——重启资源管理器
（任务管理器 → 「Windows 资源管理器」→ 重新启动），或删掉
`%LOCALAPPDATA%\Microsoft\Windows\Explorer\IconCache.db` 后注销重登。

## 七、用量状态条不见了

**根因**：DS Bot 自己的样式里有一条

```css
[data-composer-dock]{display:none!important}
```

它把宿主输入框下方那个 dock 整个藏了。宿主自己的**用量条（活动与 token 的两个 pill）和上下文
环**都住在那个 dock 里——所以一并没了。

这一条 CSS 当初是为了藏宿主自己的上下文环（那时我们自绘用量条）。#19 删掉自绘的
`usage-line.js` 之后没人把它改回来。

**做法**：删掉这条 `display:none`。宿主自己的 dock 就按宿主的样式显示——用量条在输入框下方、
含上下文项、位置由宿主定，正是用户要的样子。追问卡（`bt-btw`）在时仍按原规则独占那一行。

**验收标准**：Bot 界面输入框下方有用量条（轮数、步数、tok/s、token、缓存命中）与上下文项。

## 不做的事

- **不做 `dsh-tool-activator` 的自动清理**。用户机器上的 0.4.3 是旧版本装下来的残留，新包的
  出厂清单里已经没有它。等内网恢复、0.5.0 推上内网 registry 后，把它加回清单，残留被新版本
  覆盖，问题自然闭合。自动清理会引入「名单的名单」，还有误删用户自己装的同名包的风险。
- **不补英文版品牌名**。这一版的品牌名只有中文一种；`BrandName` 是插件自己的组件，不走宿主的
  多语言字典。
