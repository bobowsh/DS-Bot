# 群聊里的 ask_user 提问卡片

Refs #11

## 要解决什么

`ask_user` 在群聊里被硬拦：`ds-bot/src/host/tools.js` 里凡是执行会话属于某个群（`rt.groupOwners.has(id)`），工具就直接返回一句「Question cards only work in your own chat」。管理员想在群里问用户一个二选一，只能退化成纯文本列选项，用户得把答案手打一遍。

要的是：**卡片画在用户正在读的那个群聊里**，点选项后答案回到提问的那个 Bot，同时**这次回答算作用户在群里说话**，把群发言队列推着走（暂停计数归零、下一位说话的人继续）。

## 现在的机制（读代码读出来的，不是猜的）

- 卡片存在 `state.questions[sessionId]`，键是**卡片所属的会话**。私聊里就是 Bot 自己聊天那个 Session。
- 客户端 `QuestionDock`（`ds-bot/src/client/questions.js`）按**当前渲染会话的 sessionId** 去 `roster.questions[sessionId]` 取卡片，画在输入框上方的 dock 里；`roster.questions` 就是 `state.questions` 原样透出（`channel.js` 的 `view()`）。
- 作答走 `answer-question` 端点 → `rt.answerQuestion(sessionId, questionId, answer)`（`channel.js`）→ 用 `agent.followup(createUserMessage(...))` 把答案投回那个 Session。
- 群里用户说话有两条路：
  1. 群自己的 Session（`room.sessionId`）收到一条 `kind: 'user'` 的消息 → `turns.js` 的 `queueRoomMessage(room.id, { text })` → 下一轮 `group_relay` 时作为「User」进群日志，并按 `@` 决定叫谁。
  2. 轮次正在跑时，`drainRoomInbox` 直接把用户消息吸进当前轮次（`round.userMessage = true`）。
- `openingCall`（`groups.js`）决定用户消息叫谁：`@Name` 叫到那个人；admin 模式没 `@` 叫 admin；everyone 模式没 `@` 叫全员。`mentionsOf` 会读 post 上的 `mentions.ids`。

## 设计

### 1. 卡片存在哪

群里的卡片存在**群自己的 Session**（`rt.sessionOfRoom(room)`）上，也就是用户正在读的那个会话：

```
state.questions[roomSessionId] = {
  id, question, detail, options, multiSelect, allowCustom, askedAt,
  roomId,          // 这个卡片属于哪个群
  askerSessionId,  // 提问那个 Bot 的群 Session（答案发给它）
  askerBotId,
}
```

为什么不用提问者的群 Session：

- 客户端 dock 是按当前会话取卡片的。群页当前会话就是群自己的 Session，卡片放这儿才能被现成的 `QuestionDock` 画出来，**客户端一行不用改**。
- 现有 `answer-question` / `dismiss-question` 端点的键也是当前会话，一致。

代价：一个群同时只有一张未答卡片。**这一版不做并发多张**（私聊现在也是一张），文档里写明。

### 2. 工具侧（`tools.js`）

`ask_user` 遇到群成员会话时：

- 找到它所在的群；群里已有未答卡片 → 拒绝（提示先等答案）。
- 写卡片到群 Session，`callId` **不设**：卡片的调用行在成员的隐藏 Session 里，用户看不见；不设 callId 才会走 dock 渲染。
- `rt.roomStepText(...)` 在群里说一句「我在等用户回答」，让群里的人和别的成员知道有个卡片等着。
- `exec.concludeTurn?.()` 结束这一轮（和私聊一致：这个工具本来就是结束回合的）。

私聊路径一行不改。

### 3. 作答（`channel.js` + `groups.js`）

`rt.answerQuestion` 里分叉：卡片带 `roomId` → 走新的 `rt.answerRoomQuestion`。

它做的事：

1. 校验选项合法（沿用 `questionReply` 的取法：只认卡片里的选项，multiSelect 保留多项）。
2. 删掉卡片（先删，失败再放回去，和私聊一致，防止重复作答）。
3. 把答案作为**一条用户消息**投给**群自己的 Session**：

```
@[提问者名字] the user answered your question "…": 选项, 选项
```

用 `kind: 'user'` 的 source，走 `turns.js` 里那条现成的路：`queueRoomMessage` → 群里出现一条 User 行 → `openingCall` 读到 `@提问者` → **只叫提问者**，新一轮由它接手。

这样一次动作同时满足两件事：**答案回到提问的 Bot**（它被叫到了，读到那句原文），**群发言队列被推进**（用户消息进群，暂停计数归零，下一位说话的人继续）。

不再单独 `agent.followup` 到提问者的 Session——那会让它回答两遍（一次是被叫到的新一轮，一次是提前收到答案）。

### 4. 不做的事

- `show_view` 仍然拒绝在群里用（issue 只要求 ask_user）。
- 不做一张群多张并发卡片。
- 不改 `state.questions` 的结构语义（还是「按会话存一张卡」），只多了几个字段。

## 验收标准

1. 群成员调用 `ask_user` 不再被拒，卡片出现在群页输入框上方的 dock 里。
2. 点一个选项：群里出现一条 User 行，内容里带 `@提问者`；提问的 Bot 拿到新一轮并读到答案原文。
3. 提问者回答后，群里其它成员该被叫到还是被叫到（`@` 语义不变）。
4. 卡片在 unanswered 状态下被 dismiss：`dismiss-question` 清掉它。
5. 私聊路径的既有行为一条不变（`ds-bot/test/questions.test.js` 全过）。
6. 门禁三项全过：`node scripts/build-client.mjs --check`、`npm run lint`、`npm test`。

## 开放问题

- 一个群同时两个成员各问一张卡：现在第二个会被拒（提示先答完）。要不要做成多张，等真有人用到再说。
