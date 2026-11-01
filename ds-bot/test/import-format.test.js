import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { importUserSessions } from '../src/host/auto-import.js'
import { HOST_SESSION_VERSION } from '../src/host/import-format.js'

// A session in the older format: a tool result whose message has no role of its own, the way
// the logs of that generation wrote it. The host reads a tool result's role as "tool", so the
// older shape is refused whole.
function oldSession(dir) {
  const events = [
    { type: 'turn/start', turn: 1, time: 1 },
    { type: 'user/message', turn: 1, message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
    { type: 'step/start', turn: 1, step: 1, time: 2 },
    { type: 'tool/call', turn: 1, step: 1, id: 'call-1', name: 'read', arguments: {}, time: 3 },
    { type: 'tool/result', turn: 1, step: 1, message: { id: 'm3', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file' }] }], source: { kind: 'tool', callId: 'call-1' } } },
    { type: 'turn/end', turn: 1, reason: { kind: 'completed' }, time: 4 },
  ]
  const sessionDir = join(dir, 'sessions', 'ws', 'sess-1')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
  return dir
}

// A service that writes the session the way the host asks: the role of a tool result must be
// "tool" for the host to accept the seed.
function fakeService(role) {
  const calls = []
  return {
    calls,
    async scanDiscover(input) {
      calls.push(['scan', input])
      return { sessions: [{ format: input.format, sourcePath: '/a.jsonl' }], total: 1, warnings: [] }
    },
    async importAll(input) {
      calls.push(['import', input])
      return { mode: 'batch', scanned: 1, imported: 1, appended: 0, skipped: 0, failed: 0, results: [{ status: 'imported', role }], errors: [], warnings: [] }
    },
  }
}

test('the import states the host session format version', async () => {
  const home = oldSession(mkdtempSync(join(tmpdir(), 'ds-bot-old-home-')))
  const service = fakeService('tool')
  const seen = []
  const importer = {
    importOne: async () => ({ status: 'imported' }),
    withVersion: async (ctx, version, fn) => {
      seen.push(version)
      return fn()
    },
  }
  await importUserSessions(fakeCtx(service), { home, service, importer })
  assert.deepEqual(seen, [HOST_SESSION_VERSION, HOST_SESSION_VERSION], 'both formats state the version')
  assert.equal(HOST_SESSION_VERSION, 4, 'the host writes version 4')
})

test('without the plugin importer the service does the import', async () => {
  const home = oldSession(mkdtempSync(join(tmpdir(), 'ds-bot-old-home-')))
  const service = fakeService('user')
  const result = await importUserSessions(fakeCtx(service), { home, service })
  assert.equal(result.imported, 2, 'the import ran')
})

function fakeCtx(service) {
  return { get: name => (name === 'chatImport' ? service : undefined) }
}
