import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { detectSessions, hasSessions, removeDshHomeVariable, removeDshHomeVariableWithNotice, userHome } from '../src/auto-import.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// A DSH home with sessions of two formats, one of them compressed.
function makeHome(root) {
  write(join(root, 'sessions', 'proj-a', 'sess-1', 'session.jsonl'), '{"type":"user"}\n')
  write(join(root, 'sessions', 'proj-a', 'sess-2', 'session.v4.jsonl'), '{"type":"user"}\n')
  write(join(root, 'sessions', 'proj-b', 'sess-3', 'session.jsonl.zstd'), 'binary')
  return root
}

describe('the sessions of the user DSH home', () => {
  let home
  before(() => { home = mkdtempSync(join(tmpdir(), 'ds-bot-auto-import-')) })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  test('a home without sessions holds none', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ds-bot-auto-import-empty-'))
    try {
      assert.deepEqual(detectSessions(empty), { from: empty, sessions: 0, logs: 0, formats: [] })
      assert.equal(hasSessions(empty), false)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('a home that does not exist holds none', () => {
    const missing = join(home, 'not-there')
    assert.equal(hasSessions(missing), false)
  })

  test('the sessions and their formats are found', () => {
    const from = makeHome(join(home, 'with'))
    const found = detectSessions(from)
    assert.equal(found.sessions, 3)
    assert.equal(found.logs, 3)
    assert.deepEqual(found.formats, ['dsh', 'dsh4'])
    assert.equal(hasSessions(from), true)
  })

  test('a folder that is not a session is not counted', () => {
    const from = join(home, 'other')
    write(join(from, 'sessions', 'proj', 'sess', 'notes.txt'), 'hello')
    assert.equal(detectSessions(from).sessions, 0)
  })

  test("the user's home is the one the app overrides for a test run", () => {
    const overridden = join(home, 'override')
    assert.equal(userHome({ DS_BOT_USER_DSH_HOME: overridden }), overridden)
    // Without the override the environment's own variable wins, as DSH reads it.
    assert.equal(userHome({ DSH_HOME: join(home, 'from-env') }), join(home, 'from-env'))
  })
})

describe('the DSH_HOME variable', () => {
  test('both levels are removed when both are set', () => {
    const calls = []
    const result = removeDshHomeVariable({
      read: () => 'C:\\somewhere\\.dsh',
      remove: (name, level) => calls.push([name, level]),
    })
    assert.deepEqual(result.removed, ['user', 'machine'])
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.failed, [])
    assert.deepEqual(calls, [['DSH_HOME', 'user'], ['DSH_HOME', 'machine']])
  })

  test('the machine level without rights is skipped, not thrown', () => {
    const result = removeDshHomeVariable({
      read: () => 'C:\\somewhere\\.dsh',
      remove: (name, level) => { if (level === 'machine') throw new Error('access denied') },
    })
    assert.deepEqual(result.removed, ['user'])
    assert.deepEqual(result.skipped, ['machine'])
    assert.deepEqual(result.failed, [])
  })

  test('a level that is not set is left alone', () => {
    const calls = []
    const result = removeDshHomeVariable({
      read: () => undefined,
      remove: (name, level) => calls.push(level),
    })
    assert.deepEqual(result.removed, [])
    assert.deepEqual(calls, [])
  })

  test('a failing user level is reported as failed', () => {
    const result = removeDshHomeVariable({
      read: () => 'C:\\somewhere\\.dsh',
      remove: (name, level) => { if (level === 'user') throw new Error('locked') },
    })
    assert.deepEqual(result.removed, ['machine'])
    assert.deepEqual(result.failed, ['user'])
  })

  test('an unreadable level does not stop the other one', () => {
    const result = removeDshHomeVariable({
      read: (name) => { if (name === 'DSH_HOME') throw new Error('cannot read'); return undefined },
      remove: () => {},
    })
    assert.deepEqual(result.removed, [])
  })
})

describe('the notice for a variable that could not be removed', () => {
  test('no notice when both levels were removed', async () => {
    const shown = []
    const result = await removeDshHomeVariableWithNotice({
      show: options => { shown.push(options); return Promise.resolve() },
      read: () => 'C:\\somewhere\\.dsh',
      remove: () => {},
    })
    assert.deepEqual(shown, [])
    assert.deepEqual(result.removed, ['user', 'machine'])
  })

  test('a notice names the variable and how to remove it', async () => {
    const shown = []
    await removeDshHomeVariableWithNotice({
      show: options => { shown.push(options); return Promise.resolve() },
      read: () => 'C:\\somewhere\\.dsh',
      remove: (name, level) => { if (level === 'machine') throw new Error('access denied') },
    })
    assert.equal(shown.length, 1)
    assert.match(shown[0].message, /DSH_HOME/u)
    assert.match(shown[0].detail, /administrator/u)
  })

  test('a notice that cannot be shown does not throw', async () => {
    const result = await removeDshHomeVariableWithNotice({
      show: () => Promise.reject(new Error('no window')),
      read: () => 'C:\\somewhere\\.dsh',
      remove: (name, level) => { if (level === 'machine') throw new Error('access denied') },
    })
    assert.deepEqual(result.skipped, ['machine'])
  })
})
