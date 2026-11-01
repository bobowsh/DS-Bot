# 按 bot 挂载文件技能

- 日期：2026-11-01
- 状态：已实施

## 为什么

用户想给某个 bot 挂载指定技能集。技能不只是 SKILL.md，还包括脚本（.mjs、.py 等），所以放文件系统里更好，单独目录存放。技能不放在全局可以自动加载的地方，只让指定 bot 能看到并加载。

## 调研结果

### ds-bot 的 capabilities 机制（方式1）

- `bot.capabilities` 数组控制哪些技能挂到哪个 bot
- 技能存到 `state.capabilities.items`（内存/state.json）
- 技能通过 `agent.ctx.plugin` 运行时注册，`source: 'runtime'`
- 其他 bot 看不到

### office-skills.js（方式2）

- 技能是文件（SKILL.md），放在 `ds-bot/office/skills/`
- 通过 `ctx.skills.registerProvider` 注册 provider
- provider 的 `list()` 从文件解析，`get()` 从文件读取内容
- 这是**全局**注册，所有 bot 可见

### 设计思路

- state.json 是 bot 团队的单一事实来源，技能存 state.json 享受原子性/锁/迁移
- 内置技能（office-skills）用文件，因为随 app 打包
- 用户配置的技能存 state.json，因为是配置数据

## 已定的行为

### 技能放文件系统，单独目录

- 每个技能一个目录，包含 SKILL.md 和脚本
- 目录结构：

```
skills/my-skill/
  SKILL.md
  scripts/
    *.mjs
    *.py
```

### 用 capabilities 的 locator 机制

- capabilities 条目存 `locator`（技能目录路径）
- `configFor` 从技能目录读取 SKILL.md，并记录技能目录路径
- `bot.capabilities` 控制挂载，其他 bot 看不到

### 实现细节（改 capabilities.js 两处）

1. **`itemInput`**（约第 122 行）：`kind === 'skill'` 时，如果 `body.locator` 有值，存 `locator`；否则存 `content`（现有行为不变）
2. **`configFor`**（约第 267 行）：如果技能有 `locator`，从文件读取 SKILL.md 的 content；否则用内存 `content`

### 脚本路径

- SKILL.md 里的脚本用相对路径（如 `scripts/do-something.mjs`）
- 挂载时按 office-skills 的现成机制带上 `resourceBase: { kind: 'directory', path: <技能目录> }`（见 `office-skills.js:58`），AI 加载技能后自己定位脚本，不做额外路径处理

```js
// itemInput 改动（kind === 'skill' 分支）
if (kind === 'skill') {
  const locator = String(body.locator ?? '').trim()
  if (locator !== '') item.locator = locator
  item.content = String(body.content ?? '').trim()  // 保留现有行为
}

// configFor 改动（kind === 'skill' 分支）：locator 优先于内存 content
if (item.kind === 'skill') {
  if (item.locator) {
    const directory = item.locator.split(sep).join('/')
    return {
      name: item.name, description: item.description,
      content: readFileSync(join(item.locator, 'SKILL.md'), 'utf8'),
      resourceBase: { kind: 'directory', path: directory },
    }
  }
  return { name: item.name, description: item.description, content: item.content }
}
```

### 技能目录路径

- 不放在 `~/.dsh/skills/`（全局 skill-filesystem 会自动加载）
- 放在 bot 专属目录或用户指定目录
- 通过 `locator` 指向技能目录

### 群 Session 也挂该 bot 的技能

按 bot 挂载后，该 bot 的**群 Session** 同样会挂上它的技能（例如主 Bot 的 `room-chief` 也拿到）。原因是技能与 MCP 能力包走同一条 `reconcileAgent` / `botOfSession` 路径，而群 Session 在 `store.js` 的 `groupOwners` 里就归该 bot（`selfOf` 解析回它的 botId），所以同一个 bot 的私人会话和群 Session 一起挂。

- 这是**既有机制**，本次改动（`4241e4e`）没有碰它；行为与 MCP 能力包一致，**不改代码**。
- 「其他 bot 看不到」依然成立：挂给谁只由 `bot.capabilities` 决定，别的 bot 的私人会话和群 Session 都拿不到。

## 不做什么

- 不修改 dsh-chat-import 插件的源码
- 不把技能放在全局 skill-filesystem 目录
- 不自动加载技能（只通过 capabilities 挂载）

## 已知限制

- 技能脚本的路径需要在 SKILL.md 里说明（相对技能目录）
- 技能目录需要存在，否则挂载失败

## 变更

- 2026-11-01：初稿，方案已定（技能放文件系统，单独目录，capabilities 按bot挂载）。
- 2026-11-01：实施。`locator` 是技能目录（其下放 `SKILL.md` 与 `scripts/`），挂载时每次从文件读正文并带 `resourceBase`；目录不存在时该技能挂载失败、状态报 error。`save_capability` 工具加了 `locator` 入参。
- 2026-11-01：补群 Session 口径。技能按 bot 挂载，该 bot 的私人会话与它参与的每个群 Session 都挂（小镊子（软件测试）实测 `room-chief` 同样拿到）。由既有 `reconcileAgent` / `botOfSession` 路径决定，本次改动未碰，行为与 MCP 能力包一致；无需改代码。
