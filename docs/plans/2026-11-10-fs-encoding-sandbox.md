# 文件工具的编码支持：改走 `ctx.fs`，让编码能力落在沙箱围栏内

Refs #3

## 现在的状况

**#3 的功能其实已经做完了**——上游的 `2d07cee2`（PR #5）带了 `ds-bot/src/host/encoding.js`（265 行）与 `ds-bot/test/encoding.test.js`（9/9 通过，对应 issue 的 9 条验收）。

但用户 2026-11-08 **重新打开了 #3**，理由原话：

> 原关闭不能代表问题已解决——团队至今仍在用「禁止用 pwsh 写文件」这条禁令绕开编码问题，今天还因此写坏过测试文件。

所以用户真正要的不是「有个功能」，而是**「这条禁令能被取消」**。要做到这一点，实现必须**在真实环境里可靠**，而现在这份实现有一个硬伤。

## 硬伤：绕过了沙箱围栏

`ds-bot/src/host/encoding.js` 全程用 Node 的 `fs`：

```js
import { readFileSync, writeFileSync, renameSync, statSync, existsSync, unlinkSync } from 'node:fs'
```

- 第 129 行 `readFileSync(path)` —— 读
- 第 163 行 `writeFileSync(temp, bytes)` —— 写

**它一次都没走 `ctx.fs`。**

DSH 的文件系统服务（`@deepseek-ai/dsh-fs`）是所有文件操作的唯一入口：`dsh-fs-sandbox` 在它上面加权限围栏，`dsh-fs-local` 提供 `readBytes`/`writeText` 等原语。团队有权限预设（`read-only` / `workspace-write` / `danger-full-access`，见 `ds-bot` 的 `permission` 配置），**「仅可查看」的意思是 Bot 读得了、写不了**。

现在这份实现**绕过了 `ctx.fs` 直接读写磁盘**——用户给 Bot 选「仅可查看」，它照样能写文件。**这是安全回归，不是小瑕疵。**

同时它自己实现了一套「原子写」（临时文件 + rename）和「路径解析」（`targetPath` 里手工 resolve 相对路径），这些 `ctx.fs` 都**已经提供了**，而且 `ctx.fs` 的版本守卫（`FsVersion`）比这里的手写版本更严。

## 方案：把编解码留在我们这层，读写走 `ctx.fs`

`ctx.fs` 的接口够用——查过 `@deepseek-ai/dsh-fs` 的类型定义：

| 需要 | `ctx.fs` 有的 | 够不够 |
|---|---|---|
| 读原始字节 | `readBytes(target, signal, maxBytes): Promise<Uint8Array>` —— 注释：「no decoding or binary rejection」 | ✅ **正好是编解码的入口** |
| 解析路径 | `resolve(path, opts)` → `FsTarget` | ✅ |
| 写字节 | `writeText(target, content: string, expected?, signal?, sandboxPolicy?)` | ❌ **只收字符串** |
| 读文本 | `readText(target, signal)` → `string` | ✅（但对我们无用：宿主只解 UTF-8） |

### 所以：读能完全走 `ctx.fs`，写不能

- **读**：`ctx.fs.readBytes` → 探测编码 → `TextDecoder` 解码。**全部在沙箱内**，沙箱的 `read-only` 预设照样拦得住。
- **写**：我们要把**非 UTF-8 的字节**写回去，`ctx.fs.writeText` 只收字符串，写进去就是 UTF-8。**这就是我方案文档里写的那条缺口**，现在落到具体位置了。

### 写的问题，三条路

| | 做法 | 评价 |
|---|---|---|
| **A. 现状** | 用 Node `fs` 直接写 | **否掉**：绕过沙箱，用户选「仅可查看」也能写文件 |
| **B. `ctx.fs.writeText` + 临时中转** | 先把目标字节**编码成字符串**？——不可能，非 UTF-8 编码不是字符串 | **走不通** |
| **C. 先在沙箱内建一个临时文件（用 `writeText` 写 UTF-8），再用 `ctx.fs` 改名？** —— 改名搬的是字节，**但那仍是 UTF-8 字节** | **走不通** |

**所以，非 UTF-8 的写回在 `ctx.fs` 的现有接口下无路可走。**

### 结论：读这一半现在就能做且必须做；写这一半是 DSH 的 API 缺口

**读**（GB18030 / UTF-16LE / Big5 正确读、BOM 正确处理、二进制仍拒）：

- 完全走 `ctx.fs.readBytes`，**不碰 Node 的 `fs`**。
- 沙箱围栏保住。
- 探针/预览/读取路径（`dsh-tool-fs` 的 `read`）照旧。

**写**（保持原编码写回）：

- `ctx.fs` 需要一个 `writeBytes(target, bytes, expected?, signal?)`。
- 这是**宿主该补的接口**，不是我们能绕过去的——绕过去就是 A（破坏沙箱）。
- 解除条件写明：**「需要 DSH 的 `FileSystem.writeBytes(target, bytes)`」**。

