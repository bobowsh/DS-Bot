# 文件工具的编码参数：可指定 + 自动识别 + 写回保持

Refs #3

## 要解决什么

`read` / `edit` / `write` 三个文件工具目前只按 UTF-8 读写。遇到 GBK/GB18030、UTF-16LE、Big5 的文件时，读出来是乱码，写回去会把原文件编码破坏。

要的是：**能显式指定编码；不指定时自动识别原文件编码；写回时保持原编码和 BOM；新建默认 UTF-8。**

## 调研结论（先报结论，再定方案）

小队长要求：先调研 DSH 有没有公开的「覆盖/包装宿主文件工具」的 API，结论写明确——**能覆盖 / 只能部分 / 根本不行**。

### 结论：**能覆盖，但写回原编码这一步有 API 缺口**

逐条查了 harness 里装的 DSH 包（`ds-bot/dev/harness/node_modules/@deepseek-ai/`）：

#### 1. 能不能覆盖宿主的 `read`/`write`/`edit`？——**能**

`@deepseek-ai/dsh-tools` 的 `ToolsService.register()` 的注释写着：

> Register globally or in the calling agent scope. **Scoped tools shadow global registrations.**

也就是**在 Agent 作用域里注册一个同名工具，会遮蔽全局那个**。

DS Bot 已经在用这条路了：`ds-bot/src/host/tools.js` 的 `shareBotTools()` 里，每个 Bot 的 Agent 都通过 `agent.ctx.tools.register(def)` 注册自己的团队工具。`syncScopedTools()` 负责在 Bot/Session 归属变化时重新挂载或卸载。

所以：把 `read`/`write`/`edit` 也用同样方式注册成 Bot 作用域的工具，就能遮蔽宿主的 UTF-8 版本。**这条路是现成的、已经在跑的。**

#### 2. 读原始字节行不行？——**行**

`@deepseek-ai/dsh-fs` 的 `FileSystem` 抽象类有：

```ts
abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
```

注释：「Read the whole regular file as raw bytes with **no decoding or binary rejection**」。

这就是识别编码的入口：BOM 检测 + UTF-8 严格解码试探 + 回退探测，都在这份原始字节上做。

#### 3. **写原始字节行不行？——不行，这是缺口**

`FileSystem` 抽象类里**只有 `writeText`，没有 `writeBytes`**：

```ts
abstract writeText(target, content: string, expected?, signal?, sandboxPolicy?): Promise<FsWriteOutcome>
```

注释明写：「Atomically create or replace **UTF-8 text**」。

`@deepseek-ai/dsh-fs-local` 的实现里，`writeFileAtomic()` 落盘时写死了：

```js
await handle.writeFile(content, { encoding: "utf8", ... })
```

`editText` 走的是 `readForEdit()` → `decodeUtf8()`，读的时候就已经用 `TextDecoder("utf-8", { fatal: true })` 严格解码了——**GB18030 文件在 `editText` 里会直接抛 `FS_NOT_TEXT`**。

**所以：读可以自己做（readBytes），写不能。**

#### 4. 有没有别的公开路径能写原始字节？

- `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic(filename, content: string | Uint8Array, options)` **接受 Uint8Array**——但它的参数是**绝对路径**，不是 `FsTarget`，并且它**不认识沙箱/文件系统后端**（远程后端的路径不是本地路径）。用它会绕过 `ctx.fs` 的沙箱围栏、路径解析和原子发布约定。
- 其它写路径（`dsh-config-editor`、`dsh-plugin-manager` 等）都是「写字符串」，且都直接用 `writeFileAtomic`。

**结论：拿 `ctx.fs` 的公开 API 写非 UTF-8 字节，没有路。**

## 由此定下的方案

分两档，**都做**，第一档就能满足 issue 的大部分验收标准：

### 第一档：读——完全可做（无缺口）

在 Bot 作用域注册自己的 `read`：

1. `ctx.fs.resolve(path)` 拿到 target
2. `ctx.fs.readBytes(target, signal, maxBytes)` 拿原始字节
3. **探测编码**（顺序固定）：
   - BOM：UTF-8 BOM（`EF BB BF`）→ `utf-8`；`FF FE` → `utf-16le`；`FE FF` → `utf-16be`
   - 无 BOM：先试 UTF-8 严格解码（`TextDecoder('utf-8', { fatal: true })`），成功即 `utf-8`
   - 失败：二进制判定（出现 NUL 字节）→ `FS_NOT_TEXT` 拒绝；否则用探测库回退（GB18030 / Big5）
4. 解码，按行号输出，**返回值里带上实际采用的编码**

探测库用 `chardet`（纯 JS、无原生依赖、可打包）。编解码用 Node 内置的 `TextDecoder`——它**原生支持 GB18030 / GBK / UTF-16LE / UTF-16BE / Big5**（WHATWG Encoding 标准），不需要 `iconv-lite`。**只有回退探测需要 `chardet`。**

> 这一条要先核实：Node 的 `TextDecoder` 在 `full-icu` 下支持全部 WHATWG 编码。Electron 打包的 Node 带 full-icu。**这要在写代码前实测确认**，不能靠文档推断。

### 第二档：写——受限于 API

