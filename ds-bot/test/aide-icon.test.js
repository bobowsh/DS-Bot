// The AIDE entry: the mark of Visual Studio Code, redrawn as vectors in the editor's blue,
// and the two places it sits — the foot of our own Bot column and the foot of the host's
// sidebar, where the account button lives.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const read = file => readFileSync(join(PLUGIN, file), 'utf8')

test('the AIDE mark is the editor\'s blue, drawn as vectors', () => {
  const icons = read('src/client/icons.js')
  assert.ok(icons.includes('export const AideIcon'), 'AideIcon 存在')
  const block = icons.slice(icons.indexOf('export const AideIcon'), icons.indexOf('export const AideIcon') + 900)
  assert.ok(block.includes('var(--bt-vscode)'), '用的是品牌色变量')
  assert.ok(block.includes("h('path'"), '是矢量路径，不是位图')
  assert.ok(!block.includes('data:image/png'), '不内嵌位图')
  // 品牌色先成为变量，才准被用到。
  assert.ok(read('src/client/styles.js').includes('--bt-vscode:#0098ff'), '变量在基础表里')
})

test('the plugin ships the same mark as its own icon', () => {
  // dsh-aide 的 icon.svg 与我们画的形状是同一份：插件列表和页脚按钮说的是同一个东西。
  const icon = join(PLUGIN, '..', '..', 'dsh-plugins-dev', 'dsh-aide', 'icon.svg')
  const svg = readFileSync(icon, 'utf8')
  assert.ok(svg.includes('#0098FF'), '打包源里的图标也是 VS Code 的蓝')
  assert.ok(svg.includes('<path'), '打包源里的图标是矢量')
  const icons = read('src/client/icons.js')
  for (const d of [...svg.matchAll(/d="([^"]+)"/gu)].map(m => m[1])) {
    assert.ok(icons.includes(d), 'DS Bot 侧用的是同一份路径')
  }
})

test('the entry sits in the foot of the host sidebar too', () => {
  // 宿主的侧栏页脚有一个 slot（sidebar.footer.action），我们把按钮注册进去，
  // 它就落在 DSH 界面的 LinkHarness / 导入会话 那一行里。
  const index = read('src/client/index.js')
  assert.ok(index.includes("'sidebar.footer.action'"), '注册在宿主的侧栏页脚 slot 上')
  assert.ok(index.includes('AideFooterButton'), '按钮组件注册在里面')
  const sidebar = read('src/client/sidebar.js')
  assert.ok(sidebar.includes('AideButton'), '我们自己的列里也有同一个按钮')
})
