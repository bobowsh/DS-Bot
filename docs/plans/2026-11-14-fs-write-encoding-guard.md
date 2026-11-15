# read / write / edit 的编码支持：B 方案 + writeBytes patch

Refs #3

- 日期：2026-11-14。本文替代并吸收 `2026-11-14-file-encoding-writebytes.md` 的调研部分
  （那份的「三条路」分析已并入本文第 3 节）。
- 状态：**方案已拍板**（用户 2026-11-14：「B 方案 + writeBytes patch，两个都要」），待实现。
- 参考来源：`E:\work\dsh-desktop-me` 的提交 `359594d52`、`96a410a40`（打 patch 给宿主 fs 层
  加编码能力）及其验收脚本 `scripts/test-encoding.mjs`。**只借它的 patch 思路，不抄代码**：
  它针对 0.1.0-rc.8，我们是 0.2.2-rc.1，签名与落盘实现都变过，不能直接套；且它的
  `detectEncoding` 与工具 `encoding` 参数我们插件层已有等价物，抄了就是重复实现。

## 一、目标

`read` / `write` / `edit` 三个文件工具支持编码参数与自动识别，**写回时保持原文件的编码和
BOM**，非 UTF-8 文件不被写坏。终极目的：取消「禁止用 pwsh 写文件」那条团队禁令——
目前它存在的唯一理由就是写会把非 UTF-8 文件写坏。

**口径（用户 2026-11-14 拍板）**：

| 决策点 | 拍板 |
|---|---|
| 编码探测与编解码 | **在插件层**（`ds-bot/src/host/encoding.js`，已有） |
| 写回原编码的通道 | **给宿主 fs 层打 `writeBytes` patch** |
| 宿主现有 `write`/`edit` 工具 | **继续保持 UTF-8 行为不变** |
| patch 落地位置 | `app/` 侧打包进 asar 的那份 DSH；harness 测试替身同步一份 |

## 二、现状（全部实测核实，非推断）

### 2.1 已完成（读这一半，2026-11-10 合入 dev）

| 能力 | 位置 |
|---|---|
| 影子 `read` 的 `encoding` 参数 | `ds-bot/src/host/fs-read-tool.js:89` |
| 自动识别（BOM → 严格 UTF-8 → chardet → GB18030 兜底） | `ds-bot/src/host/encoding.js:58` `detectEncodingFromBytes` |
| 解码 / 编码 / 编码名解析 | 同文件 `:98` `decodeBytes`、`:116` `encodeText`、`:132` `namedEncoding` |
| 读字节只走 `ctx.fs`（沙箱围栏不破） | `ds-bot/src/host/fs-encoding.js` `readBytesThrough` |
| 支持的编码 | `utf-8 / utf-8-bom / utf-16le / utf-16be / gb18030 / gbk / big5`（`encoding.js:24`） |

依赖 `chardet` + `iconv-lite` 已在 `ds-bot/package.json`。

### 2.2 缺口（写这一半）

宿主 `@deepseek-ai/dsh-tool-fs` 三个工具 UTF-8 写死：

| 工具 | 位置 | 原话 |
|---|---|---|
| `read` | `types/read.d.ts:2` | *"Model-facing **UTF-8** read"* |
| `write` | `types/write.d.ts:17` | 参数写死 `{file_path, content}` |
| `edit` | `types/edit.d.ts:24` | 参数写死 `{file_path, old_string, new_string, replace_all}` |

宿主 `FileSystem`（`@deepseek-ai/dsh-fs`）**只有 `writeText(target, content: string, ...)`，
没有 `writeBytes`**（`dsh-fs/lib/types/index.d.ts:237`）。**读字节已有**（`readBytes` /
`readByteRange`，`dsh-fs-local:890/896`），**写字节没有**——这就是缺口的准确范围。

