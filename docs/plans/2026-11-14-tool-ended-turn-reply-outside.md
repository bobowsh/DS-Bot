# 以工具调用收尾的轮次：回复要待在流程块外面（单聊侧）

Refs #43

- 日期：2026-11-14。本文是 #43 单聊侧的方案文档，接替本地分支上
  `2026-11-13-answerless-turn-reply-row.md`（68 行旧稿）的评审角色。
- 状态：**方案待审**，未拍板前不动代码。

## 一、现状（两半，群聊一半已解决）

#43 的现象是「以工具调用收尾的轮次，回复被收进『✨ 已调用工具』流程块」。它有两个受害面：

| 面 | 状态 | 依据 |
|---|---|---|
| 群聊侧 | **已解决** | PR #50/#52：群聊改用宿主按会话派发，成员回复由我们自绘的 `TeamToolView` 原生画在工具座位里，不再被卷进流程块。PR #52 的 CDP 实测：`bubbles: 2`、无折叠标题、正文平铺 |
| 单聊侧 | **未解决** | 本轮主题。宿主判定不变，单聊以工具调用收尾的轮次，回复仍整轮折进流程块 |

### 历史遗留：本地有一版旧实现（此前状态评论没提，此处纠正）

**本地分支 `fix/answerless-turn-reply-row` 上有一版 2026-11-13 的完整实现**（两个提交：
`e192e21f` 实现 + `7a01c26f` 补方案稿 issue 号），5 个文件 271 行新增：

| 文件 | 内容 |
|---|---|
| `docs/plans/2026-11-13-answerless-turn-reply-row.md` | 68 行方案稿（状态「已实现，待验收」） |
| `ds-bot/src/client/turn-reasoning.js` | `answerlessReply(steps, turnProcess)` 判定（+19 行） |
| `ds-bot/src/client/cells.js` | `AssistantCell` 用判定结果渲染独立气泡（+13/−1 行） |
| `ds-bot/client.js` | 生成物同步（+11 行） |
| `ds-bot/test/answerless-reply.test.js` | 161 行单测，覆盖三种情形 |

该分支基于旧 dev（`af765139`，PR #42 时代），**未推过远端、未进 dev**。此前给 #43 留的
状态评论写「`answerlessReply` 未实现、方案文档不在仓库」——口径不完整：说的是「不在
主线」，遗漏了这个本地分支的存在，特此纠正。

## 二、根因（宿主 `latestAnswer()` 判定，行号已在当前 harness 实测）

宿主 `@deepseek-ai/dsh-client-ui-chat/lib/client.js`（0.2.2-rc.1，15589 行）：

1. **L12841-12845 `latestAnswer(turn)`**：取本轮**最后一个 step**，必须
   `isFinalAssistant` 且有回复内容且**不含 tool-call**，才认作答案；否则返回 null。
   ```js
   const data = turn.steps.at(-1)?.data.get("assistant-step");
   if (!isFinalAssistant(data) || !hasAssistantReplyContent(data.blocks)) return null;
   return data.blocks.some((block) => block.kind === "tool-call") ? null : data;
   ```
2. **L12859-12860**：判不出答案时 `answerAnchorSeq: null`、`answerStep: null`。
3. **L4514 `processMember`**：`processSpec.answerAnchorSeq === null` 时，
   本轮**所有**步骤都划进流程块（无答案轮次的短路分支）。
4. **L4515 `processAnswer`**：要求 `routedNode.data.step === processSpec.answerStep`，
   `answerStep` 为 null 时恒 false——没有任何步骤单独成行。
5. **L4517 `foldable`**：流程块可折叠且默认收起，读者要展开才看得到回复。

复现（issue 正文实测）：单聊 `session-6d50cd68` 的轮次以 `tool(pwsh)` 收尾，同样中招；
群聊每轮末尾固定 `group_relay`（`ds-bot/src/host/prompt.js:61`），当年恒中招——但群聊侧
已按第一条路线解决，不再依赖宿主这个判定。

