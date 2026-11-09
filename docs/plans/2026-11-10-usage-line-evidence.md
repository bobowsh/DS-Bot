# #19 的实测结论：宿主自己的用量行在 Bot 界面正常，不需要恢复自绘

Refs #19

## 结论

**`18395123`（删除我们自绘的 usage-line）没有造成功能消失。** 宿主自己的统计 pill 在 Bot 界面**正常渲染**，位置就在输入框下方——正是用户要的。

**issue 表格里的第三行不成立，我们不需要恢复自绘、不需要挪槽位、不需要 shadow 宿主那两颗。**

上一份文档（`2026-11-10-usage-line-evidence.md`）里「宿主 pill 在 Bot 界面不出现」的结论**是错的**，错因是**测试环境**：隔离副本里的 Bot 会话全是**从没跑过一轮的空白会话**，没有投影，宿主按自己的条件返回 null。换成**真跑过的会话**，宿主 pill 立刻就出来了。

## 决定性实测

隔离副本 `D:\dsbot-work\probe-classic`，把**真实装机的那个跑过 22 步的会话**（`session-45da00c7-…`，233 KB 日志）复制进去并让小队长的聊天指过去。

DOM 实测（`app/scripts/dom-probe.mjs`）：

```json
{"hostStatCount": 2,
 "hostStats": [
   {"stat":"activity","text":"6 轮 22 步·177 tok/s",   "box":{"x":631,"y":827,"w":153,"h":22}},
   {"stat":"usage",   "text":"1.1M tok·缓存命中 76%",   "box":{"x":796,"y":827,"w":171,"h":22}}
 ],
 "inputBox": {"x":377,"y":785,"w":837,"h":28}}
```

- 宿主的两颗 pill **都在**（`activity` 与 `usage`）。
- 位置 `y=827`，**在输入框（`y=785`）的下方**。
- 数字是真的：**6 轮 22 步 · 177 tok/s**、**1.1M tok · 缓存命中 76%**——轮数、步数、速率、token 总量、缓存命中率全有。

**截图**：`docs/acceptance/issue-19/usage-line-below-input.png`——输入框正下方那一行就是它。

## 之前为什么会误判

隔离副本的 `state.json` 里，每个 Bot 的 `model` / `appliedModel` 都是 `undefined`，会话日志只有 700 字节（空的）：

| | 真实装机 | 隔离副本（误判时） |
|---|---|---|
| 最大的会话日志 | **233,381 字节** | 710 字节 |
| Bot 的模型 | 已配置 | `undefined` |

投影由会话事件累积（`dsh-token-meter` 的 `tokenUsage` 看 `assistant/message` 的 usage），**没有跑过一轮就没有投影**，宿主 pill 按自己的条件 `if (usage === void 0 || billedInputTokens(usage) === 0 && usage.outputTokens === 0) return null` 返回 null。

**这不是「Bot 界面拿不到投影」**——投影对所有会话一视同仁，Bot 的会话就是 DSH 根 Session，与普通会话无差别。

## 顺带确认的三件事

1. **我们没有遮蔽宿主的 pill**。宿主把 `activity`（order 0）、`usage`（order 1）注册在 `conversation.composer.dock`，我们的 `btw` 在同一槽位但 order 2，排在后面；宿主的 dock 用 `renderSlot(...)` 渲染该槽位**全部占用者**，并存而非替换。
2. **我们的自绘那份已经删干净**：`usage-line.js` 不在仓库里，`bot-usage` 注册也没有，`conversation.input.dock` 上现在挂的是 members / model / question / view / secret / connector / mail——**用量行是唯一被删掉又没有任何东西接上的**。
3. **上下文项（`contextPressure` / `ContextMeter`）是另一回事**：宿主的 ContextMeter 只在 `activity` 为空时才画（`dsh-client-ui-conversation:22219`），而 `activity` 有值时它不画——所以**上下文那部分在 Bot 界面由 `activity` pill 承担**，不是缺一项。

## 结论对 issue 的意义

**#19 可以关掉**。理由（写进 issue 正文）：

- 用户要的「用量行放到输入框下面」——宿主那份本来就在那儿，`18395123` 删掉自绘的正是错的那份（它挂在 `conversation.input.dock`，在输入框**上面**）。
- 没有重复、没有缺项、数字正确。

**关闭前还要做的**：在**用户真正在用的环境**（`D:\LinkBot`，真数据真模型）上再看一眼截图，确认那边也是这个位置。本文档的证据来自隔离副本 + 真实会话数据，逻辑等价，但真机一眼更硬。

## 附：一个必须记住的坑

`app/` 把 `ds-bot` 当 `file:` 依赖，`npm install` 时会**复制**一份进 `app/node_modules/ds-bot`。改完 `ds-bot/client.js` 直接改 asar 里的那份**完全没用**——桌面应用加载的是 `app/node_modules/ds-bot/client.js`。正确顺序：`ds-bot/` 改完 → `npm run build` → `npm ci`（或把 `ds-bot/` 同步进 `app/node_modules/ds-bot/`）→ 再打包。**做隔离副本验证时同样适用**。

**另一个坑**：会话日志**不可搬**——日志里记着会话创建时的绝对 cwd，路径一变就被判为 `corrupt session log`，引擎起不来。要用真实会话，得让副本的**工作区路径**与真实一致（会话目录名由工作区路径派生，如 `--D-LinkBot-workspace--`）。
