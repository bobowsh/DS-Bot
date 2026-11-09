# #19 的调研结论：宿主用量 pill 在 Bot 界面为什么不出现

Refs #19

## 结论先说

**`18395123`（删除我们自绘的 usage-line）确实造成了一处功能消失，但原因不是「Bot 会话拿不到投影」。**

宿主自己的统计 pill 在 Bot 界面**同样不出现**，而且原因与「Bot 会话」无关——**它需要会话真的跑过一轮模型、宿主据此攒出 `tokenUsage` 投影**。我在隔离副本里实测：Bot 的会话是**没有历史记录的空白会话**（复制过来的 `state.json` 里每个 Bot 的 `model`/`appliedModel` 都是 `undefined`），所以它从来没有一轮真实运行，投影自然是空的，宿主的 pill 按自己的条件（`if (usage === void 0 || billedInputTokens(usage) === 0 && usage.outputTokens === 0) return null`）返回 null。

**所以 issue 表格里的第三行不成立**：不是「宿主根本没出来」这个独立现象，而是「宿主的数据源在没跑过的会话里本来就没有」。

## 三样证据

### 一、宿主 pill 的真实选择器

不是 `data-composer-stat` 一个属性的巧合——宿主有两处都写这个属性，覆盖了 pill 的两种形态：

`@deepseek-ai/dsh-client-ui-chat/lib/client.js`：

- 第 9578 行 `PlainPill`：`"data-composer-stat": stat`
- 第 9603 行 `DialogPill`：`"data-composer-stat": stat`

两处都是 `span` 上的**属性选择器**，宿主自己的组件就这么写的。`stat` 的取值是 `"activity"`（`ActivityPill`）和 `"usage"`（`UsagePill`）。

### 二、宿主把 pill 挂在哪个槽位

`dsh-client-ui-chat/lib/client.js` 第 15561-15576 行：

```js
ctx.slots.inject("conversation.composer.dock", function* () {
  yield ctx.slots.register({ name: "conversation.composer.dock", id: "activity", order: 0, ... }, ActivityPill);
  yield ctx.slots.register({ name: "conversation.composer.dock", id: "usage",    order: 1, ... }, UsagePill);
});
```

**`conversation.composer.dock`——正是我们的 `btw` 用的同一个槽位**（`index.js` 第 1128 行，`id: 'btw', order: 2`）。顺序：宿主 activity(0)、usage(1)、我们 btw(2)。**我们没有挤掉它们**，只是排在后面。

`dsh-client-ui-conversation/lib/client.js` 第 22216-22223 行，宿主自己的 dock 容器：

```jsx
<div className={InputBar_module_css_default.dock} "data-composer-dock": true>
  {variant === "composer" && input !== void 0 && sessionId !== void 0
    ? renderSlot("conversation.composer.dock", {})
    : null}
  {activity ? null : <ContextMeter useProjection={useProjection} t={t} />}
</div>
```

`renderSlot` 渲染该槽位的**全部占用者**——所以宿主的 pill 与我们的 `btw` 是**并存**关系，不是替换。

### 三、投影为什么拿不到

**宿主 pill 的渲染条件**（`dsh-client-ui-chat/lib/client.js`）：

```js
// UsagePill，第 9690-9693 行
const usage = useProjection("tokenUsage");
if (usage === void 0 || billedInputTokens(usage) === 0 && usage.outputTokens === 0) return null;

// ActivityPill，第 9652-9662 行
const stats = useSessionStats(useChat, useProjection);   // useProjection("sessionStats")
if (stats.steps === 0) return null;

// ContextMeter（dsh-client-ui-conversation，第 21525-21526 行）
const pressure = useProjection("contextPressure");
if (context === null) return null;
```

**投影是按会话事件累积的**（`dsh-token-meter/lib/index.js` 第 394-427 行）：

```js
const tokenUsageProjectionDefinition = {
  key: "tokenUsage",
  apply: (state, event) => {
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return state;
    const sample = usageOf(event);
    ...
  },
}
```

**没有任何「这是不是 Bot 会话」的判断**——投影对所有会话一视同仁。Bot 的会话就是 DSH 根 Session（`ds-bot/src/host/agents.js`：`await ctx.sessionController.create({ workspaceId: target })`），和普通会话没区别。

**所以「Bot 会话拿不到投影」这个假设是错的。真正的原因是：那个会话从来没跑过一轮模型。**

