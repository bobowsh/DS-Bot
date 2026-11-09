# 账号齿轮的席位归属：把「谁该显示」从全局标志改成界面与席位两维

Refs #26

## 现象与实测结论

原始报告：页面上同一个账号齿轮渲染了两次，`document.querySelectorAll('.bt-account').length === 2`。

2026-11-10 在打包好的实例上（隔离 `DSH_HOME` / `DS_BOT_SHELL_DATA`，完整 profile）用 CDP 读真实 DOM，两种界面分别测：

**经典界面（`data-bt-surface="agent"`）——只有 1 个：**

```json
{"surface":"agent","accountCount":1,
 "accounts":[{"box":{"x":56,"y":764,"w":36,"h":36},"inFootAccount":true,
   "inHostFootArea":true,"visible":true,
   "chain":["bt-account","bt-foot-account","","hHd-Xa_footerActions","hHd-Xa_footArea", ...]}]}
```

**Bot 界面（`data-bt-surface="bot"`）——2 个，但只有一个可见：**

```json
{"surface":"bot","accountCount":2,
 "accounts":[
  {"index":0,"box":{"x":0,"y":0,"w":0,"h":0},"inFootAccount":false,
   "inBotSide":false,"inHostFootArea":true,"inHostSettingsArea":true,"visible":false,
   "chain":["bt-account","","VOzbGW_triggerRow.VOzbGW_railRow","","hHd-Xa_settingsArea","hHd-Xa_footArea", ...]},
  {"index":1,"box":{"x":102,"y":812,"w":36,"h":36},"inFootAccount":false,
   "inBotSide":true,"inLeftColFoot":true,"inHostFootArea":false,"visible":true,
   "chain":["bt-account","bt-leftcol-foot","bt-side","bt-leftcol"]}]}
```

**所以原始描述里「两个齿轮都能点、点一次可能开出两个菜单」不成立**：那个 `visible: false` 的节点 box 全 0，点不到；两张截图里也只有���个齿轮。

**但报告里「同一个齿轮出现两次」这个观察是对的**——它确实是两次渲染，只是其中一次落在宿主侧栏收起时的 0×0 容器里。

## 两条注册路径

| 路径 | 注册处 | 渲染位置 | 界面 |
|---|---|---|---|
| A. `settings.launcher` 席位 | `ds-bot/src/client/index.js:1086` — `shadow('settings.launcher', { priority: BOT_PRIORITY, inject: face }, AccountLauncher)`，默认 `seat=true` | 宿主的 `_settingsArea` 的 triggerRow | 两种界面都注册，但只在宿主侧栏展开时有尺寸 |
| B. 我们自己列脚 | `ds-bot/src/client/sidebar.js:608` 与 `:613` — `h(AccountLauncher, { seat: false, actions })`，在 `.bt-leftcol-foot` 里 | 我们自己的 Bot 列 | 只在 Bot 界面（`bt-side` 存在时） |

两处都画出 `button.bt-account > span.bt-you > GearIcon`。

## 现在的问题：`accountSeated` 是一个全局布尔

互斥靠 `actions.seatAccount(on)` 写的 `state.accountSeated`，而 `FooterAccount` 靠它让位：

```js
// ds-bot/src/client/sidebar.js:1073
export function FooterAccount(props) {
  const seated = props.useUi(value => value.accountSeated === true)
  if (seated) return null
  return h('span', { className: 'bt-foot-account' }, h(AccountLauncher, { ...props, seat: false }))
}
```

```js
// ds-bot/src/client/sidebar.js:821
useLayoutEffect(() => {
  if (!seat) return undefined
  actions.seatAccount(true)
  return () => actions.seatAccount(false)
}, [seat])
```

**这个标志有三个毛病：**

1. **不区分界面**。它只说「有 launcher 置了位」，不说「哪个界面、哪个席位」。经典界面下 `settings.launcher` 那个 launcher **不渲染**，所以 `accountSeated` 保持 false，`FooterAccount` 顶上——这一段是碰巧对的，不是设计对的。
2. **不区分可见性**。Bot 界面下路径 A 的 launcher **仍然挂载**（宿主侧栏收成 rail，整块 0×0），**仍然把 `accountSeated` 置成 true**。这是逻辑上的误判：**不可见的元素不该占位**。
3. **布尔量表达不了「谁占着」**。两处 launcher 都可能想置位，一个卸载会把另一个的置位也清掉（`setAccount(false)`），没有归属。

### 这个误判什么时候会变成真 bug

**`plain` 模式**：Bot 界面，但主视图是一个普通 DSH 会话（`groupsFor` 里 `shell: true, conversation: false`）。那时宿主侧栏是显示的、有实际尺寸，路径 A 的 launcher 就**可见**了——页面上会有两个能点的齿轮。

**这一条尚未实测**：`plain` 模式要一个 DSH Agent 会话当主视图，本次探针没有构造出来，也拉不开宿主侧栏。所以它是**待验证的隐患**，不是已确认的 bug。

