// 给宿主 fs 层补 writeBytes：可重复执行的生成脚本。
//
// 为什么要有它：DSH 0.2.2-rc.1 的 FileSystem 只有 writeText（文本按 UTF-8 写死），
// 没有 writeBytes；非 UTF-8 文件（GBK/GB18030/Big5/UTF-16）因此改不了。插件层自己做
// 字节版原子写会形成第二套锁与原子发布，正是「写坏文件」的风险来源，所以走 patch：
// 复用宿主已有的 withLock + 原子写 + Windows DACL，沙箱围栏照拦。
//
// 方案：docs/plans/2026-11-14-fs-write-encoding-guard.md（用户 2026-11-14 拍板）。
//
//   node scripts/fs-writebytes-patch.mjs            # 应用到 app/node_modules 与 harness
//   node scripts/fs-writebytes-patch.mjs --check    # 只检查是否已应用，未应用则退出 1
//   node scripts/fs-writebytes-patch.mjs --revert   # 从 .orig 备份还原
//
// 幂等：以补丁特征串判断，已应用则跳过；重复执行结果一致。绝不手改 node_modules 了事。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = dirname(dirname(fileURLToPath(import.meta.url)))
const MARK = 'writeBytes'

// 每个包：文件 + 手指纹（未打补丁时必须在场，否则说明宿主版本变了，拒绝打）
const TARGETS = [
  {
    pkg: '@deepseek-ai/dsh-fs',
    file: 'lib/index.js',
    // 抽象类：与 writeText 同形的兜底实现，未实现的后端明确报错，不静默写 UTF-8。
    apply: (text) => replaceOnce(text, '\tget sandboxMode() {}', `	/**
	* Write raw bytes to a target, byte for byte, through the same atomic publication and
	* guards as writeText. The bytes are not decoded, their line endings are not normalized,
	* and a BOM is neither added nor removed: the caller decides the encoding.
	* @param target - resolved target to write.
	* @param bytes - the exact bytes to publish.
	* @param expected - the write intent guarding the write; omit for unconditional.
	* @param signal - aborts before atomic publication takes effect.
	* @returns the write outcome.
	*/
	async writeBytes(target, bytes, expected, signal) {
		throw new FsError("Raw byte writes are not supported by this filesystem provider.", "FS_IO_ERROR");
	}
	get sandboxMode() {}`),
  },
  {
    pkg: '@deepseek-ai/dsh-fs-local',
    file: 'lib/index.js',
    // 核心两处：原子写接受 Buffer；新增 writeBytes 走同一把锁与同一条发布路径。
    apply: (text) => {
      let out = replaceOnce(text, `		await handle.writeFile(content, {
			encoding: "utf8",
			...signal ? { signal } : {}
		});`, `		await handle.writeFile(content, {
			...Buffer.isBuffer(content) ? {} : { encoding: "utf8" },
			...signal ? { signal } : {}
		});`)
      out = replaceOnce(out, '\tasync editText(target, edit, expected, signal) {', `	async writeBytes(target, bytes, expected, signal) {
		return this.withLock(target.targetKey, async () => {
			const existing = await this.writeTarget(target, expected);
			await writeFileAtomic(target.targetKey, Buffer.from(bytes), existing?.mode, signal, this.internals, {
				displayPath: target.displayPath,
				createIfAbsent: expected?.kind === "createIfAbsent"
			});
			const after = await probe(target.targetKey);
			return {
				operation: existing ? "update" : "create",
				version: this.versionAfterWrite(after, target)
			};
		});
	}
	async editText(target, edit, expected, signal) {`)
      return out
    },
  },
  {
    pkg: '@deepseek-ai/dsh-fs-sandbox',
    file: 'lib/index.js',
    // 一行透传：围栏必须照样拦，read-only 预设照样拒。
    apply: (text) => replaceOnce(text, '\tasync editText(target, edit, expected, signal, sandboxPolicy) {', `	async writeBytes(target, bytes, expected, signal, sandboxPolicy) {
		return super.writeBytes(await this.checkedTarget(target, sandboxPolicy), bytes, expected, signal);
	}
	async editText(target, edit, expected, signal, sandboxPolicy) {`),
  },
]

function replaceOnce(text, needle, replacement) {
  const at = text.indexOf(needle)
  if (at === -1) throw new Error(`anchor not found: ${needle.slice(0, 60).replace(/\n/g, '\\n')}`)
  if (text.indexOf(needle, at + 1) !== -1) throw new Error(`anchor is ambiguous: ${needle.slice(0, 60).replace(/\n/g, '\\n')}`)
  return text.slice(0, at) + replacement + text.slice(at + needle.length)
}

// 已打补丁的判断：三个包里 writeBytes 作为方法定义出现。
const isPatched = (pkg, text) => new RegExp(`async ${MARK}\\(target,`).test(text)

