# 装机后反馈的四件界面修正

- 日期：2026-11-08
- 状态：**实施中**
- 相关：Issue #12（打包与出厂清单）；PR #24

## 为什么要有这份文档

用户装了 2026-11-08 19:57 那一版安装包，反馈四件事：

1. 设置里的「工作步骤展示」选什么都存不住，重启又回「完全展开」。
2. 侧栏的品牌名要改成「LinkHarness 智能工作台」，没改。
3. 页脚那一行图标后面还带着文字（LinkBot / 导入会话 / 设置），要的是纯图标。
4. `dsh-tool-activator` 还在插件列表里，卸不掉。

前两件和第三件都写在这份文档里。第四件是出厂清单的事，见 [出厂插件与技能的打包与预置](2026-11-08-factory-packaging-manifest.md) 与本文末尾的「不做的事」。

## 一、工作步骤展示存不住

### 现象与根因

用户在设置页选「标准」，卡片关掉、重启 LinkBot，又是「完全展开」。

这不是设置页坏了，是**profile 的 patch 行盖住了用户的选择**。实测存量机器上
`D:\LinkBot\data\profiles\ds-bot\cordis.patch.yml` 里有：

```yaml
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: verbose
```

这一行是旧版 DS Bot 启动时用 `chatSettings.set('transcriptView', ...)` 写进去的——那个写入落在
profile 的 patch 文件里，而不是用户的设置文档。而 patch 行的 `config` 排在用户设置文档**之前**，
于是：

- 用户在设置页选任何档位，宿主把它写进设置文档；
- 启动时 patch 行又把它盖回 `verbose`；
- 界面上看着能改，重启就回退。

### 已拍板决策

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 修哪一头 | **两头都改**。只改 app 侧（删 patch 行），客户端下次启动又会写回去；只改客户端，存量机器的 patch 行还在，照样盖住 |
| Q2 | 客户端还写不写默认值 | **不写**。宿主自己的默认（桌面端）就是「标准」，我们没有理由再抢着写一遍 |
| Q3 | patch 行怎么处理 | **删掉 `transcriptView` 那一行**，不是替换成 `standard`。只要这个键还在 patch 里，用户的任何选择都会被盖住；换成另一个被盖的值没有意义 |
| Q4 | 删完剩个空条目怎么办 | 整条 `- id: ui-chat` 一并删除。它只剩 id 与 name，留着只是个空壳 |
| Q5 | 别的行 | **原样保留**。迁移只动 `transcriptView` 这一个字段，同一条目下的其它 config 不碰 |
| Q6 | 用户之后主动选「完全展开」 | **不再被归位**。删掉 patch 行之后，设置页是唯一的事实来源，选什么就是什么 |

### 怎么做

**客户端**（`ds-bot/src/client/index.js`）：删掉 `ensureMode()` 及其调用。`adopt()` 留着，只读不写。

**宿主**（`app/src/own-ui-patch.mjs` + `app/src/host.mjs`）：新增 `dropWorkDetailsPatch(file)`，
在启动时对 profile 的 `cordis.patch.yml` 做一次幂等的清理——按行读，找到 `- id: ui-chat` 的条目块，
去掉 `transcriptView:` 那一行；若 `config:` 下再无别的字段，把 `config:` 也去掉；若整块只剩 id 与
name，把整块去掉。函数可注入 `read`/`write`，测试不需要真的文件。

**为什么不整份 YAML 解析后重写**：patch 文件是 DSH 生成的，形状稳定；整份解析重写会把用户手工改过
的键顺序打乱。文本处理保住了文件里其余部分原样。

### 验收标准

- 新机器（没有 patch 行）：设置页选「标准」→ 重启 → 仍是「标准」；选「紧凑」→ 重启 → 仍是「紧凑」。
- 存量机器（有 `transcriptView: verbose`）：升级后启动一次，patch 行被清掉；之后同上。
- `app/test/own-ui-patch.test.mjs` 覆盖：删除该字段、保留同条目的其它字段、无该字段的文件不动、文件不存在不算错。

## 二、品牌名

用户要宿主侧栏左上角的品牌显示名是「LinkHarness 智能工作台」（截图里是 deepseek 的鲸鱼 + HARNESS 徽章）。

**为什么之前没生效**：DS Bot 已经 shadow 了 `sidebar.brand.mark` 与 `sidebar.brand.name`，但那两个注册
挂在 `installShell` 里——只在 **Bot 模式**装；用户截图那个是 **Agent 模式**（宿主原生界面），那时
shell 组没装，shadow 不在，于是宿主自己的品牌渲染了出来。

**怎么做**：把这两个注册从 `installShell` 挪出来，和 `BotReturn` 一样挂在两个组之外——两种界面都生效。
`BrandName()` 的文案从 `'LinkBot'` 改成 `'LinkHarness 智能工作台'`，样式从内联 style 改成
`.bt-brand-name` 类（进了 `styles.js` 的变量与样式表，不再是散落的内联值）。

**验收标准**：Bot 模式与 Agent 模式的侧栏左上角都显示「LinkHarness 智能工作台」。

## 三、页脚只留图标

用户指的那一行是宿主侧栏页脚：`sidebar.footer.action`（账号、AIDE、导入会话）与 `sidebar.settings`
（设置）两个 slot。宿主给每个 slot 传 `wide`，组件按 `wide` 决定是否画文字——所以宽态下三个按钮后面
都带着字。

**怎么做**：
- 我们自己的 `BotReturn`：不再画 `bt-return-name` 那个文字节点，只剩图标。
- 宿主那一行：用 CSS 把页脚里按钮的文字收掉——`font-size:0` 让文字节点不占位，图标用自己的尺寸
  不受影响（`svg` 上的 `font-size` 单独给回 14px）。按钮的文字本来也没有统一的类名（导入按钮是
  裸文本节点），所以按容器而不是按类名来收。

**已知边界**：这是用样式把文字藏起来，不是改别人的组件。宿主换版本时这条选择器可能失效，表现为
文字又回来了——那时再按新结构改。

**验收标准**：Bot 模式与 Agent 模式的侧栏页脚都只剩图标，没有文字。

## 验收标准（整体）

- `ds-bot`：`npm run build` 后 `node scripts/build-client.mjs --check` exit 0；`npm run lint` 0 errors；
  `npm test` 与干净基线同口径。
- `app`：`npm test` 与干净基线同口径。
- 装机实测：设置页选档位 → 重启 → 档位还在；侧栏品牌名是「LinkHarness 智能工作台」；页脚只有图标。

## 不做的事

- **不做 `dsh-tool-activator` 的自动清理**。用户机器上的 0.4.3 是旧版本装下来的残留，新包的出厂清单里
  已经没有它。等内网恢复、0.5.0 推上内网 registry 后，把它加回清单，残留被新版本覆盖，问题自然闭合。
  自动清理会引入「名单的名单」，还有误删用户自己装的同名包的风险。
- **不补英文版品牌名**。这一版的品牌名只有中文一种；`BrandName` 是插件自己的组件，不走宿主的
  多语言字典。
