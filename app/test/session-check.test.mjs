import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { unreadableSessions } from '../src/session-check.mjs'

const named = (name, message) => Object.assign(new Error(message), { name })

describe('unreadableSessions', () => {
  test('names only the Sessions that a newer DSH wrote, and closes every handle it opens', async () => {
    const closed = []
    const failures = {
      newer: named('SessionFormatUnsupportedError', 'unknown to this harness'),
      damaged: named('SessionPersistenceCorruptionError', 'damaged frame'),
    }
    const persistence = {
      open: async (id, access) => {
        assert.equal(access, 'read')
        if (id === 'gone') throw named('SessionPersistenceNotFoundError', 'no such Session')
        return {
          read: async () => { if (failures[id]) throw failures[id] },
          close: async () => { closed.push(id) },
        }
      },
    }
    assert.deepEqual(await unreadableSessions(persistence, ['fine', 'newer', 'damaged', 'gone']), ['newer'])
    assert.deepEqual(closed, ['fine', 'newer', 'damaged'])
  })
})