## 方案：把「谁该显示」拆成界面与席位两维

### 现在的形状

```
AccountLauncher(seat=true)   ──► 置 accountSeated=true ──► FooterAccount 看见 true，让位
```

一个全局布尔，两端靠「谁先置位」和「有没有人置位」互相猜。

### 要改成

**按界面分归属，而不是靠一个全局标志互相让位。**

1. **谁来占位，由「界面 + 席位」决定，不再由渲染顺序决定。**

   - **经典界面（`agent`）**：宿主侧栏是主角，`settings.launcher` 席位归我们 → **路径 A 显示**（`seat=true`），`FooterAccount` 让位。
   - **Bot 界面（`bot`）**：我们自己的列是主角，宿主侧栏收成 rail → **路径 B 显示**（我们列脚那个），路径 A 的 launcher **不占位**。

   于是 `accountSeated` 这个全局布尔**可以去掉**：每一处 launcher 自己算「在我这里该不该显示」，不再等别人的标志。

2. **不可见的 launcher 不占位。**

   路径 A 的 launcher 在 Bot 界面下不该占位。判断「该不该占位」不能靠 `getBoundingClientRect()`（宿主侧栏收起时是 0×0，但那是布局未定，不等于「不可见」）；**靠界面模式判断**——Bot 界面下 `settings.launcher` 席位根本不该被我们占。

3. **全局监听器与 `open` 状态随可见性收掉。**

   路径 A 的 launcher 即使不显示，它仍然挂着 `window` 的 `mousedown` / `keydown` 监听，还持有自己的 `open` 状态。方案里让它**不显示时根本不挂这些监听**（现在监听是在 `useEffect` 里无条件挂的，只依赖 `open`）：

   ```js
   // 现在：监听与 open 无关，一直挂着
   useEffect(() => {
     if (!open) return undefined
     const onDown = (event) => { ... }
     const onKey = (event) => { ... }
     window.addEventListener('mousedown', onDown)
     window.addEventListener('keydown', onKey, true)
     return () => { ... }
   }, [open])
   ```

   改后：只在**这个 launcher 真的要显示**时才挂监听。菜单 portal 的定位（`anchor()` 读 `getBoundingClientRect`）在 0×0 时也会定位到 0,0，一起收掉。

## 改动面

- `ds-bot/src/client/sidebar.js`：
  - `AccountLauncher`：加一个「我该不该显示」的判据（界面模式 + 席位），据此决定是否渲染按钮、是否挂全局监听、是否持有 `open`。
  - `FooterAccount`：不再读全局 `accountSeated`，改成按同样的判据决定自己是否显示。
  - `TeamSidebar` 里两处 `AccountLauncher` 调用（`:608`、`:613`）：传明自己属于哪条路径。
- `ds-bot/src/client/index.js`：
  - `actions.seatAccount` 与 `state.accountSeated`：**去掉**（如果方案确认后确认没有别的用处）。
  - `shadow('settings.launcher', …, AccountLauncher)`：传明它属于宿主席位那条路径。
- `ds-bot/src/client/styles.js`：可能需要一条规则把不显示的 launcher 从布局里彻底摘掉（现在它靠宿主的 0×0 容器藏起来）。

**`client.js` 是生成物**：`src/client/` 改完要 `npm run build` 一起提交。

## 验收标准

1. **两种界面下 `document.querySelectorAll('.bt-account').length === 1`**（当前：经典 1、Bot 2）。
2. **两种界面下可见的 `.bt-account` 恰好 1 个**（`getBoundingClientRect()` 宽高都大于 0）。
3. **点一次齿轮只开一个菜单**，且菜单定位在按钮旁边（不是 0,0）。
4. **`plain` 模式（Bot 界面 + 普通 DSH 会话）下仍然只有一个齿轮**——这条要把 `plain` 模式构造出来才测得了，是本次的关键回归。
5. **不显示的 launcher 不挂全局 `mousedown` / `keydown` 监听**——用用例断言监听器的挂载与卸载。
6. 门禁：`--check` exit 0、lint 0 errors、`npm test` 无新增失败。

## 还没定的开放问题

- **`plain` 模式怎么构造**：需要一个 DSH Agent 会话当主视图。探针（`app/scripts/dom-probe.mjs` 的形态）能造吗，还是需要另想办法？**没解决之前，验收第 4 条测不了**，第 4 条在 PR 正文里必须标「未验证」。
- **宿主 `settings.launcher` 席位在 Bot 界面下是否本来就该让给宿主自己的插件**：现在是我们用 `priority: BOT_PRIORITY` 抢的。抢的行为是否合理，可能要看宿主的席位语义再定。
- **`appId` 与单实例锁**：与本条无关，只是记一下——`app/src/legacy.mjs` 里的 `APP_ID` 不动。

## 动工时机

**`sidebar.js` 现在不能动**：PR #27（#7）也在改同一个文件。本条等 #7 合并后再从新的 `master` 拉分支，否则冲突白解一遍。
