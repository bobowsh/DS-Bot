# 聊天框里的过程可见与 token 速率（Issue #1）

- 日期：2026-11-06（设计稿）；2026-11-07 实现落地（范围 A–E）
- 相关：Issue #1（含 2026-11-06 追加的 token 速率要求，评论 id 6684670443）
- 状态：**已实现（范围 A–E）**。分支 `feat/issue-1-chat-process`，提交信息带 `Fixes #1`。群成员过程（范围 F）仍未做。

## 为什么

DS Bot 的聊天框只呈现 Bot 的最终回复，用户看不到它「到底做了什么」：思考没显示，普通工具调用（读文件、跑命令、联网）没显示，只有少数「团队工具」（`message_bot`、`group_relay`、`ask_user` 等）画成了一行事件。DSH 原生聊天界面有完整的轨迹视图（`@deepseek-ai/dsh-client-ui-trajectory`），按轮次列出思考、工具调用、参数、输出、token 与耗时。团队协作里「过程可见」是能被监督的前提，所以这条能力要补齐，并且要按 issue 评论的口径补上 token 速率。

调查的结论先说：**宿主侧的数据已经在 DS Bot 手里了，插件没有吞掉任何事件**。缺的是渲染层——DS Bot 自己接管了 `conversation.chat.node` 的 `assistant-step` / `tool-call` 两个 cell（`ds-bot/src/client/index.js:907-910`），但在 `ToolCell` 里把工具调用按一张白名单（`DRAWN`，`ds-bot/src/client/cells.js:1019`）过滤掉了，思考过程则被「显示思考过程」偏好（`prefs.thinking`）挡在后面。

## 数据从哪来

### 1. 宿主聊天视图（不需要新数据通道）

DS Bot 已经能拿到 DSH 聊天目标的完整快照：

```js
const chat = ctx.uiConversation.binding(binding).target('chat').getSnapshot()
```

快照里 `chat.nodes` 是 `ChatNodeStore`，`chat.nodes.turnDataSource(turn, kind)` 能按「一轮 + 一类节点」订阅一个有序数组（`ds-bot/src/client/index.js:694-706` 已经在用这个接口取 `assistant-step` 和 `context`）。可用的节点类型和它们带的字段：

| 节点 kind | 数据 | 能拿到什么 |
|---|---|---|
| `assistant-step` | `AssistantChatData` | `status`（running/settled/interrupted）、`turn`、`step`、`blocks`（`text` / `reasoning` / `tool-call`）、`time`、`usage`、`finalNode` |
| `tool-call` | `ToolChatData` | `root: ToolCallBlock`，含 `name`、`argsRaw`/`args`、`phase`（preparing/start）、`time`、`callId`、`subCalls`；settled 后是 `kind:'tool-result'`，含 `content`、`isError`、`error`、`callTime` |
| `turn-process` | `TurnProcessChatData` | `messageCount`、`toolCallCount`、`subagentCount`、回答锚点 |
| `turn-tail` | `TurnTailChatData` | `tokenUsage`（`TurnTokenUsage`：未缓存输入 / 缓存读 / 缓存写 / 输出 / 推理 / 合计），以及 `closing.finalNode` |

`finalNode` 是 `AssistantMessageNode`，带 `usage`（`TokenUsage`：`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens`）和 `timing`（`stepStartTime` / `firstTokenTime` / `completedTime`）。这正是 DSH 自己的统计口径所依赖的字段（`dsh-client-ui-chat/lib/client.js:7363` 的 `assistantStepReading`、`:7494` 的 `decodeSpeed`）。

### 2. 运行时「当前步骤」

同一快照的 `chat.legacy.runningCalls` 列出仍在执行中的工具调用（`RunningToolCall`，带 `name`、`argsRaw`、`time`）；`chat.legacy.partial` 是正在流式输出的助手内容。DSH 自己的「正在调用哪个工具」也是这么来的。

### 3. 历史会话

这些节点都是 DSH 聊天构建器**从会话事件重建**的（`assistant/message` 事件带 `usage` 与 `stream`，`tool/call` / `tool/result` 事件带参数与结果）。所以重新打开历史会话时，同样的节点数据还在，过程可展开。DS Bot 的「更早的段」（handoff 分段，`parts`）不是 DSH 会话而是 DS Bot 自己拼的历史页（host 端点 `earlier`），那部分**没有**上述节点数据，是已知缺口（见「不做什么」）。

### 4. 群聊里的成员过程

