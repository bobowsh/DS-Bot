# 文件工具的编码支持：读已做完，写这一半卡在宿主缺 `writeBytes`

- 日期：2026-11-14（本文是 2026-11-10 `2026-11-10-fs-encoding-sandbox.md` 的延续与核实）
- 状态：调研完成，等用户与队长对齐后再实现
- Refs #3（编码支持）、#45（群聊工具区）

## 一、先说结论

用户这次的初步方案是「轻量 patch 支持 writebytes」。盘完的结论是：

1. **读的这一半，早就做完了**（2026-11-10 落地并合入 dev）：影子 `read` 会读 GBK/GB18030/Big5/UTF-16，二进制仍拒绝，UTF-8 文件走宿主原路径一字不变。
2. **写的这一半，卡在宿主缺一个接口**：`ctx.fs` 只有 `writeText`（收字符串，写进去就是 UTF-8），**没有 `writeBytes`**。
3. 这个缺口**不能在我们这边绕过去**——绕过去就是绕过沙箱围栏（用户选「仅可查看」时 Bot 照样能写文件），那是安全回归。
4. 我核实了**最新的 `dsh-fs-local@0.2.2-rc.3`（npm 上最新）仍然没有 `writeBytes`**——宿主没补。

所以「轻量 patch 支持 writebytes」要落地，得先回答：**这个 writebytes 走哪条路？** 三条路见第四节。

## 二、现状盘清（全部实测，非推断）

### 2.1 这三个工具是宿主的

`@deepseek-ai/dsh-tool-fs`：

| 工具 | 位置 | 自述 |
|---|---|---|
| `read` | `dsh-tool-fs/lib/index.js:254` | 「Read a UTF-8 text file and return line-numbered content.」 |
| `write` | `:549` | 「Create or fully replace a UTF-8 text file.」 |
| `apply_patch` | `:1384` | Codex 式 patch，操作 UTF-8 文本文件 |
| `edit` | `:1460` | 「Edit an existing UTF-8 text file by replacing literal text.」 |

**我们仓库里没有 read/write/edit 的实现**，只有一层影子 `read`。

### 2.2 编码在宿主哪一层处理的

`dsh-fs` 服务定义原话（`dsh-fs/lib/index.js`）：

> Backends own stable target identity, process paths and file URIs, containment, **text reads, decoding, binary rejection**, and atomic mutations.

解码在本地后端 `dsh-fs-local/lib/index.js`：

```js
// :345
function decodeUtf8(buffer, verb, displayPath) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer) }
  catch { throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT") }
}
// :387  先按 NUL 字节判二进制
if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) throw new FsError(..., "FS_NOT_TEXT")
// :468  流式读同理
const decoder = new TextDecoder("utf-8", { fatal: true })
// :315 / :567  写：原子写硬编码 encoding
await handle.writeFile(content, { encoding: "utf8", ... })
```

**全链路只认 UTF-8，而且是「严格失败」不是「静默乱码」。**

### 2.3 非 UTF-8 文件的真实行为（我按宿主代码原样复刻跑了一遍）

用 `iconv-lite` 造样本，走宿主的解码 + NUL 判定：

```
  gbk.txt          读失败：FS_NOT_TEXT — cannot read "gbk.txt": invalid UTF-8 text
  gb18030.txt      读失败：FS_NOT_TEXT — cannot read "gb18030.txt": invalid UTF-8 text
  big5.txt         读失败：FS_NOT_TEXT — cannot read "big5.txt": invalid UTF-8 text
  utf16le.txt      读失败：FS_NOT_TEXT — cannot read "utf16le.txt": binary file
  utf8.txt         读成功："utf8 text\n"
```

要点：

1. **不是乱码，是报错**——比静默损坏好，但用户依然干不了活。
2. **UTF-16 被当成二进制**（含 NUL）。
3. **写也只出 UTF-8**：想产出 GBK 文件，现在**没有任何办法**。

### 2.4 宿主 `ctx.fs` 已有的 / 缺的

| 方法 | 有无 | 能否用于非 UTF-8 |
|---|---|---|
| `readText` / `streamText` | 有 | ❌ 严格 UTF-8 |
| **`readBytes`** | **有**（`dsh-fs-local:890`，返回 Buffer，不解码不判二进制） | ✅ |
| **`readByteRange`** | **有**（`:896`） | ✅ |
| `writeText` | 有（`:917`） | ❌ 只收字符串 |
| `editText` / `patchText` | 有 | ❌ 先按 UTF-8 解码 |
| **写原始字节** | **没有** | — **这就是缺口** |

**读字节已有，写字节没有。**

### 2.5 我们这边已经有的（读这一半，早做完）

