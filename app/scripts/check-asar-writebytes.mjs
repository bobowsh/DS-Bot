// 校验打出来的 asar 里，宿主 fs 三包真的带 writeBytes 补丁。
//
// 为什么单独查这一条：影子 write/edit 靠 ctx.fs.writeBytes 把非 UTF-8 文件按原编码写回，
// 而 writeBytes 是 app/scripts/fs-writebytes-patch.mjs 给宿主包打的补丁、不是 DSH 自带的。
// 补丁由 beforePack 里的 patchForPack 自动应用（PR #72），但「自动应用」不等于「真的进了包」——
// 万一 extraFiles/files 没把打过补丁的 node_modules 打进 asar，装机版就还是写不了非 UTF-8。
// 这一条直接在产物上核对，不装机就能发现。
//
//   node scripts/check-asar-writebytes.mjs [asar]
// 非零退出表示 asar 里有宿主包不带补丁。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAsarIndex } from './check-asar-sources.mjs'

/** 影子 write/edit 依赖 writeBytes 的三个宿主包，在 asar 里的路径。 */
export const HOST_PACKAGES = [
  "node_modules/@deepseek-ai/dsh-fs/lib/index.js",
  "node_modules/@deepseek-ai/dsh-fs-local/lib/index.js",
  "node_modules/@deepseek-ai/dsh-fs-sandbox/lib/index.js",
]

/** 补丁落地的特征：writeBytes 作为方法定义出现（与生成脚本的判据一致）。 */
const PATCHED = /async writeBytes\(target,/u

/**
 * 从已解析的 asar 索引里判断每个宿主包是否带补丁。
 * @param {{ entries: { path: string, size: number, offset: number }[], base: number, raw: Buffer }} index
 * @returns {{ path: string, present: boolean, patched: boolean }[]}
 */
export function checkWriteBytesPatched(index) {
  const { entries, base, raw } = index
  return HOST_PACKAGES.map((path) => {
    const entry = entries.find((x) => x.path === path)
    if (entry === undefined) return { path, present: false, patched: false }
    const body = raw.subarray(base + entry.offset, base + entry.offset + entry.size).toString('utf8')
    return { path, present: true, patched: PATCHED.test(body) }
  })
}

/**
 * 命令行入口。
 * @param {string[]} argv
 * @returns {number} 退出码
 */
export function main(argv) {
  const archive = argv[0] ?? join('dist-pack', 'win-unpacked', 'resources', 'app.asar')
  if (!existsSync(archive)) {
    console.error(`check-asar-writebytes: 没有这个 asar：${archive}（先跑 npm run pack）`)
    return 2
  }
  const rows = checkWriteBytesPatched(readAsarIndex(archive))
  for (const row of rows) {
    console.log(`  ${row.path}: ${row.present ? (row.patched ? 'writeBytes补丁=true' : 'writeBytes补丁=false') : '不在 asar'}`)
  }
  const bad = rows.filter(row => !row.patched)
  if (bad.length === 0) {
    console.log(`check-asar-writebytes: asar 里 ${String(rows.length)} 个宿主包都带 writeBytes 补丁`)
    return 0
  }
  console.error(`check-asar-writebytes: ${String(bad.length)} 个宿主包不带补丁——装机版会写不了非 UTF-8 文件`)
  return 1
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  process.exit(main(process.argv.slice(2)))
}