群聊里每个成员在自己的隐藏 Session 里跑（`rt.sessionOfRoom(room)` 只是群的公共会话，成员的工作发生在各自 Session，见 `ds-bot/src/host/groups.js:1223`）。因此：

- **Bot 私聊**：过程数据齐全，宿主节点直接可用。
- **群聊**：公共会话里只有群消息本身，**成员的思考与工具调用不在群里**。要显示成员过程，只能由 host 侧按成员 Session 读事件（`rt.eventsBackwards`）再单独送一份给前端。

结论：先做私聊 + 群聊中「本 Bot 自己」的过程；群成员的过程需要 host 侧新数据通道，列为第二阶段（工作量见下）。

## 在哪一层注入

### 位置：DS Bot 自己的 cell 里，不新开面板

DS Bot 已经接管了这两个 cell：

- `conversation.chat.node` / key `assistant-step` → `AssistantCell`（`ds-bot/src/client/cells.js:252`）
- `conversation.chat.node` / key `tool-call` → `ToolCell`（`ds-bot/src/client/cells.js:1132`）

改动就在这两个 cell 内，不动 DSH 的渲染器，也不另开 tab：

1. **思考过程**：`AssistantCell` 现在的推理来自 `turnReasoning(steps, data)`（`ds-bot/src/client/turn-reasoning.js`），且被 `thinkingShown(roster.prefs)` 门控。设计改为：过程折叠区**总是**显示摘要行（步数、工具数、耗时），展开后显示思考全文——「显示思考过程」偏好只影响**思考全文是否默认展开**，不再决定过程区是否出现。这样「思考过程可见」是默认行为，与 issue 期望一致。
2. **工具调用**：`ToolCell` 去掉 `DRAWN` 白名单对**普通工具**的过滤，改为每条工具调用画一行（工具名 + 状态 + 耗时），展开看 `argsRaw` 与结果 `content` / `isError` / `error`。现有 `DRAWN` 里的团队工具**保持现状**（它们有自己的事件行样式），只是额外补上「可展开看参数与输出」。
3. **折叠交互**：DS Bot 已有一个折叠实现 `ds-bot/src/client/fold.js` 和 `ThinkingRow`；复用它做「过程折叠区」，默认折叠，展开状态按 `sessionId:turn` 记忆（`localStorage`），重开历史会话仍能展开。
4. **流式实时状态**：折叠区标题行显示「正在调用 X」或「正在思考」，数据来自 `chat.legacy.runningCalls` / `partial`（宿主已经实时发布）。DS Bot 现有 `useLiveNote`（`cells.js`）就是走这条路的，扩展它即可。

### 数据订阅方式

沿用现有的 keyed hooks 模式：`assistantFace`（`ds-bot/src/client/index.js:691-707`）已经按 session 绑定了 `turnSteps` / `turnContext` 两个 keyed hook。设计新增：

- `turnTools(turn)` → `snapshot.nodes.turnDataSource(turn, 'tool-call')`
- `turnTail(turn)` → `snapshot.nodes.turnDataSource(turn, 'turn-tail')`
- `chatSnapshot` 订阅 → 拿 `legacy.runningCalls` / `legacy.partial`

新增订阅要确认 `turnDataSource` 在同一 turn 上被多个 cell 订阅时是否共享同一条源（`dsh-client-ui-chat/README.md:80` 说「只有被订阅的集合才生成有序数组」，同一 kind 的订阅应共享）。**这一条要在实现第一步用测试验证**，若不共享则改为在 `assistantFace` 里一次性取全量并在本地按 turn 过滤。

## token 速率怎么算

### 口径（按 issue 评论第 2 条要求写明）

显示为 **输出速率**：`输出 token ÷ 解码时长`，其中

- 输出 token = 该轮各助手步 `finalNode.usage.outputTokens` 之和（provider 上报的确切值，不另起计数）
- 解码时长 = Σ(`finalNode.timing.completedTime` − `finalNode.timing.firstTokenTime`)，即从首个 token 到该步结束

这与 DSH 自己完全一致：`dsh-client-ui-chat` 的 `decodeSpeed` = `decodeTokens / (decodeMs/1000)`（`lib/client.js:7494`），`dsh-client-ui-trajectory` 的 `throughput` = `outputTokens / ((completedTime − firstTokenTime)/1000)`（`lib/client.js:3666-3673`）。两者都是**输出口径**，不含输入。