| 文件 | 作用 |
|---|---|
| `ds-bot/src/host/encoding.js` | 编码探测（BOM → 严格 UTF-8 → 中文编码探测）与解码，`iconv-lite` + `chardet`，支持 `utf-8` / `utf-8-bom` / `utf-16le` / `utf-16be` / `gb18030` / `gbk` / `big5` |
| `ds-bot/src/host/fs-encoding.js` | `readBytesThrough(fs, path)` —— **只走 `ctx.fs.readBytes`，不碰 Node 的 `fs`**，沙箱围栏保住 |
| `ds-bot/src/host/fs-read-tool.js` | 影子 `read`：先委托宿主（UTF-8 文件行为一字不变），宿主抛 `FS_NOT_TEXT` 才用 `readBytes` 自己解 |

`fs-read-tool.js:13` 的注释已经把缺口写明了：

> Writing a non-UTF-8 file back in its own encoding needs a `writeBytes` the filesystem service does not have.

### 2.6 上游 DSH 有没有补

- 上游 `Fei2411/DS-Bot` 仓库里搜到的 `writeBytes` 是 PNG 编码器的同名方法，**无关**。
- npm 上最新的 `@deepseek-ai/dsh-fs-local@0.2.2-rc.3`（我们钉的是 `0.2.2-rc.1`）：**仍然没有 `writeBytes`**，方法列表还是 `readBytes` / `readByteRange` / `writeText` / `editText` / `patchText` / `deleteFile` / `moveFile`。

**宿主这个缺口至今没补。**

## 三、缺口的准确范围

用户要的是「read/write/edit 的编码支持」，现在缺的是**写**这一半，而且不止 `write`：

- `write`：写不进非 UTF-8 文件。
- `edit`：读都读不出来，所以改不了。
- `apply_patch`：同上。

**只有 `writebytes` 也不够**——写进去之后要能读回来核对，所以至少还需要「按编码读」这一条路。

## 四、writebytes 走哪条路（三条，请用户/队长拍板）

| | 做法 | 评价 |
|---|---|---|
| **A** | 在我们插件里用 Node `fs` 直接写字节 | **否掉**：绕过 `ctx.fs`，用户选「仅可查看」时 Bot 照样能写文件——安全回归。2026-11-10 那版实现就是这么栽的，已删除。 |
| **B** | 借 `ctx.fs.writeText` 传字符串 | **走不通**：非 UTF-8 的字节不是字符串；且 `writeFileAtomic` 硬编码 `encoding: "utf8"`，传 Buffer 会被当 UTF-8 字符串编码，字节全变。 |
| **C** | **请宿主补 `ctx.fs.writeBytes(target, bytes, expected?, signal?)`** | **推荐**：与已有的 `readBytes` 对称，沙箱围栏与原子写语义都由宿主保证，跨版本也稳。解除条件写死在这一条。 |

**我的建议**：走 C，同时**先在插件里把 `writebytes` 的工具形态、参数、编码清单定下来**，等宿主一补上就能接。

如果宿主短期补不了，替代方案是 **C'：我们自己在插件里实现字节版原子写**——但必须复刻宿主那套「同目录临时文件 + 替换 + Windows DACL 保留」，而 `dsh-fs-local` 里那套代码**不能复制**（它不是导出物，AGENTS.md 第 3 条允许复制但要署名，且这份是随 DSH 版本走的）。所以 C' 的代价明显更高。**这一条需要用户拍板。**

## 五、`writebytes` 的工具设计（待 C 拍板后实现）

**工具形态**（新增团队工具，注册进 `TEAM_TOOLS`）：

```jsonc
{
  "file_path": "string",   // 必填
  "bytes":    "string",   // 必填，base64 的原始字节
  "encoding": "string?",  // 可选：utf-8 / utf-8-bom / utf-16le / utf-16be / gb18030 / gbk / big5
  "mode":     "string?"   // 可选："create"（不存在才写）/ "replace"（覆盖，默认）
}
```

- **为什么 base64**：字节不等于文本，base64 是唯一无损的表示（GBK/UTF-16 的字节塞进 JSON 字符串会被 UTF-8 规则污染）。
- **`encoding` 的两种用法**：不传 = `bytes` 已是目标文件的最终字节（写二进制、改 BOM 都够用）；传了 = 先按该编码解码再编码回去（等价于「按 GBK 写这段文字」）。
- **配套的读**：还需要「按编码读」的入口，才能「读→改→写回」闭环。现有影子 `read` 已经能按编码读出文本了（`fs-read-tool.js` 带 `encoding` 参数），所以**读这一半不用再做**——这轮只差 `writebytes`。

