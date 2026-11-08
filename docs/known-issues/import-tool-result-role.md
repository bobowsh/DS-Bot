# 已知问题：导入含工具调用的会话失败

- 状态：待上游修复（第三方插件的缺陷）
- 影响：从其它 AI 编程工具导入**带工具调用**的会话时失败；纯对话的会话不受影响
- 定位：2026-11-01，dsh-chat-import 0.26.3 与 DeepSeek Harness 0.2.1-rc.4

## 现象

首启自动导入或手动导入时：

```
ds-bot: importing 1 dsh sessions… agents.create 失败，回退 sessionPersistence:
seed tool/result at index 10 message must have role "tool"
DeepSeek Bot: imported 0 sessions from <home> (dsh)
```

失败的那条会话没有落盘，插件的登记表目录也没有生成。

## 真因

两处对不上的**会话格式代次**：

| 位置 | 值 | 说明 |
|---|---|---|
| 宿主 `@deepseek-ai/dsh-session` 的校验 | `tool/result` 的 `message.role` **必须**是 `"tool"` | `MESSAGE_ROLE_BY_TYPE`，无条件 |
| 插件 `convert/shape.mjs` 的 `shapeToolResults()` | 目标代次 ≥ 4 → `role='tool'`；否则 → `role='user'` | 按目标会话代次分支 |

导入的目标代次由 `hostNativeFormatVersion(ctx)` 决定：它从**profile 里已持久化的会话 header** 里取最大版本，
取不到就用插件的默认值 `SESSION_FORMAT_VERSION = 3`（`convert/core.mjs`）。

**全新 profile 里没有已存在的会话**，所以取不到宿主真实代次（4），落回 3 → 走 `role='user'` 的分支 →
宿主的校验拒收整份种子。

注释里那句「ctx 层落盘前再用宿主实际版本覆盖，让插件跟随宿主升级」在**新 profile** 上不成立：
宿主 0.2.1-rc.4 的 `sessionPersistence` 不暴露 `formatVersion`/`currentVersion`，
插件读不到，就只能猜一个 3。

**影响面**：所有含工具调用消息的会话（dsh 与 dsh4 两个来源共用这处转换）。纯对话的会话没有
`tool/result` 事件，能正常导入。

## 已排除的可能

- **不是解析问题**：插件自带的 CLI `export-md` 对同一文件 exit 0，导出 354 KB，会话 id / cwd / 创建时间全对。
- **不是格式问题**：用插件自带的 V4 夹具复现也是 `imported 0`。
- **不是宿主缺能力**：宿主 0.2.1-rc.4 的校验本身是对的——它要求 `role='tool'`，而 V4 形状确实该是 `'tool'`。
- **不是依赖缺失**（另一个曾被修掉的原因）：插件的子依赖 `fzstd` 没跟着进 profile 时，插件整行加载失败，
  表现是「连插件都没有」。现在依赖随包进 profile 了，这一条已修。

## 处理

**主路：向上游提 issue**（`Nwflower/dsh-chat-import`）。修法很直接——`shapeToolResults()` 的 V3 分支
应当也写 `role='tool'`（V3 的消息形状同样有 role 字段，宿主两个代次都要求 `'tool'`），
或者在没有已持久化会话可推断时，改用宿主服务真正暴露的代次。

**旁路（app 侧）**：插件导出了 `withHostFormatVersion(ctx, version, fn)`，可以在导入期间显式指定目标代次；
指定 4 就会走 `role='tool'` 的分支。但这个函数只在 `lib/host-session.mjs` 里导出，包的 `exports` 字段
没有暴露该子路径，从 app 侧 import 不到——要绕开就得改包的导出或直接读它的内部路径，都属于改第三方包。

## 记录

- 失败原因现在会逐条打进日志（`ds-bot/src/host/auto-import.js` 读插件 `results[].error`），
  所以下次再遇到，日志里能直接看到原因，而不是只有「imported 0 sessions」。