### 顺带：图标/预览那条路也受益

`dsh-tool-fs` 的 `read` 之外，DSH 还有几个会读文件的工具（`grep`/`search` 之类）。它们也只解 UTF-8。我们**只遮蔽 `read`**（按小队长定的「委托 + 回退」，不做全遮蔽）：影子 `read` 先委托宿主，只有宿主抛 `FS_NOT_TEXT` 时才用 `ctx.fs.readBytes` 自己解。

## 实现方式：影子工具，不是钩子

现在这份实现用的是 `ctx.on('tools/execute')` 钩子——它在**宿主的 `read` 已经跑过之后**才介入，而宿主对非 UTF-8 文件会先抛错。要在宿主抛错前接管，得**遮蔽工具本身**。

小队长已定的方向：**委托 + 回退**。影子 `read`：

1. `ctx.tools.get('read')`（不传 scope）拿到宿主原版；
2. 先调它；
3. 只有它抛 `FS_NOT_TEXT`，我们才用 `ctx.fs.readBytes` + 探测解码自己返回。

**前提已核实**（`ds-bot/dev/verify-tool-shadow.mjs`，真实 cordis Context + 真实 ToolsService + 真实 createScope）：

```json
{"get_noScope_isHost": true, "get_noScope_same": false,
 "executable_noScope_isHost": true,
 "host_execute_result": "HOST-READ-ORIGINAL", "host_execute_ok": true}
```

**不传 scope 时拿到的是宿主原版，引用不等于包装体，而且真的能执行。** 委托可行。

### 影子 read 不是 team tool

影子 `read` **故意与宿主工具同名**，所以它必须**作用域内遮蔽**，不能进 `rt.teamTools`：team tool 是按名字列在 `TEAM_TOOLS` 里的清单工具，混进去会污染那份名单，也会让「Bot 作用域拿到哪些工具」的判断失真。

落地：`rt.scopeShadows = [readTool(rt)]`，在 `shareBotTools` 里与 team tools 一起注册进 Bot 自己的作用域；**群的会话只拿 `group_relay`，不拿影子**。

## 本次交付的范围

**做完了（读这一半）：**

- 影子 `read` 走「委托 + 回退」：UTF-8 文件仍是宿主原路径（沙箱、行号、limit、二进制拒绝一字不变）；只有宿主抛 `FS_NOT_TEXT` 时才用 `ctx.fs.readBytes` 自己探测解码。
- **全程不碰 Node 的 `fs`**：字节只从 `ctx.fs` 拿（`ds-bot/test/fs-read.test.js` 有一条用例钉住「走过服务、没直读磁盘」）。
- 旧实现（`tools/execute` 钩子 + Node `fs` 直读直写）**已删除**——那正是绕过沙箱围栏的来源。
- 编码探测/解码保留为纯函数（`ds-bot/src/host/encoding.js`）。

**没做完（写这一半）——`BLOCKED`：**

- 保持原编码写回需要宿主提供 `FileSystem.writeBytes(target, bytes)`。现有 `writeText` 只收字符串，写进去就是 UTF-8。
- **解除条件：DSH 增加 `FileSystem.writeBytes(target, bytes)`。**
- 在此之前，写路径保持宿主原样（UTF-8），写坏了原编码的风险由宿主自己承担；`ds-bot/test/encoding.test.js` 里那条写回用例标 `skip` 并写明解除条件，不当通过。

## 验收标准

1. GB18030 文件：影子 `read` 自动识别并读出正确内容，返回值带 `<encoding>gb18030</encoding>`。
2. UTF-16LE（带 BOM）：识别为 `utf-16le`，内容正确。
3. UTF-8 BOM：读取时 BOM 剥离。
4. Big5：经探测正确读出。
5. 二进制文件：仍以 `FS_NOT_TEXT` 拒绝。
6. 不支持的编码名：显式报错，不静默按 UTF-8 处理。
7. **纯 UTF-8 文件：走宿主原路径，行为一字不变**（沙箱、行号、limit 全在宿主手里）。
8. **沙箱围栏不破**：影子 `read` 只用 `ctx.fs.readBytes`，**不出现 Node 的 `fs`**——这一条要有用例钉住。
9. **写回原编码：BLOCKED**，解除条件「需要 DSH 的 `FileSystem.writeBytes(target, bytes)`」。用例标 `skip` 并写明解除条件。
10. 门禁：`--check` exit 0、lint 0 errors、`npm test` 无新增失败。

## 还没定的开放问题

- **上游提 issue 的时机**：对外互动要用户点头。文档里已写清缺口（缺什么 API、宿主哪几行写死 UTF-8、加上之后能达成哪些验收）。
- **写回这一半用户能不能接受**：用户 2026-11-08 的原话是「今天还因此写坏过测试文件」——他要的是**别再写坏**。「读对了」能避免一半（读的时候看到乱码就知道不对），但「写回不破坏原编码」才是根治。
