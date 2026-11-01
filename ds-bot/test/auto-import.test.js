import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { importUserSessions, requestedHome } from '../src/host/auto-import.js'

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
