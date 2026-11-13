# 群聊只显示对话，不显示工具块（上游自绘方案）

- 日期：2026-11-13 初稿；2026-11-14 改按上游自绘方案落地
- 状态：已实现，待 CDP 验收
- Refs #45

## 要解决什么

用户报：群里每个 Bot 的文字回复都被卷进「✨ 已调用工具」的灰色流程块里，要展开才看得见。

用户后来把口径放宽成一句人话：**「我不要显示群聊里的工具块了，只要对话内容」**。

2026-11-14 用户进一步拍板：**用上游那套自绘**（上游 v0.3.6 自己注册 `tool-call` 座位、用自己的 `ToolCell` 画团队工具卡片）。用户原话：「我要上游自己上游自己注册了 tool-call 座位，工具卡片自己的，直接用它的」。

## 真实根因（用真实群聊 DOM 取证，2026-11-13）

用户在隔离开发版建群后，CDP 读到的座位链：

```
div.O_Ebla_root                                    ← [data-step-process] 流程块
  div.O_Ebla_body > div.O_Ebla_content
    div[tool-call].EvIC1a_flowItem                 ← 座位 kind = tool-call
      div{conversation.chat.node}
        div.ztWv_q_callRow
          div{tool.call.toolview}                  ← 成员回复在这里画
            "小队长 管理员 22:19  我是群管理员，需要拍板时找我。"
```

**成员回复不在 `assistant-step` 座位里**，而在 `group_relay` 工具调用座位的 toolview 内。宿主把每次工具调用都收进流程块，所以回复跟着工具一起折叠。

### 为什么先前的方向是错的

PR #44 把文字当成成员私聊里 `assistant-step` 渲染的内容，去改 `AssistantCell`。那条路径只在**成员自己的会话窗口**里成立，群视图走的是 `GroupReplies`，两者是不同渲染路径。PR #44 对群聊无效，已关闭；它的 `answerlessReply` 也已从代码里清除。

PR #46（`fix/group-chat-conversation-only`）换了个方向：不覆盖宿主的 `tool-call` 座位，而是用 CSS 把整个流程块与工具座位藏掉，成员气泡改搬到 `conversation.chat.turnTail` 画。**这条路在 2026-11-14 被用户否决**：它把「提示与回复搬走」当成补救，而上游的做法本来就是原地画。

## 上游差异分类（2026-11-14 核对）

参照来源：上游 `Fei2411/DS-Bot` 的 `remotes/up/main`（v0.3.6，tag `v0.3.6`，提交 `a66cc737`）。

| 类别 | 内容 | 处理 |
|---|---|---|
| (a) 工具区相关 | 上游自己注册 `tool-call` / `turn-process` 座位；上游自绘 `ToolCell`（`DRAWN` 白名单，普通工具不画）；`GroupReplies` 原地画成员回复与「正在输入」提示；CSS「藏折叠标题 + 正文平铺」 | **恢复上游写法** |
| (b) 上游新特性 | `relayRange` / `groupRows` 群账本、`agent-new.js` / `phone-page.js` / locales 手机端文件、0.3.3–0.3.6 新增功能 | **不引入**（版本落差，我们的基线没有这些接口） |
| (c) 我们的定制 | LinkHarness 改名、固定数据位置、打包与安装器、群历史补录、work-details 折叠、`enterToSend` 偏好等 | **必须保留** |

上游与我们这版的行数本就接近（cells 1178/1187、index 1253/1305、styles 1468/1469、turn-reasoning 38/39），恢复成本低。

## 怎么做

### 1. 团队自绘工具座位（上游写法）

上游**自己注册 `tool-call` 座位**，用上游自己的 `ToolCell` 画；普通工具一个都不画，只有白名单里的团队工具与电脑类调用画自己的行。我们照这个做法：

- `ds-bot/src/client/cells.js` 新增 `ToolCell`：从 `node.data.root` 取整棵调用树（`callTree`，含 `subCalls`，按派发顺序、每次调用只出现一次），用 `DRAWN` 白名单过滤，命中才画。
- `ds-bot/src/client/cells.js` 新增 `TurnProcessCell`：把宿主的轮次折叠保持打开（`turnProcess.setOpen(true)`），并负责记录轮次时间与「新消息」分隔线。
- `ds-bot/src/client/index.js` 注册这两个座位：`conversation.chat.node`，key 分别是 `tool-call` 与 `turn-process`，`priority: BOT_PRIORITY`，`inject: face`。

**宿主给我们的 hook 映射**：`hooks.roster` → `useRoster`、`hooks.ui` → `useUi`、`hooks.heldCards` → `useHeldCards`、`hooks.computer` → `useComputer`（宿主按 `use${Capitalize<name>}` 把注入的 hook 变成组件 prop）。所以上游的 `ToolCell` 需要的 prop，我们的 `face` 注入正好都给了。