写盘落点：`dsh-fs-local/lib/index.js:535` 的 `writeFileAtomic` 内部
`:567` `await handle.writeFile(content, { encoding: "utf8" })` —— **写盘编码写死 utf8**。
传 Buffer 进 `writeText` 会被当 UTF-8 字符串重新编码，字节全变（实测复刻过，见
`2026-11-14-file-encoding-writebytes.md` 2.3 节）。

npm 上最新的 `@deepseek-ai/dsh-fs-local@0.2.2-rc.3` 也没有 `writeBytes`——上游未补。

### 2.3 非 UTF-8 文件现在被怎么对待

宿主对 GBK/GB18030/Big5 报 `FS_NOT_TEXT`（invalid UTF-8 text），UTF-16 因含 NUL 被判
binary。**不是乱码，是报错**——但用户依然干不了活：改不了 GBK 文件，产出不了 GBK 文件。

## 三、为什么必须打 patch（三条路的实证）

| 路 | 做法 | 结论 |
|---|---|---|
| A | 插件里用 Node `fs` 直接写字节 | **否**：绕过 `ctx.fs` = 绕过沙箱围栏，「仅可查看」的 Bot 照样能写——安全回归，2026-11-10 那版就这么栽的，已删除 |
| B | 借 `ctx.fs.writeText` 传字符串/Buffer | **否**：非 UTF-8 字节不是字符串；`writeFileAtomic` 写死 utf8，字节全变 |
| **C（拍板）** | **打 patch 给宿主 fs 层补 `writeBytes`** | **是**：与 `readBytes` 对称；沙箱围栏、原子写（同目录临时文件 + 替换 + Windows DACL 保留）、锁全部复用宿主那一份，**不会出现两套原子写打架写坏文件** |

第三条正是 dsh-desktop-me 走过的路（用户自己在那边打过同类 patch），先例在。**不在插件里
自研字节版原子写**——`dsh-fs-local` 的原子写不是导出物，复制一份随宿主升级腐坏，且两套
锁并存正是「文件写坏」的风险来源。

## 四、writeBytes patch 的改动面（4 处，已在 0.2.2-rc.1 上核实）

| # | 包 | 改动 | 量 |
|---|---|---|---|
| 1 | `@deepseek-ai/dsh-fs` | `FileSystem` 抽象类加 `writeBytes(target, bytes, expected?, signal?)`，与 `writeText` 同签名形态，`content` 换 `Uint8Array`；类型声明同步 | 小 |
| 2 | `@deepseek-ai/dsh-fs-local` | 实现：走已有 `withLock` + `writeFileAtomic`，**`writeFileAtomic` 的 `:566-568` 让它接受 Buffer（Buffer 时跳过 `encoding: "utf8"`）**——原子写、DACL、锁全复用现成的 | **核心，小** |
| 3 | `@deepseek-ai/dsh-fs-sandbox` | 透传：`writeBytes` 也过一遍 `checkedTarget(target, sandboxPolicy)`（`:125` 的 `writeText` 同款一行）——**围栏必须照样生效** | 一行 |
| 4 | `@deepseek-ai/dsh-tool-fs` | **不改**。宿主 `write`/`edit` 工具保持 UTF-8 行为（用户拍板口径），我们的影子工具自己调 `ctx.fs.writeBytes` | 0 |

**语义**（与 `readBytes` 对称，吸收旧文档第九节）：

1. **原样落盘**：字节一个不改——不解码、不规范化换行、不加/去 BOM（BOM 由插件层用
   `encodeText` 的 `keepBom` 处理好再交进来）。
2. **原子发布**：与 `writeText` 同一套机制（同目录临时文件 → 替换），Windows 上保留
   目标文件的 DACL。
3. **沙箱围栏**：sandbox 后端的 `checkedTarget` 照拦，`read-only` 预设照样拒。
4. **观察语义**：沿用 `replaceIfVersion` / `createIfAbsent`，版本不符 `FS_STALE_VERSION`。
5. **返回**：与 `writeText` 同形的 `WriteOutcome`（字节写无文本 `before`/`after` 时置空）。

## 五、B 方案：插件层的影子 write / edit

