#!/usr/bin/env node
/**
 * gitgraph 分支 chip 增强补丁：让 Bot 的活跃会话也显示分支选择器。
 *
 * 上游 @linxin666/dsh-client-ui-git-graph 只在「空白会话」的 hero 阶段渲染分支
 * chip，产物注释里写死了 `Active sessions intentionally expose no branch-selection
 * control.`。DS Bot 里每个 Bot 会话都是活跃会话，所以那个 chip 永远不出现。
 *
 * 这个脚本在**编译产物** lib/client.js 上做定点字符串替换，不碰源码，幂等可重复。
 * 为什么改产物而不是源码：该插件只以 npm 包发布（作者名下没有独立源码仓库），
 * 装到 profile 的就是 lib/ 产物；插件管理器重装后 postinstall 会再打一次。
 *
 * 用法：
 *   node apply-gitgraph-patch.mjs                    # 应用（已打过则跳过）
 *   node apply-gitgraph-patch.mjs --check            # 只检查，不写盘
 *   node apply-gitgraph-patch.mjs --revert           # 用原厂备份还原
 *   node apply-gitgraph-patch.mjs --dir <插件目录>   # 指定插件目录
 *
 * 插件目录的推导（优先级从高到低）：
 *   --dir 参数
 *   $GITGRAPH_PLUGIN_DIR
 *   $DSH_PROFILE_DIR/node_modules/<包名>
 *   ~/.dsh/profiles/ds-bot/node_modules/<包名>
 * 都没有就报错并打印用法，绝不静默回退到某台机器写死的路径。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包名，也是它在 profile 的 node_modules 下的相对路径。 */
const PACKAGE_NAME = '@linxin666/dsh-client-ui-git-graph'
/** profile 的名字，~/.dsh 兜底路径用得上。 */
const PROFILE_NAME = 'ds-bot'
/**
 * 备份与日志的落地处：仓库根的 tmp/gitgraph-patch/。
 * 那是运行时产物，由 .gitignore 覆盖，绝不进版本库。
 */
const TOOL_ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TOOL_ROOT, '..', '..')
const WORK_DIR = join(REPO_ROOT, 'tmp', 'gitgraph-patch')
const BACKUP_DIR = join(WORK_DIR, 'backup')

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const REVERT = args.includes('--revert')
const dirArg = args.indexOf('--dir')

/**
 * 解析被补丁的插件目录。
 * @returns {string} 插件根目录的绝对路径
 */
function resolvePluginDir() {
  if (dirArg >= 0 && args[dirArg + 1]) return resolve(args[dirArg + 1])
  if (process.env.GITGRAPH_PLUGIN_DIR) return resolve(process.env.GITGRAPH_PLUGIN_DIR)
  if (process.env.DSH_PROFILE_DIR) return join(resolve(process.env.DSH_PROFILE_DIR), 'node_modules', PACKAGE_NAME)
  return join(homedir(), '.dsh', 'profiles', PROFILE_NAME, 'node_modules', PACKAGE_NAME)
}

const PLUGIN_DIR = resolvePluginDir()
const CLIENT = join(PLUGIN_DIR, 'lib', 'client.js')
const PKG = join(PLUGIN_DIR, 'package.json')

/**
 * 替换规则：每条都要在产物里唯一命中。
 * 前项是编译后的原样文本，后项是打过补丁的样子。
 * 插件升级后这些规则会全部失配——那时要按新产物的 diff 重新对，见 README。
 *
 * 四类门控（产物里都用 heroSeat 判，补丁后改判 seated）：
 *   1. 首屏取 git 状态的 effect 与它的依赖数组
 *   2. heroRow 定位与刷新（订阅 + focus）effect
 *   3. 打开分支弹层时拉分支列表的 effect 与依赖数组
 *   4. 渲染出口 —— chip 不出现的直接原因
 */