**默认行为与兼容性**：不传任何新参数时，宿主 `read`/`write`/`edit` 的签名、行为、报错**一字不动**。`writebytes` 是**新增的独立工具**，不是给 `write` 加参数——老会话、老 prompt、老脚本零影响，宿主升级也不受影响。

**错误处理**：

| 情况 | 行为 |
|---|---|
| 路径不在工作区 | 沿用宿主沙箱判定（`FS_SANDBOX_DENIED`） |
| 父目录不存在 | 自动创建（与宿主 `write` 一致） |
| `bytes` 非法 base64 | 明确报错，不写坏文件 |
| `encoding` 未知 | 明确报错并列出支持的编码名 |
| 解码失败（文本不是该编码） | 明确报错，指出编码名 |
| 目标是目录 | `FS_NOT_REGULAR_FILE`（沿用宿主错误码） |
| 写后校验 | 写完读回比对字节，不一致则报错 |

**边界**：路径解析与沙箱判定**全走宿主 `ctx.fs.resolve()`**，我们不自己拼路径；写入设字节上限（`FS_TOO_LARGE`）；复用宿主的「先读后写」观察语义（`FS_NOT_OBSERVED`），除非显式 `mode: "create"`。

## 六、要改的文件（若 C 拍板）

| 文件 | 改动 |
|---|---|
| `ds-bot/src/host/encoding.js` | 加 `encodeBytes(text, encoding)`（`iconv-lite` 编码方向，现只有解码） |
| `ds-bot/src/host/fs-encoding.js` | 加 `writeBytesThrough(fs, path, bytes)` —— 调 `ctx.fs.writeBytes` |
| `ds-bot/src/host/fs-write-tool.js`（新） | `writebytes` 工具定义与执行器 |
| `ds-bot/src/host/constants.js` | `TEAM_TOOLS` 加入 `writebytes` |
| `ds-bot/src/client/cells.js` | 工具事件行认识 `writebytes` 的展示文案 |
| `ds-bot/test/fs-write.test.js`（新） | 见下 |
| `NOTICE` | 无需署名（不复制宿主代码，只调用宿主 `ctx.fs`） |

**不改动**：`dsh-tool-fs`、`dsh-fs-local`（宿主包）。

## 七、测试

1. `writebytes` 写 GBK 文件 → 按 GBK 读回字节一致；用 UTF-8 读则报 `FS_NOT_TEXT`（证明确实是非 UTF-8）。
2. 不传 `encoding` → 写入字节与 base64 解出的一致。
3. 传 `encoding: "gbk"` → 写出的字节等于 `iconv.encode(text, 'gbk')`。
4. 写二进制（PNG 头）→ 字节完全一致。
5. 非法 base64 / 未知编码 → 明确报错，**且不写坏文件**。
6. 路径在工作区外 → 拒绝。
7. 原子性：写失败后原文件内容不变。
8. 现有 `read`/`write`/`edit` 行为**不变**（回归）。
9. **沙箱围栏不破**：`writebytes` 只用 `ctx.fs`，代码里不出现 Node 的 `fs`（用测试钉住，和影子 `read` 一样）。

## 八、验收标准

1. GBK/GB18030/Big5/UTF-16 文件能「读出→改→写回」，内容正确、无乱码、原编码保持。
2. 不传新参数的现有用法，行为与改动前**逐字节一致**。
3. 宿主工具（`read`/`write`/`edit`）的实现**未被修改**。
4. 错误路径明确可读（不是堆栈）。
5. 门禁三项与基线对比不新增失败。

## 九、要用户与队长拍板的开放问题

1. **宿主接口**：走 C（请 DSH 补 `ctx.fs.writeBytes`），还是先在插件里自己实现字节版原子写（C'，代价高、且 Windows DACL 那套逻辑没法干净复制）？
2. **要不要同时给上游提 issue**：2026-11-10 的文档就写了「对外互动要用户点头」。上游 `Fei2411/DS-Bot` 或 DSH 本体——要不要我起一份说明这个缺口的 issue？
3. **编码清单**：先支持哪几个？现成的 `encoding.js` 已经支持 `utf-8` / `utf-8-bom` / `utf-16le` / `utf-16be` / `gb18030` / `gbk` / `big5`，建议就这七个。
4. **自动识别**：要不要在 read 失败时自动猜编码（`chardet` 已就位）并提示「这看起来是 GBK，要按 GBK 读吗」？建议**只提示、不自动**——猜错会制造新的坑。
5. **那条禁令**：用户 2026-11-08 的原话是「团队至今仍在用『禁止用 pwsh 写文件』这条禁令绕开编码问题，今天还因此写坏过测试文件」。他要的是**别再写坏**。「读对了」能避免一半（读到乱码就知道不对），但「写回不破坏原编码」才是根治——**这条禁令什么时候能撤，取决于上面第 1 题**。
