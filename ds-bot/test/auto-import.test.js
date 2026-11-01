import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { importUserSessions, install, requestedHome } from '../src/host/auto-import.js'

// A profile directory with the import plugin in it, so the plugin's own importer can be
// loaded the way the app loads it: by its path inside the package.
async function fakePluginDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-auto-import-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'profile', version: '0.0.0' }))
  const plugin = join(dir, 'node_modules', 'dsh-chat-import')
  await mkdir(join(plugin, 'lib'), { recursive: true })
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-chat-import', version: '0.0.0' }))
  for (const [name, content] of Object.entries(files)) await writeFile(join(plugin, ...name.split('/')), content)
  return dir
}

// The import plugin's service, in memory: it records what it was asked to scan and import.
function fakeImportService({ sessions = [], summary = {}, failScan, failImport } = {}) {
  const calls = []
  return {
    calls,
    async scanDiscover(input) {
      calls.push(['scan', input])
      if (failScan) throw new Error(failScan)
      return { sessions: sessions.map(s => ({ format: input.format, sourcePath: s })), total: sessions.length, warnings: [] }
    },
    async importAll(input) {
      calls.push(['import', input])
      if (failImport) throw new Error(failImport)
      return summary
    },
  }
}

const ctxWith = service => ({ get: name => (name === 'chatImport' ? service : undefined) })

test('the import runs only when the app asks for it', () => {
  assert.equal(requestedHome({}), undefined)
  assert.equal(requestedHome({ DS_BOT_AUTO_IMPORT: '0', DS_BOT_USER_DSH_HOME: '/home/.dsh' }), undefined)
  assert.equal(requestedHome({ DS_BOT_AUTO_IMPORT: '1' }), undefined)
  assert.equal(requestedHome({ DS_BOT_AUTO_IMPORT: '1', DS_BOT_USER_DSH_HOME: '/home/.dsh' }), '/home/.dsh')
})

test('without a home nothing is scanned', async () => {
  const service = fakeImportService()
  const result = await importUserSessions(ctxWith(service), { home: undefined })
  assert.deepEqual(result, { imported: 0, failed: 0, skipped: 0, formats: [] })
  assert.deepEqual(service.calls, [])
})

test('without the plugin nothing is scanned', async () => {
  const result = await importUserSessions(ctxWith(undefined), { home: '/home/.dsh' })
  assert.deepEqual(result, { imported: 0, failed: 0, skipped: 0, formats: [] })
})

test('the sessions of the user home are scanned and imported', async () => {
  const service = fakeImportService({ sessions: ['a.jsonl'], summary: { imported: 2, skipped: 1, failed: 0 } })
  const result = await importUserSessions(ctxWith(service), { home: '/home/.dsh' })
  // The path is given explicitly: the plugin's default roots follow this process's DSH_HOME,
  // which is the app's own home, not the user's.
  assert.deepEqual(service.calls.map(call => call[0]), ['scan', 'import', 'scan', 'import'])
  for (const [, input] of service.calls) assert.equal(input.path, join('/home/.dsh', 'sessions'))
  assert.deepEqual(result.formats, ['dsh', 'dsh4'])
  assert.equal(result.imported, 4)
  assert.equal(result.skipped, 2)
  assert.equal(result.failed, 0)
})

test('the reason a session failed is written down', async () => {
  // The plugin reports why a session failed in that session's result; without this the log
  // says only how many failed.
  const service = fakeImportService({
    sessions: ['a.jsonl'],
    summary: {
      imported: 0,
      failed: 1,
      results: [{ status: 'failed', error: 'agents.create 失败（host says no）' }],
      errors: [{ sourcePath: '/a.jsonl', error: 'agents.create 失败（host says no）' }],
    },
  })
  const messages = []
  const result = await importUserSessions(ctxWith(service), { home: '/home/.dsh', onProgress: m => messages.push(m) })
  // Both formats hold the session and both fail.
  assert.equal(result.failed, 2)
  assert.ok(messages.some(m => m.includes('host says no')), `the reason is in the log: ${messages.join(' | ')}`)
})

test('a home without sessions is not imported', async () => {
  const service = fakeImportService({ sessions: [] })
  const result = await importUserSessions(ctxWith(service), { home: '/home/.dsh' })
  assert.deepEqual(result.formats, [])
  assert.deepEqual(service.calls.map(call => call[0]), ['scan', 'scan'])
})

