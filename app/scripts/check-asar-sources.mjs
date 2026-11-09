// 校验 asar 里每个源码条目的内容是否真的属于它自己。
//
// 起因：2026-11-09 00:49 那次打包，asar 里 src/ 尾部连续 17 个文件的内容是别人的
// （tray.mjs 里装着 start/whale.js 的片段），应用一启动就 SyntaxError。size 与 offset
// 都正确、只有内容错配——打包时 app/src 正被另一个进程批量改写（品牌重命名），
// electron-builder 按记录的 size 写入、读到的是变化中的内容。
//
// 所以打包后必须逐个核对：asar 里那个文件的开头，必须等于磁盘上同名源文件的开头。
// 只查 src/ 的入口文件，因为它们体积小、错配时一定破坏语法，一启动就暴露。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 读 asar 头部（asar 3.x：第 4 字节起的 UInt32 是 pickle 长度，JSON 从第 16 字节开始，
 * 其中 offset 是字符串）。
 * @param {string} archive - asar 文件路径
 * @returns {{ entries: { path: string, size: number, offset: number }[], base: number, raw: Buffer }}
 */
export function readAsarIndex(archive) {
  const raw = readFileSync(archive)
  const headerPickleSize = raw.readUInt32LE(4)
  const jsonLen = raw.readUInt32LE(8)
  // The JSON is exactly jsonLen bytes, and the pickle may pad the block with NUL to a 4-byte
  // boundary — a build made by a different asar version can carry either. Cut at the last brace.
  const jsonText = raw.subarray(16, 16 + jsonLen).toString('utf8')
  const header = JSON.parse(jsonText.slice(0, jsonText.lastIndexOf('}') + 1))
  const walk = (node, prefix) => {
    const out = []
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files !== undefined) out.push(...walk(entry, path))
      else out.push({ path, size: Number(entry.size), offset: parseInt(entry.offset, 10), unpacked: entry.unpacked === true })
    }
    return out
  }
  return { entries: walk(header, ''), base: 8 + headerPickleSize, raw }
}

/**
 * 核对 asar 里每个 `src/*.(mjs|js)` 条目的内容是否以磁盘同名文件的开头为前缀。
 * @param {string} archive - asar 文件路径
 * @param {string} sourceDir - 打包时的源目录（app/src）
 * @returns {{ checked: number, wrong: { name: string, packed: number, source: number, head: string }[] }}
 */
export function checkSourceOwnership(archive, sourceDir) {
  const { entries, base, raw } = readAsarIndex(archive)
  const wrong = []
  let checked = 0
  for (const entry of entries) {
    if (entry.unpacked || !/^src\/[^/]+\.(mjs|js)$/u.test(entry.path)) continue
    const name = entry.path.replace(/^src\//u, '')
    const sourceFile = join(sourceDir, name)
    if (!existsSync(sourceFile)) continue
    checked++
    const source = readFileSync(sourceFile)
    const packed = raw.subarray(base + entry.offset, base + entry.offset + entry.size)
    const head = source.subarray(0, Math.min(32, source.length))
    const ok = packed.length >= head.length && packed.subarray(0, head.length).equals(head)
    if (!ok) {
      wrong.push({
        name,
        packed: packed.length,
        source: source.length,
        head: packed.subarray(0, 46).toString('utf8').replace(/\n/gu, '\\n'),
      })
    }
  }
  return { checked, wrong }
}

/**
 * 命令行入口：`node scripts/check-asar-sources.mjs [asar] [sourceDir]`。
 * 非零退出表示 asar 里有条目的内容是错的。
 * @param {string[]} argv - 参数（asar 路径，源目录）
 * @returns {number} 退出码
 */
export function main(argv) {
  const archive = argv[0] ?? join('dist-pack', 'win-unpacked', 'resources', 'app.asar')
  const sourceDir = argv[1] ?? join('src')
  if (!existsSync(archive)) {
    console.error(`check-asar-sources: 没有这个 asar：${archive}（先跑 npm run pack）`)
    return 2
  }
  const { checked, wrong } = checkSourceOwnership(archive, sourceDir)
  if (wrong.length === 0) {
    console.log(`check-asar-sources: 检查 ${checked} 个源码条目，内容全部正确`)
    return 0
  }
  console.error(`check-asar-sources: 检查 ${checked} 个源码条目，其中 ${wrong.length} 个内容不属于自己：`)
  for (const row of wrong) {
    console.error(`  ${row.name}  asar=${row.packed} 源=${row.source}  实际开头: ${row.head}`)
  }
  console.error('\n这通常意味着打包时源目录正被另一个进程改写。等写入结束后重打包再验。')
  return 1
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  process.exit(main(process.argv.slice(2)))
}
