# 群聊只显示对话，不显示工具块

- 日期：2026-11-13
- 状态：已实现，已用真实群聊 GUI 验收
- Refs #45

## 要解决什么

用户报：群里每个 Bot 的文字回复都被卷进「✨ 已调用工具」的灰色流程块里，要展开才看得见。

用户后来把口径放宽成一句人话：**「我不要显示群聊里的工具块了，只要对话内容」**。

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

群会话日志佐证：`session-ffdef76e` 的 turn 1–5 每轮只有一条 `tool(group_relay)`，没有 assistant 文字。回复文字是 `group_relay` 的**结果**，由 `ds-bot/src/client/cells.js` 的 `TeamToolView` → `case 'group_relay'` → `GroupReplies` 画出。

### 为什么先前的方向是错的

PR #44 把文字当成成员私聊里 `assistant-step` 渲染的内容，去改 `AssistantCell`。那条路径只在**成员自己的会话窗口**里成立，群视图走的是 `GroupReplies`，两者是不同渲染路径。PR #44 对群聊无效，已关闭；它的 `answerlessReply` 也已从代码里清除。

## 边界

- 只改 `ds-bot/src/client/`，不动宿主。
- 群视图：只显示对话（用户消息 + 成员回复气泡）；工具块、工具行、轮次状态行都不显示。
- 单视图：完全不变，工具过程照旧显示。
- 保留：成员名、角色、时间、回复顺序、多条回复；空结果不画空白气泡。

## 怎么做

宿主把一次工具调用的座位固定为 `tool-call`，我们的 `TeamToolView` 只能改**槽里**的内容，改不了座位归属。所以回复要离开流程块，必须在座位之外另画。

1. **`GroupReplies` 把成员气泡交给轮次尾部**：工具行里不再画气泡，只留「正在输入」。气泡按下标存进模块级 `relayRows`（键：sessionId + turn）。
   - turn 从**自己这次调用所在座位**取：座位祖先带 `data-chat-call-id` 与 `data-chat-turn`，两者一一对应（已用 CDP 验证 9 个轮次全部对应）。用 `callId` 做二次校验，不匹配就不写。
   - 不用「整页第一个 toolview」兜底——那样只有第一轮对得上。
2. **新增 `RelayTail` 组件**，注册到 `conversation.chat.turnTail` 插槽（宿主 L9003 已提供），按轮次取 `relayRows` 里的回复，用 `GroupMessage` 画在流程块之外，身份、时间、顺序与原来一致。
3. **群视图标记**：`RelayTail` 按 `roster.roomsById[sessionId]` 精确设置/清除会话容器上的 `data-bt-group-chat`（单聊必须主动清除，否则切会话后标记残留会把单聊工具块也藏掉——这个 bug 在验收时真实出现过，已修）。
4. **CSS 兜底**：只对带 `data-bt-group-chat` 的容器隐藏 `[data-step-process]`、`[data-chat-flow-kind="turn-process"]`、`[data-chat-flow-kind="tool-call"]`。单聊不挂标记，完全不受影响。

### 最终口径（用户逐项点名，2026-11-14）

| 群视图里的东西 | 处理 |
|---|---|
| 轮次状态行「已完成，用时 N 秒」 | **隐藏** |
| 工具流程块「已调用工具」 | **隐藏** |
| 工具调用座位 | **隐藏** |
| 成员名、角色（管理员等） | 保留 |
| 消息时间 | 保留 |
| 成员气泡 | 保留，且画在流程块之外 |
| 事件行（paused / admin-passed 等） | 保留 |
| 错误提示行 | 保留 |

保留项都随成员气泡一起画在轮次尾部（`conversation.chat.turnTail`），因此隐藏工具座位不影响它们。

### 已知限制

**卡片（ask_user / show_view）在群视图会随 tool-call 座位一起隐藏。** 转录里的卡片由 `TeamToolView` 画在 `tool-call` 座位内（`cells.js` 的 `case 'ask_user'` → `.bt-q-inline`），而群视图隐藏了这个座位。实测群聊走 `group_relay` 路径时**不产生这类卡片**（成员在群里不会发 ask_user），所以目前没有实际损失；若将来群里出现卡片，需要把它像成员回复一样搬到轮次尾部。输入框上方的 dock（`conversation.input.dock`）不在座位内，不受影响。

## 验收标准

1. 群聊页面里没有「已调用工具」块、没有工具行、没有「已完成，用时」状态行。
2. 成员回复气泡在流程块之外独立成行，一条不少、不重复、不消失，成员名/时间/顺序正确。
3. 空结果的轮次不出现空白气泡。
4. 单聊的工具块与状态行完整保留。
5. 门禁三项（`npm test` / `node scripts/build-client.mjs --check` / `npm run lint`）真实数字，与基线对比不新增失败。
6. 真实群聊 GUI 截图 + CDP DOM 数字，不用单聊代替。

## 已拍板决策与理由

- **群聊只显示对话，单聊不变**（用户 2026-11-13 原话：「我不要显示群聊里的工具块了，只要对话内容」）。根因与「是不是群」无关，但用户明确要的是群聊侧的观感，单聊的工具过程是监督功能、用户没要求动，所以按会话区分。
- **不修 `AssistantCell`**：它画不到群聊的成员回复（真实 DOM 已证明）。
- **在 turnTail 画、不在 toolview 内画**：座位归属由宿主决定，槽内无论如何都在流程块里。
- **不覆盖宿主的 tool-call 座位**：keyed 槽一旦被我们注册就会顶掉宿主默认渲染，即使返回 null 也不回退，单聊会一起受害。改用 CSS 按群标记隐藏，风险最小。
- **为什么不再沿用 answerlessReply 方案**：它改的是单聊里「以工具调用收尾的轮次」，与用户报的群聊问题不是同一条路径；群聊里回复在 toolview 内，与 assistant-step 无关。

## 未定 / 后续

- 单聊里「以工具调用收尾的轮次回复被折叠」是另一个现象，用户没报，暂不动；如需处理另开 issue。