`edit` / `write` 的编码保持有三条路：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 只对 UTF-8 家族生效** | 检测到的编码若是 UTF-8/UTF-16（Node 的 TextDecoder 能编解码 UTF-16），用 `ctx.fs.writeText` 写回去（UTF-16 需要自己编成 BOM+字节——**编不了，`writeText` 只收字符串**） | 覆盖不全 |
| **B. 用 `dsh-atomic-write` 写字节** | 自己管字节编解码，用 `writeFileAtomic(path, bytes)` 落盘 | **绕过 `ctx.fs` 的沙箱围栏和路径解析**——违反 AGENTS.md「不碰 DSH 数据边界」的意图 |
| **C. 明确报缺口** | 非 UTF-8 的写回不做，报「此编码的写回需要 DSH 侧支持」 | issue 的验收标准 2/3/4 达不到 |

**推荐组合：A + C，并把 B 作为「需要 DSH 侧开口子」的正式缺口上报。**

理由：

- **B 是硬伤**。`ctx.fs` 的存在意义就是「所有文件操作都过这一层」（沙箱围栏、路径解析、原子发布、版本守卫）。绕过它去用 `writeFileAtomic` 直接写绝对路径，会让「文件工具受沙箱约束」这条保证失效——在 `dsh-fs-sandbox` 后端下这是**安全回归**，不是小瑕疵。AGENTS.md 第 1 条说得很清楚：DSH 里缺东西就停下来说清楚，不许用打补丁的方式绕过去。
- 读全部走 `ctx.fs.readBytes`，写全部走 `ctx.fs.writeText`——**读写路径一致**，这是第二档能安全做的部分。

### 具体到三种情形

1. **读**：`readBytes` + 探测 + `TextDecoder` 解码。全部编码都支持。✅
2. **写已有文件**：
   - 原编码是 UTF-8（无 BOM）→ `ctx.fs.writeText` 直接写，字节完全一致。✅
   - 原编码是 UTF-8 BOM → 需要保留 BOM。`ctx.fs.writeText` 写的是纯文本，BOM 会丢。→ 走「BOM 由谁保留」的缺口。
   - 原编码是 GB18030 / Big5 / UTF-16 → 需要写非 UTF-8 字节 → **缺口**。
3. **新建文件**：默认 UTF-8 无 BOM → `ctx.fs.writeText`。✅ 显式指定 `utf-16le` 等 → 需要写 BOM+字节 → **缺口**。

## 验收标准（第一档能覆盖的）

1. GB18030 文件：`read` 不传 encoding → 内容正确；传 `encoding: 'gbk'` → 内容正确 ✅
2. UTF-16LE（带 BOM）文件：自动识别为 `utf-16le`，读取内容正确 ✅
3. UTF-8 BOM 文件：读取时 BOM 被剥离 ✅
4. 二进制文件被 `FS_NOT_TEXT` 拒绝 ✅
5. Big5 等 UTF-8 非法字节序列能经自动探测正确读出 ✅
6. 三个工具的返回值能看出本次实际采用的编码 ✅
7. 不破坏现有 UTF-8 文件的读写 ✅
8. 不改动 DSH 宿主包 ✅

**达不到的（要如实标注 BLOCKED）**：

- 验收 2：GB18030 文件 `edit` 后字节仍是 GB18030 → **缺口**（写非 UTF-8 字节）
- 验收 3：UTF-16LE `edit` 后 BOM 仍在 → **缺口**（`writeText` 只写纯文本）
- 验收 4：UTF-8 BOM 文件 `edit` 后 BOM 保留 → **缺口**
- 验收 5：显式 `encoding: 'utf-16le'` 新建带 BOM → **缺口**

## 已拍板的决策

- **不在 DSH 宿主包里加任何东西**，不动 `dsh-fs` / `dsh-fs-local` / `dsh-tool-fs`。
- **不用 `dsh-atomic-write` 绕过后端写字节**（B 方案否掉，理由见上）。
- 探测库用 `chardet`（新增依赖，需要在 `ds-bot/package.json` 里加）；编解码用 Node 内置 `TextDecoder`（不加依赖）。
- 先在 Bot 作用域遮蔽宿主的 `read`/`write`/`edit`；`write`/`edit` 在编码是 UTF-8 时行为与宿主一致，其它编码报明确的缺口错误。

## 还没定的开放问题

- **缺口要不要去 DSH 上游提 issue？** `FileSystem` 加一个 `writeBytes(target, bytes, expected?, signal?)` 是最干净的解法：宿主自己的 `writeText` 也可以改成「编成 UTF-8 字节再调 `writeBytes`」。要不要提、什么时候提，要问用户。
- **第一档做完后，够不够用户用？** 用户真正的痛点是「别把文件写坏」。只读不写，等于能看懂 GBK 文件但改不了。**如果缺口不补，#3 可能只解决了一半**——这一点要在方案落地后向用户说明。
- 宿主工具的 `read` 还带 `offset`/`limit` 分页，以及「只读文本文件」的策略（大文件、目录、符号链接的处理）。我们的影子工具要**复刻这些行为**，否则模型会得到不一样的语义。

## 接下来的动作

1. **实测 Node 的 `TextDecoder` 是否支持 GB18030/Big5**（Electron 的 Node 是否带 full-icu）。这一步决定要不要引入 `iconv-lite`。
2. 写探测模块 `ds-bot/src/host/encoding.js`（纯函数，好测）。
3. 写 Bot 作用域的影子 `read` 工具。
4. `write`/`edit` 的影子工具：UTF-8 走宿主行为，其它编码报缺口。
5. 测试放 `ds-bot/test/encoding.test.js`。