### 2. 成员回复与提示原地画（上游写法）

`GroupReplies` 回到上游做法：成员气泡与「正在输入」提示都画在工具座位里，不再搬去轮次尾部。上游这么做的前提是——**上游不是把整个座位藏掉，而是只藏掉「已调用工具」那个折叠标题、把正文平铺展开**，所以内容留在原地。

我们的 `GroupReplies` 之前有 bug：`useUi` 没往下传（`GroupMessage` 需要它取 reactions），已修。

### 3. CSS：藏折叠标题 + 正文平铺（上游原文）

`ds-bot/src/client/styles.js` 恢复上游那三条：

```css
[data-step-process]>div:first-child{display:none!important}
[data-step-process]>[data-step-process-body]{display:block!important;content-visibility:visible!important;max-height:none!important;overflow:visible!important;mask-image:none!important;scrollbar-gutter:auto!important}
:is([data-step-process],[data-turn-process-hidden])[hidden]{content-visibility:visible!important}
```

这三条**不再按群视图限定**，与上游一致：Bot 聊天在所有 work-details 模式下都是平的，不改用户自己的 DSH 全局设置。

### 4. 撤掉 PR #46 那套搬运改造

- 删掉 `relayRows` / `relayPut` / `relayWatchers` 与 `relaySnapshot` / `relayReset` 两个测试出口。
- `RelayTail` 只做群视图标记（`data-bt-group-chat`），不再画气泡。
- 删掉 `TEAM_TOOLS` / `TeamToolView`（宿主 `tool.call.toolview` 那条路）与 `index.js` 里的 `installTeamTools` / `teamToolFace`。

## 最终口径（用户逐项点名，2026-11-14）

| 群视图里的东西 | 处理 |
|---|---|
| 工具流程块「已调用工具」折叠标题 | **隐藏**（上游写法：藏标题行） |
| 普通工具明细（工具名、参数、输出） | **不画**（团队自绘座位只画白名单里的团队工具） |
| 轮次状态行「已完成，用时 N 秒」 | 画（上游写法：座位里只留团队自己的行） |
| 成员名、角色（管理员等） | 保留 |
| 消息时间 | 保留 |
| 成员气泡 | 保留，**原地画在工具座位里** |
| 「正在输入」提示 | 保留，**原地画在工具座位里，在气泡之前** |
| 事件行（paused / admin-passed 等） | 保留 |
| 错误提示行 | 保留 |
| 卡片（ask_user / show_view） | 保留（团队自绘座位画它，不再被隐藏） |

## 边界

- 只改 `ds-bot/src/client/`，不动宿主。
- 群视图与单视图都用上游这套：普通工具明细两边都不画（用户要的就是「不要工具明细」）。单聊的工具**过程折叠**仍由宿主画，团队的行照样在。
- 保留：成员名、角色、时间、回复顺序、多条回复；空结果不画空白气泡。

## 验收标准

1. 群聊页面里没有「已调用工具」折叠标题、没有工具名/参数/输出明细。
2. 成员回复气泡原地显示在群里，一条不少、不重复、不消失，成员名/时间/顺序正确。
3. 「正在输入」提示出现在成员气泡**之前**；回复到达后提示消失、只留气泡，不叠加。
4. 事件行与错误提示行照旧显示。
5. 门禁三项（`npm test` / `node scripts/build-client.mjs --check` / `npm run lint`）真实数字，与基线对比不新增失败。
6. 真实群聊 GUI 截图 + CDP DOM 数字，不用单聊代替。

## 已拍板决策与理由

- **用上游自绘，不自研搬运**（用户 2026-11-14 原话：「我要上游自己注册了 tool-call 座位，工具卡片自己的，直接用它的」「把这几个文件恢复为上游版本吧」）。理由：上游 0.3.2 时代我们的群聊本来就是可用形态，差别只在 dev 基线被 PR #46 换掉了。
- **只恢复 (a) 类，不整文件覆盖**（用户与队长的共同要求）。理由：上游比我们新 4 个版本，整覆盖会冲掉我们的定制并带进手机端文件。
- **CSS 三条不按群视图限定**：与上游一致；用户的诉求是「不要工具明细」，团队自绘座位已经在渲染层解决了这件事。
- **不改宿主**：全部在插件自己的 cell 与 CSS 里。

## 未定 / 后续

- 上游的 `relayRange` / `groupRows` 群账本（0.3.3+ 的新东西）没引入；如果以后要「一轮回复的历史分页」，另开需求。
- 单聊里「以工具调用收尾的轮次回复被折叠」是另一个现象，用户没报，暂不动。
