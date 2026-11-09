// The language servers the app ships: they are native programs (or scripts that need a node),
// so they travel as plain files under the data directory's lsp/ folder and go on the Host's
// PATH. The build never reaches the network for them: the source is the local server folder.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { bundledLspDir, defaultLspSrc, manifestLanguageServers, prepareLanguageServers } from '../scripts/factory-lsp-pack.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('the language servers the build carries', () => {
  let root
  let appDir
  let lspSrc

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-lsp-'))
    appDir = join(root, 'app')
    lspSrc = join(root, 'dsh-lsp')
    write(join(lspSrc, 'clangd', 'bin', 'clangd.exe'), 'binary\n')
    write(join(lspSrc, 'clangd', 'lib', 'clang', '23', 'include', 'stdio.h'), 'header\n')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('a server is copied whole into the data tree', async () => {
    const made = await prepareLanguageServers(appDir, [{ name: 'clangd' }], lspSrc)
    assert.equal(made.length, 1)
    assert.ok(existsSync(join(bundledLspDir(appDir), 'clangd', 'bin', 'clangd.exe')), 'the program is there')
    assert.ok(existsSync(join(bundledLspDir(appDir), 'clangd', 'lib', 'clang', '23', 'include', 'stdio.h')), 'its headers are there')
  })

  test('a server the source folder does not carry stops the build', async () => {
    await assert.rejects(
      () => prepareLanguageServers(appDir, [{ name: 'clangd' }, { name: 'not-there' }], lspSrc),
      /resolved to nothing/u,
    )
  })

  test('an old tree is not carried into a new build', async () => {
    write(join(bundledLspDir(appDir), 'old', 'bin', 'old.exe'), 'old\n')
    await prepareLanguageServers(appDir, [{ name: 'clangd' }], lspSrc)
    assert.equal(existsSync(join(bundledLspDir(appDir), 'old')), false, 'the old server is gone')
  })

  test('the manifest names the servers the build carries', () => {
    const servers = manifestLanguageServers(join(import.meta.dirname, '..'))
    assert.deepEqual(servers.map(entry => entry.name), ['clangd', 'pyright'])
  })

  test('the source folder is the one beside the repo, unless the environment names another', () => {
    assert.equal(defaultLspSrc(appDir), join(dirname(dirname(appDir)), 'dsh-lsp'))
    const saved = process.env.DS_BOT_LSP_SRC
    process.env.DS_BOT_LSP_SRC = 'C:\\elsewhere'
    try {
      assert.equal(defaultLspSrc(appDir), 'C:\\elsewhere')
    } finally {
      if (saved === undefined) delete process.env.DS_BOT_LSP_SRC
      else process.env.DS_BOT_LSP_SRC = saved
    }
  })
})
