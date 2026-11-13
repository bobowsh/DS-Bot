# 以工具调用收尾的轮次，助手文字单独成行

- 日期：2026-11-13
- 状态：已实现，待验收
- Refs #43

## 要解决什么

群里每个 Bot 的文字回复都被收进「✨ 已调用工具」那个灰色流程块里，跟工具调用挤在一起，用户读不到对话本身。用户原话：「不光小队长，你们的回复都进工具块下面折叠起来了」。

## 根因（已用代码与会话日志坐实）

DSH（0.2.2-rc.1）在 `@deepseek-ai/dsh-client-ui-chat/lib/client.js` 里判定「这段是回答」：

- L12843 `latestAnswer()`：本轮**最后一个 step** 必须含回复文字，且不含 `tool-call`，才被认作答案。
- L12864：认不出答案时 `answerAnchorSeq = null`、`answerStep = null`。
- L4514 `processMember`：`answerAnchorSeq === null` 时把所有 step 都划进流程块。
- L4515 `processAnswer`：恒为 `false`，没有任何 step 单独成行。
- L4527 `foldable`、L4544 `hasContent`：仍为 `true`，于是流程块可折叠且默认展开。

群聊每轮末尾固定是 `group_relay`（`ds-bot/src/host/prompt.js:61` 要求），所以群聊基本每轮中招；单聊只要末尾挂工具调用，同样中招。

排除项：

- 不是我们的 slot 覆盖：`index.js:1141` 只换 cell 内容，座位与顺序由宿主 L4579-4595 决定。
- 不是 `styles.js:1096/1102` 的 `[data-bt-emptied]` 规则：全仓没有代码写这个属性，规则空转。
- 不是上游 #1489（80a05fd1）：那改的是 `activity-row.js` 的活动行挂载点与两条 margin 规则，与 assistant 落座无关。

## 边界

- 生效范围：**全局**（群聊与单聊一起），不做 `roomsById` 分支。
- 只改 `ds-bot/src/client/cells.js` 的 `AssistantCell`，不碰宿主文件、不移植 #1489。

## 怎么做

宿主已经把 `turnProcess`（`spec`、`foldable`、`hasContent`、`open`、`setOpen`）交给 cell（`client.js:4557` 组装 owner、L4523 形状）。现状 `AssistantCell` 只用了 `foldable`/`open`，`spec` 没碰。

新增判定：

1. `answerless`：`turnProcess?.spec?.answerStep === null`，即宿主判不出答案的那一轮。
2. 选定展示答案 `answer`：本轮所有 step（`useTurnSteps(turn)` 返回按 `anchorSeq` 排序的 `node.data`）里，**从后往前第一个**「有非空 text 且没有 tool-call」的 step。
   - 规则写死：取最后一条「纯文字且无工具调用」的 step；都不满足就不显示答案（本轮没有可当回答的文字）。
3. 当 `node.data === answer` 时：文字气泡不受 `folded` 影响照常渲染，并补一条 `SpeakerHead`（与宿主「独立成行」的显示一致）。

其余 step 维持现状（连同工具一起收在流程块里），不改变已有布局。

### 归属核对（回答「截图里那段文字是不是 AssistantCell 画的」）

宿主渲染链（DSH 0.2.2-rc.1 `client.js`）：

1. 群座位 `ChatGroupSeat`（L4924）把成员交给 `GroupMembers`（L4818），后者对每个成员 `createElement(ChatNodeSeat, ...)`；流程块本身是宿主组件，插件碰不到。
2. `ChatNodeSeat` 按 `routedNode.kind` 分发：L4593 `renderSlot("conversation.chat.node", routedOwner, { entryKey: routedNode.kind })`；座位 div 的 `data-chat-flow-kind` 即 `routedNode.kind`（L4589），`data-turn-process-member` 是 L4514 的 `processMember`（L4591）。
3. 我们只为 `assistant-step`、`turn-trigger` 等 key 注册了 cell（`ds-bot/src/client/index.js:1141-1160`），`AssistantCell` 是覆盖 `assistant-step` 的唯一 cell。
4. 群会话自身的 relay turn 不含文字：实测 `session-66305a95` 全部 6221 个 turn，含文字的 assistant 消息 0 条（都是 `tool(group_relay)` 加空消息）。

因此流程块里 `data-chat-flow-kind="assistant-step"` 的座位内容必然由 `AssistantCell` 画，改它打得中用户看到的那段文字。

## 验收标准

1. `npm test`、`node scripts/build-client.mjs --check`、`npm run lint` 三项全绿，数字写进 PR。
2. 新增单测覆盖：answerless 轮次里，最后一条纯文字 step 单独成行；纯工具 step 不单独成行；有答案的轮次行为不变。
3. 会话日志复测：以本机 `D:\LinkBot\data\sessions` 的真实日志跑出「改前/改后」被收进流程块并带文字的轮次数量对比。
4. 改前/改后真实 GUI 截图各一张。
5. 生效方式写清楚（重建 `client.js` 后刷新页面即可，不需要重启进程）。

## 未定问题

- `data-bt-emptied` 空转规则是否删除：留待与本次分开决定，避免夹带。
