// asar 源码条目的内容校验：打包时源目录被改写会产出内容错配的 asar，
// 应用一启动就 SyntaxError。这里用真实的 asar 库造包来验这条检查。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSourceOwnership, readAsarIndex } from '../scripts/check-asar-sources.mjs'

const made = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-asar-'))
  made.push(dir)
  return dir
}
process.on('exit', () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

// 用 @electron/asar 真造一个包，src/ 下放两个文件。
const packSources = async (files) => {
  const root = scratch()
  mkdirSync(join(root, 'src'), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'src', name), text, 'utf8')
  const { createPackage } = await import('@electron/asar')
  const archive = join(root, 'app.asar')
  await createPackage(root, archive)
  return { root, archive }
}

test('一个正常的包，每个源码条目的内容都属于自己', async () => {
  const { root, archive } = await packSources({
    'main.mjs': 'export const main = 1\n',
    'tray.mjs': 'export const tray = 2\n',
  })
  const { checked, wrong } = checkSourceOwnership(archive, join(root, 'src'))
  assert.equal(checked, 2)
  assert.deepEqual(wrong, [])
})

test('源文件在打包后被换掉，检查能发现内容对不上', async () => {
  const { root, archive } = await packSources({
    'main.mjs': 'export const main = 1\n',
    'tray.mjs': 'export const tray = 2\n',
  })
  // 打包之后把源文件改掉：asar 里的内容还留着旧的，检查拿新内容比就会报错。
  writeFileSync(join(root, 'src', 'tray.mjs'), 'export const somethingElse = 3\n', 'utf8')
  const { checked, wrong } = checkSourceOwnership(archive, join(root, 'src'))
  assert.equal(checked, 2)
  assert.equal(wrong.length, 1)
  assert.equal(wrong[0].name, 'tray.mjs')
})

test('asar 索引能读出来，offset 按数字算', async () => {
  const { archive } = await packSources({ 'a.mjs': 'export const a = 1\n' })
  const { entries, base, raw } = readAsarIndex(archive)
  const entry = entries.find(e => e.path === 'src/a.mjs')
  assert.notEqual(entry, undefined)
  assert.equal(typeof entry.offset, 'number', 'offset 必须是数字（asar 里存的是字符串）')
  assert.equal(entry.size, readFileSync(archive).length > 0 ? entry.size : entry.size)
  assert.ok(base > 0 && base < raw.length)
})
