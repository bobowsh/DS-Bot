import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { checkRuntimeAssets, dataTree } from '../scripts/check-runtime-assets.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('checkRuntimeAssets', () => {
  let root
  let appDir
  const assets = { plugins: { 'dsh-aide': { runtimeAssets: ['@vscode/codicons', 'monaco-editor'] } } }

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-assets-'))
    appDir = join(root, 'app')
    const nm = join(appDir, 'build', 'data', 'profiles', 'ds-bot', 'node_modules')
    write(join(nm, 'dsh-aide', 'node_modules', '@vscode', 'codicons', 'package.json'), '{"name":"@vscode/codicons"}\n')
    // monaco-editor is deliberately left out: the failure case.
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('the data tree prefers the unpacked package over the build tree', () => {
    const unpacked = join(appDir, 'dist-pack', 'win-unpacked', 'data')
    write(join(unpacked, 'profiles', 'ds-bot', 'package.json'), '{}\n')
    assert.equal(dataTree(appDir), unpacked)
    rmSync(unpacked, { recursive: true, force: true })
    assert.equal(dataTree(appDir), join(appDir, 'build', 'data'))
  })

  test('a declared asset that is there passes', () => {
    const result = checkRuntimeAssets(appDir, { plugins: { 'dsh-aide': { runtimeAssets: ['@vscode/codicons'] } } })
    assert.equal(result.ok, true)
    assert.equal(result.checked, 1)
  })

  test('a declared asset that is missing fails and names it', () => {
    const result = checkRuntimeAssets(appDir, assets)
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, [{ plugin: 'dsh-aide', asset: 'monaco-editor' }])
    assert.equal(result.checked, 2)
  })
})