界面上必须写明口径，样式与 DSH 一致：`{tps} tok/s`，并在旁边标注「输出」二字（DSH 自己的 `stats.dialog.speed` 标题是「输出速度（TPS）」）。同时给出本回合的 token 统计：输入（未缓存 + 缓存读 + 缓存写）、输出、合计，来源 `turn-tail` 的 `tokenUsage`，与 DSH 的 `TurnUsagePanel` 字段一一对应。

### 流式过程中的实时速率：分两种情况

1. **provider 增量上报 usage**：流式过程中 `usage` chunk 已经到达，则用当前累计输出 token ÷ (now − firstTokenTime) 实时更新。
2. **provider 只在结束时上报 usage**（DeepSeek 官方 API 的常见情形）：**流式过程中速率显示「不可用」**，而不是 0 或留空。理由是此时唯一能算的只有「文本长度 ÷ 时间」，那是另一套计数，issue 评论明确要求「不要另起一套计数」。回合结束、usage 到达后，速率按上面的确切口径定格为最终值。

这条同时满足 issue 的「provider 不可用显示『不可用』而非 0」和「回合结束后数值定格」。

### 计时来源

`firstTokenTime` 与 `completedTime` 来自 `finalNode.timing`，是 DSH 从事件序列里推导的（`step/start` 的时间、`assistant/live-chunk` 首个 token delta 的时间、`assistant/message` 的时间）。DS Bot **不自己计时**，也不复用现有的 `thinking` 端点（`ds-bot/src/host/thinking.js`，它算的是纯推理时长，与输出速率不是一回事）。

### 「不可用」的判定

- 该轮没有任何助手步产生过 token → 显示「不可用」
- provider 未上报 `usage.outputTokens` → 显示「不可用」
- 解码时长 ≤ 0（首 token 与结束同一毫秒）→ 显示「不可用」
- 上述任一情况都不显示 0，不显示空白

## 对齐轨迹视图的地方

对齐的部分（目标形态一致，不追求像素一致）：

| 轨迹视图 | 本设计 |
|---|---|
| 按轮次分组，折叠在回复上方 | 同：折叠区挂在该轮回复上方，默认折叠 |
| 展开看工具名、参数、输出 | 同 |
| 每步的耗时与成功/失败状态 | 同（用 `root.time` 与 `callTime` 差、`isError`） |
| 搜索、虚拟化 | **不做**：DS Bot 聊天框里的过程折叠区是就地展开，不做独立表格，也不需要虚拟化（一个 turn 的步骤数在几十量级） |
| 时间线泳道图 | **不做** |
| 用量面板（本次请求 / 会话累计） | 做本回合统计（`turn-tail` 的 `tokenUsage`），会话累计仍在设置页的 Usage 页 |
| 输出速度 | 做，输出口径，写明 |

不一致之处及理由：轨迹视图是**独立视图**（`conversation.view` / id `trajectory`，`dsh-client-ui-trajectory/lib/client.js:8205`），面向一次会话的全部事件；DS Bot 的聊天框里，Bot 的回复与过程是同一段流水的两半，做成独立视图会割裂「回复—过程」的对应关系，也与 issue「折叠显示在回复上方」的期望不符。因此采用**就地折叠**而非独立视图。

## 工作量评估

以「私聊 + 群聊中本 Bot 自己的过程 + token 速率」为范围。

| 项 | 内容 | 估算 |
|---|---|---|
| A. 折叠区骨架 | 新建 `ds-bot/src/client/process.js`：折叠标题行（步数 / 工具数 / 耗时 / 速率）、展开体、折叠状态持久化；复用 `fold.js` 与 `ThinkingRow` 样式 | 1.5 人日 |
| B. 思考过程接入 | `AssistantCell` 的推理不再被偏好完全门控；改成「摘要行常显、正文按偏好默认展开」；`turn-reasoning.js` 补多步合并 | 0.5 人日 |
| C. 工具调用接入 | `ToolCell` 去掉白名单过滤，普通工具每条一行 + 可展开参数与输出；团队工具保持原样并补可展开 | 1.5 人日 |
| D. token 速率与用量 | 从 `finalNode.usage/timing` 算输出速率；从 `turn-tail.tokenUsage` 取本轮 token 统计；「不可用」分支；口径标注 | 1 人日 |
| E. 流式实时状态 | 用 `legacy.runningCalls` / `partial` 显示「正在调用 X」；增量 usage 到达时速率实时刷新 | 0.5 人日 |
| F. 群成员过程（第二阶段） | host 侧按成员 Session 读事件、裁剪成过程摘要、随群视图下发 | 2–3 人日（需新增 host 端点与数据结构） |
| G. 测试与文档 | 单元测试（速率口径、不可用分支、折叠状态、参数/输出展开）；`npm test` / `--check` / `lint`；本设计文档与 `docs/plans/README.md` 目录补一行 | 1 人日 |