## 实测证据

隔离副本（`D:\dsbot-work\probe-classic`），Bot 界面，打开小队长的聊天：

```
hostStatCount: 0        ← 宿主的 pill 一颗都没有
ourPillCount: 6         ← 但这 6 颗全是「小队长记忆已更新」的记忆提示（bt-pill-*），不是用量行
dockChildren: []        ← composer dock 是空的
```

**我们的 6 个 `bt-pill` 全部是记忆提示**（`bt-pill-mem`、`bt-pill-mem-in`、`bt-pill-mem-ico`），不是用量。**用量行确实一颗都没有——既没有我们的，也没有宿主的。**

副本里的 Bot 状态（`data/bot/state.json`）：

```
小队长 model= undefined applied= undefined
```

**没有模型 → 从来没跑过一轮 → 没有 `tokenUsage` 投影 → 宿主的 pill 按自己的条件返回 null。**

我也试过让它真跑一轮：给副本的 profile 加了指向 mock 模型的 provider（`llm-deepseek-api-key` + `baseURL: http://127.0.0.1:9401/v1`），并给 Bot 选了 `deepseek-official/deepseek-v4.1-flash`。**mock 一个请求都没收到**——发送没有走到模型那一层（探针的 Enter 在这个输入框里没提交成功）。所以「跑一轮后宿主 pill 是否出现」这一条**我没能实测**，标为未验证。

## 三种结果的判定

| issue 里的行 | 判定 |
|---|---|
| 宿主出来了、数字对 | 不成立（副本里没跑过，宿主按自己的条件不画） |
| 宿主出来了但数字不对/缺 | 未验证（需要真实跑一轮） |
| 宿主根本没出来 → 保留我们的、挪到 `composer.dock` | **不成立**——「没出来」在这里是数据缺失，不是槽位或遮蔽问题 |

## 那 #19 到底要不要改

**用户报的现象是真的**（2026-11-08：「用量行位置不对，要求像宿主一样放到输入框下面」）。但根因是：

1. 我们自绘的那份（`usage-line.js`）**本来就抄错了位置**——挂在 `conversation.input.dock`（输入框**上面**），宿主在 `conversation.composer.dock`（输入框**下面**）。删掉它是往对的方向走的一半。
2. 但删掉之后**接不上**：宿主那份要真实运行过的会话才有数据，而**Bot 的会话恰恰是用户最常看的那些会话**——它们跑过模型，投影该有。

**所以缺的不是「我们的实现」，而是「宿主 pill 拿不到 Bot 会话的数据」。**

## 三条可能的路（都要先验，不能猜）

1. **宿主 pill 在 Bot 界面其实能出来，只是我的副本没有真实运行过的会话** → 那 #19 不用改代码，只需要**用真实会话实测**（用户的 `D:\LinkBot` 有真历史）。**这是最可能的情况**，也是必须先排除的。
2. **宿主 pill 因为某种原因在 Bot 界面拿不到投影** → 那要查 `useProjection` 的解析路径为什么对 Bot 会话失效。
3. **确实需要我们自绘** → 按 issue 的第三行做：挪到 `composer.dock`，并 shadow 掉宿主那两颗避免重复；上下文项的数据来源要查清，**拿不到就如实标 BLOCKED，不许编数**。

## 解除条件

**下一步只有一件事：在有真实历史的会话上实测宿主的 pill 出现没有。** 用用户的 `D:\LinkBot`（真数据、真模型）起一次，Bot 界面打开一个跑过的 Bot 的聊天，读 `data-composer-stat`。

- 出现了 → #19 用宿主那份即可，把 issue 关掉，正文写清「我们的那份已删、宿主那份接管、位置在输入框下方」。
- 没出现 → 走第 2 或第 3 条。

**在做完这一步之前，不动代码。**

## 附：一个必须记住的坑

`app/` 把 `ds-bot` 当 `file:` 依赖，`npm install` 时会**复制**一份进 `app/node_modules/ds-bot`。改完 `ds-bot/client.js` 直接改 asar 里的那份**是没用的**——桌面应用加载的是 `app/node_modules/ds-bot/client.js`。正确顺序：`ds-bot/` 改完 → `npm run build` → `npm ci`（或把 `ds-bot/` 同步进 `app/node_modules/ds-bot/`）→ 再打包。做隔离副本验证时同样适用。
