# gitgraph 分支 chip 补丁

让 `@linxin666/dsh-client-ui-git-graph` 的分支选择器在 **Bot 的活跃会话**里也显示。

## 为什么需要

上游插件的分支 chip 只在「空白会话」的 hero 阶段渲染。产物里那句注释是明确的：

```js
// Active sessions intentionally expose no branch-selection control.
if (!heroSeat || repo === void 0 || repo === null) return null;
```

DS Bot 里每个 Bot 的对话都是活跃会话（永远不是空白会话），所以那个 chip 永远不出现。

用户要的最终效果：**输入框上方、麦克风上方**都能看到当前分支、点开能切分支。这个 chip 注册在 `conversation.input.dock`，也就是输入框上方那排 dock，位置正好。

## 为什么改产物而不是源码

该插件**只以 npm 包发布**。作者 `zhu1090093659` 名下的仓库里没有 git-graph 的独立源码仓库，社区插件清单 `dsh-community-plugins` 里也搜不到。npm 包自带完整 `src/`，但装到 profile 的运行时只有 `lib/`。

插件管理器每次核对出厂插件时都会按 registry 版本重装它，`lib/client.js` 就被还原成原厂。所以补丁必须能在**重装后自动重打**——这就是 profile 里 `postinstall` 钩子的用途：`pnpm` 只有真实包变更时才跑 `postinstall`，而重装正好是那种情况。

## 补丁改了什么

在编译产物 `lib/client.js` 上做 10 条定点字符串替换，全部围绕把门控从 `heroSeat` 换成 `seated`：

```js
const heroSeat = sessionSnapshot?.blank === true && (sessionSnapshot.openState === "open" || blankSession === true);
const activeSeat = !heroSeat && sessionId !== void 0;   // 新增：活跃会话也进
const seated = heroSeat || activeSeat;                  // 新增：统一门控
```

四类门控（原产物都判 `heroSeat`，补丁后判 `seated`）：

| # | 位置 | 作用 |
|---|---|---|
| 1 | 首屏取 git 状态的 effect + 它的依赖数组 | 进会话就拉一次分支状态 |
| 2 | `heroRow` 定位 effect + 刷新/订阅/focus effect | 分支变了能刷新 |
| 3 | 打开分支弹层时拉分支列表的 effect + 依赖数组 | 弹层里有分支可选 |
| 4 | **渲染出口** | chip 不出现的直接原因 |

规则 1 之外，每一条都能在产物里唯一命中；匹配到 0 处或 2 处以上都会停下并报错，绝不半套应用。

`heroSeat` 的原义没被改：hero 座位仍然 portal 进官方 chip 行，`activeSeat` 就地渲染在 dock 里。

## 用法

```sh
# 应用（已打过则跳过，幂等）
node tools/gitgraph-patch/apply-gitgraph-patch.mjs

# 只检查，不写盘
node tools/gitgraph-patch/apply-gitgraph-patch.mjs --check

# 用原厂备份还原
node tools/gitgraph-patch/apply-gitgraph-patch.mjs --revert

# 指定插件目录
node tools/gitgraph-patch/apply-gitgraph-patch.mjs --dir <插件目录>
```

### 插件目录怎么推导

优先级从高到低，**没有任何写死的机器路径**：

1. `--dir` 参数
2. `$GITGRAPH_PLUGIN_DIR`
3. `$DSH_PROFILE_DIR/node_modules/@linxin666/dsh-client-ui-git-graph`
4. `~/.dsh/profiles/ds-bot/node_modules/@linxin666/dsh-client-ui-git-graph`

前三个都不成立、第四个也不存在时，脚本报错并打印用法，退出码 1。**不会静默挑一个路径动手**。

### 运行时产物落在哪

备份与日志都在**仓库根的 `tmp/gitgraph-patch/`**：

```
tmp/gitgraph-patch/
├── backup/client.js.<版本>.<原厂哈希>.orig    # 原厂备份，--revert 用
└── postinstall.log                            # 每次 postinstall 的结果
```

`tmp/` 由 `.gitignore` 覆盖，是运行时产物，**绝不提交**。

### postinstall 钩子

profile 的 `package.json` 里：

```json
{
  "scripts": {
    "postinstall": "node \"<仓库>/tools/gitgraph-patch/postinstall-guard.mjs\""
  }
}
```

`postinstall-guard.mjs` 用 `import.meta.url` 找同目录的补丁脚本，吞掉退出码、永远 `exit 0`，只把结果写进日志。补丁失败（比如插件升级导致规则失配）**不会拖垮整个安装流程**。

## 已知状态

- 补丁针对 **0.4.14** 的原厂产物
- 原厂 `sha256[:12]` = `af3943716fe4`（102354 字节）
- 打过补丁 `sha256[:12]` = `cd444a4bcd86`（102431 字节）

## 插件升级后怎么重新对

插件升到 0.5.x 之类的版本后，产物变了，10 条规则会全部失配。脚本会列出未命中的规则名并以退出码 1 结束，**不会应用半套**。

重新对 diff 的步骤：

1. **先拿原厂产物做基底**，别在打过补丁的文件上对：

   ```sh
   # 用插件管理器重装一次，或从 npm 解包
   npm pack @linxin666/dsh-client-ui-git-graph@<新版本>
   tar -xzf linxin666-dsh-client-ui-git-graph-<新版本>.tgz
   ```

2. **找到新的门控点**。在 `package/lib/client.js` 里搜这几个词：

   ```
   heroSeat
   blank === true
   return null
   subscribeChanges
   branchOpen
   ```

   新版可能把 `heroSeat` 改名、或换了门控变量名。

3. **照原逻辑决定改哪里**：目标是让「有 sessionId 的会话」也进渲染，同时保留 hero 座位自己的 portal 行为。

4. **更新 `RULES` 数组**。每条是 `[标签, 原样文本, 补丁后文本]`：

   - `原样文本` 必须是**新产品里的精确子串**，含缩进和分号
   - 必须**唯一命中**——产物的缩进是 tab，不是空格
   - 标签写清「改的是哪一处」，失配时的报错靠它定位

5. **重算哈希**，把上面「已知状态」一节更新成新版本的数值。

6. **验证**：

   ```sh
   node tools/gitgraph-patch/apply-gitgraph-patch.mjs --check   # 规则全命中
   node tools/gitgraph-patch/apply-gitgraph-patch.mjs           # 应用
   node tools/gitgraph-patch/apply-gitgraph-patch.mjs --check   # 报「已打过补丁」
   node tools/gitgraph-patch/apply-gitgraph-patch.mjs --revert  # 能还原
   ```

   之后重启 DSH，实际打开一个 Bot 会话看 chip 是否出现。

> 提醒：确认 `ctx.slots` 的 seat 名没变（`conversation.input.dock`）。上游换了 seat 名的话，光改 RULES 不够，得连插件那边的挂载点一起看。

## 边界

- 只改 `lib/client.js` 这一个产物文件，不碰插件源码、不碰 `package.json`、不碰路由
- 不改 `app/factory.manifest.json`：gitgraph 仍然是出厂插件，摘掉它只有本机有效，应用升级重装会被安装包盖回去
- 不重启 DSH：补丁生效需要重启，重启由人决定