排除项（旧稿核实过，仍有效）：不是我们的 slot 覆盖（`index.js:1141` 只换 cell 内容，座位
与顺序由宿主 L4579-4595 决定）；不是 `styles.js` 的 `[data-bt-emptied]` 空转规则；不是上游
#1489/#1458（方向不同）。

## 三、怎么改（路线，留用户拍板）

| 路 | 做法 | 评估 |
|---|---|---|
| **a（推荐）** | **复活本地旧实现**：`AssistantCell` 在 `turnProcess.spec.answerStep === null` 时，取本轮最后一个「只有文字、没有 tool-call」的 step 画成流程块之外的独立气泡（`answerlessReply` 判定），其余步骤维持原样 | 代码、测试、方案稿 11-13 都在本地分支上；量最小；**前提是要对齐当前 dev**（旧分支落后约 30+ 个提交，PR #50/#52 动过群聊链路，见开放问题 1） |
| b | 等宿主上游修 `latestAnswer()` 判定 | 干净但被动：上游 0.2.2-rc.3 都还没动这块（npm 实测无相关改动），等不起 |
| c | 改我们单聊的轮次结构，避免以工具收尾 | 不可行：是否以工具收尾由 agent loop 决定，不是我们能约定的 |

推荐 **a**：与 PR #50/#52 群聊侧同思路——不动宿主，插件层自绘补位；判定与气泡在
`ds-bot/src/client/` 里，宿主升级不漂移。

## 四、边界

- 只改 `ds-bot/src/client/cells.js`、`ds-bot/src/client/turn-reasoning.js`（复活）与
  `ds-bot/test/answerless-reply.test.js`；`client.js` 生成物 build 一起提交。
- **不碰宿主文件**，不移植上游 #1489/#1458。
- 判定只在 `answerStep === null` 的轮次生效；有答案的轮次（多数）走宿主原路径，
  行为一字不变。
- 语义取舍（旧实现已定）：无答案轮次取**最后一个**纯文字 step 当回复；多段纯文字时
  只显示最后一段（与宿主「答案=最后一个 step」的语义对齐）。

## 五、验收标准

1. 单聊以工具调用收尾的轮次：回复文字以独立气泡显示在流程块外（测试 +
   真实 GUI 截图，改前/改后各一张）。
2. 有答案的轮次行为不变（宿主原路径，回归测试）。
3. **群聊不回归**：复跑 PR #52 的 CDP 判据（`turnStatusRows: 0`、`bubbles: 2`、
   无折叠标题），确认复活的自绘判定没有在群聊画出重复气泡。
4. 门禁三项（`npm test`、`node scripts/build-client.mjs --check`、`npm run lint`）
   与基线对比不新增失败；`answerless-reply.test.js`（161 行）复活并全绿。
5. 会话日志复测：以本机真实日志对比「改前/改后」被收进流程块并带文字的轮次数量。

## 六、开放问题（留给用户拍板）

1. **群聊交互重验**：旧实现写于 PR #50/#52 之前、判定是全局的（群聊单聊一起生效）。
   现在群聊侧已由 `TeamToolView` 接管，复活时 `answerlessReply` 在群聊会不会画出
   双份气泡，需要先跑 PR #52 的 CDP 判据验证；若冲突，判定加会话分支（单聊才自绘）。
2. 修复顺序：本方案 vs #53 编码 writeBytes（拍板在前者先做后者，或反之）。
3. 「多段纯文字只显示最后一段」的语义是否合预期（旧实现的选择，可在复活时一并调整）。

## 七、落地步骤（拍板后）

1. 从当前 dev 拉分支，把 `fix/answerless-turn-reply-row` 的实现搬过来（或
   merge 该本地分支后对齐 dev 解冲突）。
2. 先跑群聊 CDP 判据确认不回归（开放问题 1），再动判定逻辑。
3. 复活 `answerless-reply.test.js`，跑门禁三项。
4. PR（base `dev`），正文 `Fixes #43`，附本方案链接与真实证据。
