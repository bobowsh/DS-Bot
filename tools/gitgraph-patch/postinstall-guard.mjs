#!/usr/bin/env node
/**
 * postinstall 钩子的包装器：调用同目录的 gitgraph 补丁脚本，无论成败都以 0 退出。
 *
 * 为什么：profile 的 postinstall 会在每次 pnpm install / pnpm add 后运行，
 * 包括插件管理器重装 gitgraph 的时候 —— 这正是我们要补回来的时机。
 * 但补丁失败（插件升级改了产物）绝不能拖垮整个安装流程，
 * 所以这里吞掉退出码，只把结果写进日志。
 *
 * 这个脚本与 apply-gitgraph-patch.mjs 同目录：靠 import.meta.url 定位，
 * 不写死任何绝对路径。日志落仓库根的 tmp/gitgraph-patch/，不进版本库。
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与补丁脚本同目录。 */
const TOOL_ROOT = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(TOOL_ROOT, 'apply-gitgraph-patch.mjs')
/** 日志落仓库根的 tmp/，是运行时产物，由 .gitignore 覆盖。 */
const REPO_ROOT = resolve(TOOL_ROOT, '..', '..')
const LOG_DIR = join(REPO_ROOT, 'tmp', 'gitgraph-patch')
const LOG = join(LOG_DIR, 'postinstall.log')

const stamp = new Date().toISOString()
let line
try {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 60_000 })
  const out = ((result.stdout || '') + (result.stderr || '')).trim().replace(/\s+/gu, ' ')
  line = `[${stamp}] exit=${result.status} ${out || '(no output)'}`
} catch (error) {
  line = `[${stamp}] wrapper-error ${error instanceof Error ? error.message : String(error)}`
}
try {
  mkdirSync(LOG_DIR, { recursive: true })
  appendFileSync(LOG, line + '\n', 'utf8')
} catch { /* 日志写不进去也不能挡住安装 */ }
// 永不阻塞安装
process.exit(0)