test('a format that cannot be scanned does not stop the other one', async () => {
  const messages = []
  let scan = 0
  const service = {
    async scanDiscover(input) {
      scan += 1
      if (scan === 1) throw new Error('cannot read')
      return { sessions: [{ format: input.format }], total: 1, warnings: [] }
    },
    async importAll() { return { imported: 1, skipped: 0, failed: 0 } },
  }
  const result = await importUserSessions(ctxWith(service), { home: '/home/.dsh', onProgress: m => messages.push(m) })
  assert.equal(result.failed, 1)
  assert.equal(result.imported, 1)
  assert.equal(result.formats.length, 1)
  assert.match(messages.join('\n'), /cannot read/u)
})

test('an import that fails does not throw', async () => {
  const service = fakeImportService({ sessions: ['a.jsonl'], failImport: 'no space' })
  const result = await importUserSessions(ctxWith(service), { home: '/home/.dsh' })
  // Both formats hold a session and both fail; neither failure stops the start.
  assert.equal(result.failed, 2)
  assert.equal(result.imported, 0)
  assert.equal(result.formats.length, 2)
})

test('the line the installer check reads says what was imported', async () => {
  const service = fakeImportService({ sessions: ['a.jsonl'], summary: { imported: 3, skipped: 0, failed: 0 } })
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  const previous = process.env.DS_BOT_AUTO_IMPORT
  const previousHome = process.env.DS_BOT_USER_DSH_HOME
  process.env.DS_BOT_AUTO_IMPORT = '1'
  process.env.DS_BOT_USER_DSH_HOME = '/home/.dsh'
  try {
    const ctx = ctxWith(service)
    ctx.inject = (names, callback) => callback({ chatImport: service, effect: () => {} })
    const rt = { ctx, warn: () => {} }
    install(rt)
    await rt.runAutoImport()
  } finally {
    console.log = original
    if (previous === undefined) delete process.env.DS_BOT_AUTO_IMPORT
    else process.env.DS_BOT_AUTO_IMPORT = previous
    if (previousHome === undefined) delete process.env.DS_BOT_USER_DSH_HOME
    else process.env.DS_BOT_USER_DSH_HOME = previousHome
  }
  assert.equal(lines.length, 1)
  assert.match(lines[0], /imported \d+ sessions/u)
  assert.match(lines[0], /\/home\/\.dsh/u)
})

test('the import runs on the context that carries the filesystem service', async () => {
  // The plugin's import reads and writes through the host's filesystem service. The context the
  // chat import service came from carries that service only, so the import would find no
  // filesystem on it; the context the filesystem injection gives carries it.
  // The version override is remembered per context, so the context the import runs on is also
  // the one the version is stated on.
  const seen = []
  const pluginDir = await fakePluginDir({
    'lib/import-core.mjs': 'export async function withHostFormatVersion(ctx, version, fn) { globalThis.__seen.push({ ctx, version }); return await fn() }\n',
    'lib/toolkit.mjs': 'export async function importDiscoveryItem(ctx, format, sourcePath, ids, opts) { globalThis.__seen.push({ ctx, format, sourcePath }); return { status: "imported" } }\n',
  })
  globalThis.__seen = seen
  const service = fakeImportService({ sessions: ['a.jsonl'], summary: { imported: 1, skipped: 0, failed: 0 } })
  const chatImportContext = { chatImport: service, effect: () => {} }
  const filesystemContext = { fs: { resolve: async p => p }, effect: () => {} }
  const ctx = {
    get: name => {
      if (name === 'chatImport') return service
      if (name === 'profileContext') return { dir: pluginDir }
      return undefined
    },
    inject: (names, callback) => {
      if (names.includes('chatImport')) return callback(chatImportContext)
      if (names.includes('fs')) return callback(filesystemContext)
      return undefined
    },
  }
  const previous = process.env.DS_BOT_AUTO_IMPORT
  const previousHome = process.env.DS_BOT_USER_DSH_HOME
  process.env.DS_BOT_AUTO_IMPORT = '1'
  process.env.DS_BOT_USER_DSH_HOME = '/home/.dsh'
  try {
    const rt = { ctx, warn: () => {} }
    install(rt)
    const result = await rt.runAutoImport()
    assert.equal(result.imported, 2)
  } finally {
    delete globalThis.__seen
    if (previous === undefined) delete process.env.DS_BOT_AUTO_IMPORT
    else process.env.DS_BOT_AUTO_IMPORT = previous
    if (previousHome === undefined) delete process.env.DS_BOT_USER_DSH_HOME
    else process.env.DS_BOT_USER_DSH_HOME = previousHome
    await rm(pluginDir, { recursive: true, force: true })
  }
  assert.ok(seen.length > 0)
  for (const entry of seen) {
    assert.equal(entry.ctx, filesystemContext, 'the import runs on the filesystem context')
  }
  assert.ok(seen.some(entry => entry.version === 4), 'the target session format version is stated')
})