沿用已合入的影子 `read` 套路（`ds-bot/src/host/tools.js:88` 的 `rt.scopeShadows`，
Bot 作用域遮蔽宿主同名工具、先委托后接管）：

- **参数**：在宿主参数基础上加 `encoding`（与 `read` 同名同义，`namedEncoding()` 现成）。
- **执行逻辑**：

| 目标文件 | 显式 encoding | 行为 |
|---|---|---|
| 不存在 | 未指定 / utf-8 | 委托宿主 `write`（新建默认 UTF-8，行为一字不变） |
| 不存在 | 非 UTF-8 | 拒绝并报缺口（新建非 UTF-8 也走 `writeBytes`：探测不可用，`encodeText` 编好后写入） |
| 存在，UTF-8（含 BOM） | 任意 | **委托宿主，行为一字不变** |
| 存在，非 UTF-8 | 任意 | **`ctx.fs.writeBytes` 可用 → `encodeText` 按原编码编好字节 + BOM → 写回原编码**；不可用（patch 未生效）→ **拒绝并说人话**（兜底分支） |

- `edit` 同套路：非 UTF-8 时用 `decodeBytes` 读出 → 字面替换 → `encodeText` 编回 →
  `writeBytes` 落盘；patch 不可用则拒绝。
- **全程只用 `ctx.fs`，不许出现 Node 的 `fs`**（PR #33 的安全修复立的规矩，测试钉住）。
- **不抄 dsh-desktop-me 的 `detectEncoding` 和工具 `encoding` 参数 patch**——插件层已有
  等价物，patch 只补 `writeBytes` 这一个缺口。

**错误码**：ds-bot 自己的 `FS_ENCODING_UNSUPPORTED`（不混入宿主 `FS_ERROR_CODES`），
message 说人话：这个文件是什么编码、为什么不能写、要先转码还是等 patch。

## 六、patch 的落地与可重复性

- **落地位置**：`app/` 侧——打包进 asar 的那份 DSH（`app/node_modules/@deepseek-ai/*`
  0.2.2-rc.1），用户机上生效。
- **应用机制**：可重复执行的**生成脚本**（从 npm 干净包出发，产出 patch 并应用到
  `app/node_modules`），脚本进仓库（`app/scripts/`），**不许直接手改 node_modules 了事**。
- **harness 同步**：`ds-bot/dev/harness` 那份是测试替身，**同步应用同一 patch**，否则
  单元测试调不到 `writeBytes`。`npm run harness` 重装后需重跑生成脚本。
- dsh-desktop-me 的先例：它把 patch 放 `patches/` 目录并从 `node_modules` 生成
  （`git show 96a410a40` 可见四个 `.patch` 文件）。我们做法相同，但针对 0.2.2-rc.1
  重新适配，不直接套它的 0.1.0-rc.8 patch。

## 七、验收标准

基准采用 dsh-desktop-me `scripts/test-encoding.mjs`（非空 130 行、wc -l 142；26 处 `check(`
判据）的对应子集，逐项映射到我们的实现：

1. GB18030 文件自动识别读出（影子 `read`，已实现，回归）
2. GB18030 写回后字节仍是 GB18030（影子 `write` + patch）
3. GB18030 编辑后字节仍是 GB18030（影子 `edit` + patch）
4. 显式 `encoding: 'gbk'` 读取正确（已实现，回归）
5. UTF-16LE 自动识别 + 读出正确（已实现，回归）
6. UTF-16LE 编辑后 **BOM 保留**（`encodeText` 的 `keepBom`）
7. UTF-8 BOM 文件编辑后 BOM 保留
8. 新建文件显式 `encoding: 'utf-16le'` 带 BOM
9. Big5 自动探测读出（已实现，回归）
10. 二进制文件仍被拒（`FS_NOT_TEXT`）
11. 不支持的编码名明确报错，不静默按 UTF-8
12. **纯 UTF-8 文件行为一字不变**（沙箱、行号、limit 全在宿主手里）

我们自己的加项：