范围 A–E 合计约 5 人日；加上 F 约 7–8 人日。实现必须在 v0.3.0 底座升级（DSH 0.2.1-rc.5 → 0.2.2-rc.1）落定后开始：升级会换掉 `dsh-client-ui-chat` / `dsh-client-ui-conversation` / `dsh-client-ui-trajectory` 的版本，本设计依赖的字段（`finalNode.timing`、`usage`、`turnDataSource`、`legacy.runningCalls`）都在这些包里，**升级后必须逐条复核这些字段是否仍然存在、形状是否改变**。

## 风险

1. **底座升级改字段**（最大风险）。`turnDataSource` 的 kind 列表、`AssistantChatData.finalNode`、`TurnTokenUsage` 都是 0.2.1-rc.5 的形状。升级后第一件事是核对；若有变化，设计文档同步更新再动手。
2. **`turnDataSource` 多订阅是否共享源**。若每个 cell 各自订阅会重复物化数组，长会话可能变慢。需要在实现第一步用测试确认（见「数据订阅方式」）。
3. **长会话性能**。折叠区在 DOM 里始终存在（只是内容不展开），大量历史 turn 会累积折叠标题行。缓解：折叠区只在展开时挂载正文；标题行用与现有 `ThinkingRow` 同样的节流更新。
4. **思考全文的体量**。一次 turn 的推理可能很长。折叠区默认折叠、展开时按需渲染；必要时对推理正文限长并给「展开全部」。
5. **白名单工具的样式冲突**。团队工具已有专门事件行（如 `Messaged`、`Posted in`），新增的通用折叠行可能与之重复。设计：团队工具**只**在折叠区里出现通用行，主行仍用原样式，不重复画。
6. **群成员过程（F 阶段）会碰到隐私边界**。一个 Bot 的思考与工具调用是否该让群里其他 Bot 看见，与「私有 Bot」设计（`docs/plans/2026-10-27-private-bots.md`）可能冲突。F 阶段开工前需要先定这条规则。

## 不做什么

- 不做独立的过程视图 / 侧栏 tab（过程折叠在回复旁）。
- 不做轨迹视图的搜索与虚拟化。
- 不做时间线泳道图。
- 不做输入口径的速率（输入 token 在请求发出时就已知，除以时长没有意义），界面只显示输出速率并写明。
- 不用文本长度估算 token 来伪造流式速率（见「流式过程中的实时速率」）。
- 不改 DSH 的任何包；全部在 DS Bot 插件内实现。
- 不动 DS Bot 的「更早的段」历史页（handoff 分段无节点数据）。

## 已知限制

- 群成员的执行过程不在群里（第二阶段 F）。
- DS Bot 自己拼接的「更早的段」历史里没有过程数据。
- provider 不在流式过程中上报 usage 时，速率在生成中显示「不可用」。
- 速率是**输出口径**；输入侧只有 token 计数，没有速率。

## 变更

- 2026-11-06：初稿。调研 DSH 聊天/轨迹视图的数据来源，确认宿主节点数据在插件侧可及；定下「就地折叠 + 输出口径速率 + 不可用显式标注」三条口径；估工 5 人日（范围 A–E），群成员过程另列第二阶段。
- 2026-11-07：实现范围 A–E 落地，底座 0.2.2-rc.1 复核通过（五个依赖字段形状都没变）。实现与初稿有三处不同，以实现为准：
  1. **过程折叠区只放工具与数字，思考仍走原来的「显示思考过程」开关。** 2026-10-23 的决定记录写明「思考过程默认不显示，设置里可打开」，那是已定的设计，动它要维护者点头。折叠区因此不重复画思考。
  2. **工具行有两处**：团队工具（`message_bot`、`ask_user` 等）仍按原样画成事件行或卡片；普通工具（读文件、跑命令、联网）新增一行折叠的行，展开看参数与输出。折叠区里只列**普通工具**，所以没有工具被画两遍。
  3. **折叠状态存在浏览器本地**（`ds-bot:process:<session>:<turn>`），关掉再打开仍是原来那样；没有状态存储服务可借。
