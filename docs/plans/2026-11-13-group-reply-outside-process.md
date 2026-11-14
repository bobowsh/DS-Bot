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

### 5. 工具区：宿主按会话派发（2026-11-14 定案，最终形态）

**不占位 `tool-call` 座位。** 宿主树（`ToolCallTree`）继续画每个调用并按工具名派发到 `tool.call.toolview` 子槽；团队只在这个**宿主已声明的子槽**里注册团队自己的工具，其余工具落到宿主自己的视图。

- 单聊：普通工具由宿主原生视图（`BashRow` / `ReadRow` / `GenericToolCard` 等 60+ 个）画出，观感与宿主会话一致，**零复制、零署名、宿主升级自动跟随**。
- 群聊：只画团队工具、成员回复与「正在输入」提示，无任何工具明细。

**为什么不能声明 `children` 拿 `renderSlot`**：宿主 slots core（`@deepseek-ai/dsh-client-ui-slots`）的 `register()` 规定，声明 `children` 时若子槽已被声明就抛错：

```js
if (options.children) for (const childKey of Object.keys(options.children)) {
  if (childRec?.spec) throw new Error(`slot "${childKey}" is already declared ...`)
}
```

`tool.call.toolview` 已由宿主的 tool-call 座位声明 → 我们声明就抛错 → 整组注册失败 → 宿主座位接管 → 群聊出现它的通用卡片。这条是 CDP 实测撞出来的。

**为什么之前评估说「宿主树不可用」是错的**：那 60+ 工具视图是**各自独立的 `ctx.slots.inject`**，与谁占位 tool-call 无关。我们丢的不是视图，是「派发者」。

## 最终口径（用户逐项点名，2026-11-14）

| 群视图里的东西 | 处理 |
|---|---|
| 工具流程块「已调用工具」折叠标题 | **隐藏**（上游写法：藏标题行） |
| 普通工具明细（工具名、参数、输出） | **不画** |
| 宿主给团队工具画的通用卡片 | **不画**（团队工具走团队自己的视图） |
| 轮次状态行「已完成，用时 N 秒」 | 画 |
| 成员名、角色（管理员等） | 保留 |
| 消息时间 | 保留 |
| 成员气泡 | 保留，**原地画在工具座位里** |
| 「正在输入」提示 | 保留，**原地画在工具座位里，在气泡之前** |
| 事件行（paused / admin-passed 等） | 保留 |
| 错误提示行 | 保留 |
| 卡片（ask_user / show_view） | 保留（团队自己的视图画它） |

## 单视图口径（2026-11-14 回归修复）

用户实测发现「单聊只剩思考过程，工具调用过程没有了」——那是自绘方案把普通工具在**单聊也**过滤掉了。现在：

- 单聊：普通工具由**宿主原生视图**画出，工具名 / 命令 / 状态 / 耗时、展开有参数与结果，与宿主会话一致。
- 群聊：普通工具不画。
- 团队工具：两边都画团队自己的卡片。

## 轮次状态行（2026-11-14 补回）

形态2 下我们占位了 `turn-process` 座位，宿主那个座位原本画的「已完成，用时 3 秒」就没人画了——群里只剩对话，**轮次级的提示也一起丢了**。

那行只说这一轮花了多久，**不含任何工具明细**，所以它该留着。现在由我们的 `TurnProcessCell` 自己画，文案与宿主对齐（「已完成，用时 2 秒」「已完成」「处理失败」「已停止」），视觉也照宿主的做法：弱化灰字、居中。

## 边界

- 只改 `ds-bot/src/client/`，不动宿主。
- **群视图**：普通工具明细不画；单视图：普通工具由宿主原生视图画出（与宿主会话一致）。
- 保留：成员名、角色、时间、回复顺序、多条回复；空结果不画空白气泡。

## 验收标准

1. 群聊页面里没有「已调用工具」折叠标题、没有工具名/参数/输出明细，也没有宿主给团队工具画的通用卡片。
2. 成员回复气泡原地显示在群里，一条不少、不重复、不消失，成员名/时间/顺序正确。
3. 「正在输入」提示出现在成员气泡**之前**；回复到达后提示消失、只留气泡，不叠加。
4. 事件行与错误提示行照旧显示。
5. **单聊里普通工具调用过程照旧显示**，由宿主原生视图绘制（工具名/命令/状态/耗时，展开有参数与结果）。
6. 门禁三项（`npm test` / `node scripts/build-client.mjs --check` / `npm run lint`）真实数字，与基线对比不新增失败。
7. 真实群聊 GUI 截图 + CDP DOM 数字，不用单聊代替。

## 已拍板决策与理由

- **工具区用宿主按会话派发，不自绘仿造**（用户 2026-11-14 原话：「这些在宿主的实现里都有，你去找到然后把代码搬过来即可」「还有条思路，现在是不是shadow了宿主的这个实现，在单聊里放开，在群聊里shadow行不行？」）。理由：宿主那 60+ 工具视图是各自独立注册的，我们丢的不是视图而是「派发者」；接上派发器后零复制、零署名、宿主升级自动跟随。
- **CSS 三条不按群视图限定**：与上游一致。
- **不改宿主**：全部在插件自己的 cell 与 CSS 里。
- **不声明 `children`**：宿主 slots core 规定子槽只能声明一次，重复声明会让整组注册失败（实测）。

## 未定 / 后续

- 上游的 `relayRange` / `groupRows` 群账本（0.3.3+ 的新东西）没引入；如果以后要「一轮回复的历史分页」，另开需求。
- 合并上游最新版本（本 issue 验收通过后由小队长另行派工）。