const RULES = [
  ['新增 seated 变量（heroSeat 保留原义，活跃会话走 activeSeat）',
   'const heroSeat = sessionSnapshot?.blank === true && (sessionSnapshot.openState === "open" || blankSession === true);',
   'const heroSeat = sessionSnapshot?.blank === true && (sessionSnapshot.openState === "open" || blankSession === true);\n\t\tconst activeSeat = !heroSeat && sessionId !== void 0;\n\t\tconst seated = heroSeat || activeSeat;'],
  ['首屏取 git 状态的 effect 门控',
   'if (!heroSeat || repo === void 0 || repo === null) {',
   'if (!seated || repo === void 0 || repo === null) {'],
  ['首屏取 git 状态的依赖数组',
   '}, [heroSeat, repo !== void 0 && repo !== null]);',
   '}, [seated, repo !== void 0 && repo !== null]);'],
  ['heroRow 定位 effect 的门控',
   'if (!heroSeat || heroRow === null) return;',
   'if (!seated || heroRow === null) return;'],
  ['刷新 effect（锚定 refetch，避免误伤同形的另一处）',
   '\t\t\t\tif (!heroSeat) return void 0;\n\t\t\t\treturn refetch();\n\t\t\t}, [heroSeat, refetch]);',
   '\t\t\t\tif (!seated) return void 0;\n\t\t\t\treturn refetch();\n\t\t\t}, [seated, refetch]);'],
  ['订阅 + focus effect（锚定 subscribeChanges）',
   '\t\t\t\tif (!heroSeat) return void 0;\n\t\t\t\tconst unsubscribe = props.subscribeChanges(sessionId, () => {',
   '\t\t\t\tif (!seated) return void 0;\n\t\t\t\tconst unsubscribe = props.subscribeChanges(sessionId, () => {'],
  ['分支列表 effect 的门控',
   '\t\t\t\tif (!heroSeat || !branchOpen) return void 0;',
   '\t\t\t\tif (!seated || !branchOpen) return void 0;'],
  ['订阅 effect 的依赖数组',
   '\t\t\t}, [\n\t\t\t\theroSeat,\n\t\t\t\tprops.subscribeChanges,\n\t\t\t\tsessionId,\n\t\t\t\trefetch\n\t\t\t]);',
   '\t\t\t}, [\n\t\t\t\tseated,\n\t\t\t\tprops.subscribeChanges,\n\t\t\t\tsessionId,\n\t\t\t\trefetch\n\t\t\t]);'],
  ['分支列表 effect 的依赖数组',
   '\t\t\t}, [\n\t\t\t\theroSeat,\n\t\t\t\tbranchOpen,\n\t\t\t\tprops.branches,\n\t\t\t\tsessionId\n\t\t\t]);',
   '\t\t\t}, [\n\t\t\t\tseated,\n\t\t\t\tbranchOpen,\n\t\t\t\tprops.branches,\n\t\t\t\tsessionId\n\t\t\t]);'],
  ['渲染出口（chip 不出现的直接原因）',
   'if (!heroSeat || repo === void 0 || repo === null) return null;',
   'if (!seated || repo === void 0 || repo === null) return null;'],
]

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 12)
const versionOf = () => {
  try { return JSON.parse(readFileSync(PKG, 'utf8')).version } catch { return 'unknown' }
}

if (!existsSync(CLIENT)) {
  console.error('找不到 ' + CLIENT)
  console.error('用 --dir 指定插件目录，或设置 GITGRAPH_PLUGIN_DIR / DSH_PROFILE_DIR。')
  process.exit(1)
}

const version = versionOf()
const original = readFileSync(CLIENT, 'utf8')

if (REVERT) {
  let found
  try {
    const pick = readdirSync(BACKUP_DIR)
      .filter(name => name.startsWith('client.js.' + version + '.') && name.endsWith('.orig'))
      .sort()
      .pop()
    if (pick !== undefined) found = join(BACKUP_DIR, pick)
  } catch { /* 没有备份目录就是没有可还原的 */ }
  if (found === undefined) {
    console.error('没有 ' + version + ' 的原厂备份（' + BACKUP_DIR + '），请用插件管理器重装该插件')
    process.exit(1)
  }
  if (CHECK_ONLY) {
    console.log('[check] 可还原自: ' + found)
    process.exit(0)
  }
  copyFileSync(found, CLIENT)
  console.log('已还原: ' + found)
  process.exit(0)
}

// 幂等的判断点：打过补丁的产物一定带着这一行。
if (original.includes('const seated = heroSeat || activeSeat;')) {
  console.log('已打过补丁（version ' + version + '），无需重复。sha256[:12]=' + hash(original))
  process.exit(0)
}

let patched = original
const missing = []
for (const [label, from, to] of RULES) {
  const hits = patched.split(from).length - 1
  if (hits === 0) { missing.push(label); continue }
  if (hits > 1) {
    console.error('规则「' + label + '」匹配 ' + hits + ' 处，不唯一，停止（产物与预期不符）')
    process.exit(1)
  }
  patched = patched.replace(from, to)
}

if (missing.length > 0) {
  console.error('以下规则未命中，产物与预期不符（插件可能已升级），未应用：')
  for (const label of missing) console.error('  - ' + label)
  console.error('插件版本: ' + version)
  console.error('插件目录: ' + PLUGIN_DIR)
  console.error('插件升级后请按 README 重新对 diff，更新 RULES。')
  process.exit(1)
}

if (CHECK_ONLY) {
  console.log('[check] ' + RULES.length + ' 条规则全部命中，可应用。版本 ' + version)
  console.log('  原厂 ' + hash(original) + '  补丁 ' + hash(patched))
  console.log('  插件目录 ' + PLUGIN_DIR)
  process.exit(0)
}

mkdirSync(BACKUP_DIR, { recursive: true })
const backup = join(BACKUP_DIR, 'client.js.' + version + '.' + hash(original) + '.orig')
if (!existsSync(backup)) {
  copyFileSync(CLIENT, backup)
  console.log('备份: ' + backup)
}
writeFileSync(CLIENT, patched, 'utf8')
console.log('补丁已应用')
console.log('  版本 ' + version)
console.log('  原厂 ' + hash(original) + ' -> 补丁 ' + hash(patched))
console.log('  体积 ' + original.length + ' -> ' + patched.length + ' 字节')
console.log('  插件目录 ' + PLUGIN_DIR)
console.log('重启 DSH 后生效。还原: node ' + process.argv[1] + ' --revert')