/** Apply (or check) the patch in one node_modules root. */
export function run(root, { check = false, revert = true } = {}) {
  const report = []
  for (const target of TARGETS) {
    const dir = join(root, ...target.pkg.split('/'))
    const file = join(dir, target.file)
    const backup = `${file}.orig`
    if (!existsSync(file)) {
      report.push({ pkg: target.pkg, state: 'absent' })
      continue
    }
    const text = readFileSync(file, 'utf8')
    if (isPatched(target.pkg, text)) {
      report.push({ pkg: target.pkg, state: 'patched' })
      continue
    }
    if (check) {
      report.push({ pkg: target.pkg, state: 'unpatched' })
      continue
    }
    const patched = target.apply(text)
    // 备份只在第一次生成；--revert 用它还原。
    if (!existsSync(backup)) copyFileSync(file, backup)
    writeFileSync(file, patched, 'utf8')
    report.push({ pkg: target.pkg, state: 'applied', added: patched.split('\n').length - text.split('\n').length })
  }
  return report
}

/** Restore every target from its .orig backup. */
export function revert(root) {
  const report = []
  for (const target of TARGETS) {
    const file = join(root, ...target.pkg.split('/'), target.file)
    const backup = `${file}.orig`
    if (!existsSync(backup)) {
      report.push({ pkg: target.pkg, state: 'no-backup' })
      continue
    }
    copyFileSync(backup, file)
    report.push({ pkg: target.pkg, state: 'reverted' })
  }
  return report
}

/**
 * The two node_modules roots the pack must carry the patch in: the app's own (it ships in the
 * asar) and the harness test substitute. Exported so the pack and its tests name them alike.
 * @param {string} appDir - the app directory electron-builder is packing
 * @returns {string[]}
 */
export function defaultRoots(appDir) {
  return [join(appDir, 'node_modules'), join(appDir, '..', 'ds-bot', 'dev', 'harness', 'node_modules')]
}

/**
 * Apply the patch for a pack, and stop the pack when it cannot be applied.
 *
 * electron-builder runs this from its beforePack hook, so `npm run pack` and `npm run dist`
 * carry the byte channel without anyone remembering to run the script first: a package built
 * without it would ship a Host whose `writeBytes` is missing, and the shadow write/edit would
 * then refuse every non-UTF-8 file — a working feature turned into a silent half-install.
 *
 * A failure here throws on purpose: `run()` raises when an anchor moved (the Host version
 * changed under us), and a package that is simply not installed is reported as `absent`. Both
 * must stop the build rather than let an unpatched Host into the asar. The harness tree is the
 * test substitute and is skipped when absent; the app's own node_modules is not optional.
 * @param {string} appDir - the app directory electron-builder is packing
 * @param {string[]} [roots] - the node_modules roots to patch, defaultRoots(appDir) when omitted
 * @returns {{ label: string, report: { pkg: string, state: string }[] }[]} what each root carries
 */
export function patchForPack(appDir, roots = defaultRoots(appDir)) {
  const done = []
  for (const root of roots) {
    const label = root.includes('harness') ? 'harness' : 'app'
    if (!existsSync(root)) {
      if (label === 'app') throw new Error(`the pack needs ${root} to patch writeBytes into, and it is not there`)
      console.log(`LinkHarness: the writeBytes patch skips the harness test tree: no ${root}`)
      continue
    }
    const report = run(root) // throws when an anchor moved: the Host version changed, so stop the pack
    for (const row of report) {
      if (row.state === 'absent') throw new Error(`writeBytes could not reach ${row.pkg} in ${label}: the package is not installed`)
    }
    done.push({ label, report })
  }
  const landed = done.flatMap(({ label, report }) => report.filter(row => row.state === 'applied' || row.state === 'patched').map(row => `${label}/${row.pkg}`))
  console.log(`LinkHarness: the writeBytes patch is in place for ${String(landed.length)} package trees`)
  return done
}

const main = () => {
  const args = new Set(process.argv.slice(2))
  const check = args.has('--check')
  const doRevert = args.has('--revert')
  // app/ 与 harness 两份：打包进 asar 的那份 DSH，和单元测试跑的替身。
  const roots = [join(APP, 'node_modules'), join(APP, '..', 'ds-bot', 'dev', 'harness', 'node_modules')]
  let failed = false
  for (const root of roots) {
    const label = root.includes('harness') ? 'harness' : 'app'
    if (!existsSync(root)) {
      console.log(`${label}: 跳过（没有 ${root}）`)
      continue
    }
    const report = doRevert ? revert(root) : run(root, { check })
    for (const row of report) {
      const extra = row.added === undefined ? '' : ` (+${row.added} 行)`
      console.log(`${label}  ${row.pkg}  ${row.state}${extra}`)
      if (check && row.state === 'unpatched') failed = true
    }
  }
  if (failed) {
    console.log('\n有包未打 writeBytes 补丁：跑 node scripts/fs-writebytes-patch.mjs')
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