13. **沙箱围栏不破**：影子工具只用 `ctx.fs`，源码里不出现 Node 的 `fs`（用例钉住，
    与影子 `read` 的测试同款）。
14. **patch 未生效时**（干净宿主上跑）：非 UTF-8 写入被明确拒绝并说人话——不是崩溃、
    不是静默写坏（兜底分支的用例）。
15. patch 的生成脚本可重复执行：删掉 `app/node_modules` 重装后重跑脚本，产物一致。

门禁三项（`npm test`、`node scripts/build-client.mjs --check`、`npm run lint`）与基线
对比不新增失败。

**端到端**：真机构建 GBK 文件 → 影子 `write` 改它 → 读回字节仍是 GB18030、BOM 保留
（`iconv.decode` 比对）。装机环境的这项跑不了就如实标「未验证 + 解除条件」。

## 八、已拍板决策（逐条，来源见群聊记录 2026-11-14）

1. 编码探测与编解码在插件层，不抄 dsh-desktop-me 的 `detectEncoding` patch。
2. 给宿主 fs 层打 `writeBytes` patch；**宿主现有文本写入工具继续保持 UTF-8 行为**
   （`dsh-tool-fs` 不改）。
3. patch 走 `app/` 侧，可重复生成，harness 同步。
4. 不改 DSH 其它行为；沙箱围栏不得破。
5. 不 fork DSH 源码仓库；dsh-desktop-me 的 patch 思路可参考但代码不照抄（版本不同）。
6. 不在插件里自研字节版原子写（两套锁打架 = 写坏文件，正是要消灭的问题）。

## 九、开放问题（留给用户拍板）

1. **patch 适配工作量**：dsh-desktop-me 的 1135 行里 `dsh-fs-local` 占 506 行是因为它连
   探测/解码都塞进了宿主层；我们只要 `writeBytes` 一条通路，估计 `dsh-fs-local` 的改动
   在几十行量级（`writeFileAtomic` 接受 Buffer + 一个新方法），但生成脚本与 harness 同步
   的工程量另计。**这个估算在动手前先做一个探针验证**（对干净包打一次最小 patch 跑通
   `writeBytes`），有实测数字再定。
2. harness 同步范围：只 `dsh-fs` / `dsh-fs-local` / `dsh-fs-sandbox` 三个包，还是连同
   `dsh-tool-fs`（我们不 patch 它，但 harness 里版本要钉住防止漂移）。
3. 验收顺序：先 harness 单元测试全绿再装机，还是直接真机端到端（用户机器上有现成的
   GBK 样本路径可复用 `2026-11-14-file-encoding-writebytes.md` 2.3 节的样本清单）。

## 十、落地步骤

1. 写 patch 生成脚本（`app/scripts/`，从干净包产出三个包的 patch 并应用）
2. `dsh-fs` 抽象类 + 类型声明加 `writeBytes`
3. `dsh-fs-local` 实现（`writeFileAtomic` 接受 Buffer + `writeBytes` 方法走 `withLock`）
4. `dsh-fs-sandbox` 透传（`checkedTarget` 围栏照拦）
5. harness 同步应用 patch
6. 插件层影子 `write` / `edit`（非 UTF-8 → `encodeText` → `writeBytes`；patch 不可用 → 拒绝）
7. 测试（`ds-bot/test/fs-write-tool.test.js` 等，覆盖第七节 15 项）
8. 门禁三项 + 真机端到端
9. 走分支 + PR（base `dev`），正文含本方案链接与 `Refs #3`

## 附：本文吸收的前序文档

- `docs/plans/2026-11-14-file-encoding-writebytes.md`（wc -l 267 行、非空 192 行）——调研与「三条路」实证，
  其缺口材料（第九节「给宿主的缺口材料」）保留在原文件，本文第五、六节吸收其结论。
  那份文档的 `Refs #45` 是笔误（#45 是群聊工具区，与编码无关），正确关联是 #3。
- `docs/plans/2026-11-10-fs-encoding-sandbox.md` —— 读侧影子工具的原始方案。
