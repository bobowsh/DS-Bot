# 在 Bot 输入区右上角显示当前工作区的 git 分支名

## 要解决什么

用户要求：**在 Bot 输入区右上角显示当前工作区的 git 分支名。**

现有的第三方插件 `@linxin666/dsh-client-ui-git-graph` 有分支 chip，但它只在**空白首屏的 hero 区**渲染。上游产物注释原文写着 `Active sessions intentionally expose no branch-selection control.`——DS Bot 里每个 Bot 的对话都是活跃会话，所以那个 chip 永远不出现。位置也不对：hero 区在对话区顶部，不是输入区。

所以要在 ds-bot 自己这边实现。

## 边界

**做什么**
- 在 Bot 单聊与群聊的输入卡右上角显示当前工作区的 git 分支名
- 只读，不可点击
- 分支从 `<workDir>/.git/HEAD` 直接读，不起 git 子进程
- 15 秒轮询 + 窗口 focus 时重查（分支可能在旁边的终端里被切走）

**不做什么**
- 不显示 commit、不显示 diff、不做分支切换
- 工作区不是 git 仓库时**什么都不显示**（多数聊天窗口不是 checkout，常驻提示是噪音）
- detached HEAD / unborn HEAD 也不显示（没有分支名可显示）

## 怎么做

### 宿主侧 `ds-bot/src/host/workspace-branch.js`

`branchOf(workDir)`：

- 读 `<workDir>/.git/HEAD`
- `.git` 是**目录**（普通克隆）→ 直接读 `HEAD`
- `.git` 是**文件**（worktree）→ 按 `gitdir: <path>` 指针跟过去再读
- `ref: refs/heads/x` → 返回 `x`
- detached HEAD（原始对象 id）→ `undefined`
- 非 git 树、路径为空、读不到 → `undefined`
- 超过 120 字符截断加省略号

`install(rt)` 挂 `rt.branchEndpoint`，endpoint 名 `branch`。

### 前端 `ds-bot/src/client/branch-chip.js`

- `BranchChip` 用 `useRoster` 取 `byId[sessionId].workDir`，取不到再取 `roomsById[sessionId].workDir`（单聊 / 群聊两条路）
- `call('branch', { path })` 拿分支
- 拿不到返回 `null`，不渲染空壳
- CSS 用绝对定位贴到 `[data-composer-card]` 的右上角，`pointer-events:none` 所以不挡任何点击

### 接线 3 处

- `ds-bot/index.js`：import + `MODULES` 加 `workspaceBranch`
- `ds-bot/src/host/channel.js`：`case 'branch'`
- `ds-bot/src/client/index.js`：注册 `conversation.input.right` 座位（`id: 'bot-branch', order: -100`）+ `SHELL_SHEETS` 加 `BRANCH_CSS`

### i18n

新 key `Workspace branch`（chip 的 tooltip），六种语言都补了：zh / ja / ko / es / fr / de。

## 已拍板的决策与理由

**1. 位置用 `conversation.input.right` 座位 + 绝对定位**
宿主的座位系统里没有「输入卡角落」这种位置；座位给的是行内占位，绝对定位才能把它提到卡片右上角而不推挤发送按钮。

**2. 不是 git 仓库就不显示**
用户没有明确要求常驻。多数会话不是 checkout，一个空 chip 或「无分支」提示是噪音。

**3. 颜色只用 `--bt-*` 变量**
仓库 `test/style-debt.test.js` 强制这条。第一版我在 `var()` 兜底里写了 `#0f1115`，被测试抓到，已改成纯变量。

## 已知限制（必须在 PR 里写清）

宿主把 `conversation.input.right` 渲染在 `trailing > standardControls` 里面，而那个 wrapper 有 `hidden={activity}`——输入框进入活动态（例如听写）时，它连同宿主自己的模型选择器一起被 `display:none`。

`display:none` 会隐藏整棵子树，CSS 绕不过去；用 `:has()` 强行把 wrapper 打开会连带把宿主的控件也放出来，不能做。所以**听写进行时 chip 不可见**，这是有意的取舍，不是漏做。

## 验收标准

1. `workspace-branch.test.js` 7 条通过（符号 HEAD / detached / unborn / 非 git / worktree / 空路径 / 超长名）
2. `npm run build` + `build-client --check` exit=0
3. `npm run lint` 0 errors
4. 全量测试与 `dev` 基线逐条比对，**零新增失败**
5. 界面：chip 真在输入区右上角、不遮发送按钮、长名省略、群聊单聊都显示——**需要真机确认**
6. 六种语言都有 `Workspace branch` 译文

## 开放问题

- 界面效果未在真机确认（需要装包含本次改动的包）。CSS 的 `top:-9px` 是推算值，可能压住输入框上沿。
- 听写时 chip 消失，是否需要换一个不受 `hidden` 影响的位置，等真机看过再定。

## 变更日志

- 2026-11-18 建立。初始实现由小队长写，按分工交小柚子补 i18n、修样式测试、做验收与开 PR。
