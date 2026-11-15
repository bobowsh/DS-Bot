// The DOM probe is a dev tool that starts the real application. Its one rule is
// that it may only ever touch throwaway folders: it must never write into an
// installed app's own data, and never into the user's DSH home.
//
// The guard is the part worth a test; the probe itself needs a packaged app and
// a browser to run, so it is exercised by hand, not here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { unsafeFolders } from '../scripts/dom-probe-guard.mjs'

const SAFE = {
  home: 'D:\\dsbot-work\\probe\\data',
  shellData: 'D:\\dsbot-work\\probe\\shell',
  userProfile: 'D:\\Users\\bobowsh',
  dshHome: 'D:\\Users\\bobowsh\\.dsh',
}

test('the probe refuses to start without throwaway folders', () => {
  assert.match(unsafeFolders({}), /DS_BOT_HOME and DS_BOT_SHELL_DATA/)
  assert.match(unsafeFolders({ home: SAFE.home }), /DS_BOT_HOME and DS_BOT_SHELL_DATA/)
  assert.match(unsafeFolders({ shellData: SAFE.shellData }), /DS_BOT_HOME and DS_BOT_SHELL_DATA/)
})

test('the probe refuses the folders that hold real data', () => {
  // The user profile: the installed app's own data lives under it.
  assert.match(unsafeFolders({ ...SAFE, home: 'D:\\Users\\bobowsh' }), /user profile/)
  // The DSH home: the user's own DSH data.
  assert.match(unsafeFolders({ ...SAFE, home: 'D:\\Users\\bobowsh\\.dsh' }), /DSH home/)
  assert.match(unsafeFolders({ ...SAFE, shellData: 'D:\\Users\\bobowsh\\.dsh' }), /DSH home/)
})

test('the probe refuses a home and a shell data folder that are the same', () => {
  assert.match(unsafeFolders({ ...SAFE, shellData: SAFE.home }), /must be different/)
})

test('the probe accepts a pair of throwaway folders', () => {
  assert.equal(unsafeFolders(SAFE), '')
})

test('a trailing separator does not hide a forbidden folder', () => {
  assert.match(unsafeFolders({ ...SAFE, home: 'D:\\Users\\bobowsh\\' }), /user profile/)
  assert.match(unsafeFolders({ ...SAFE, home: 'D:\\Users\\bobowsh\\.dsh\\' }), /DSH home/)
  assert.match(unsafeFolders({ ...SAFE, shellData: 'D:\\Users\\bobowsh\\.dsh\\' }), /DSH home/)
})

test('the probe script says how to use it', () => {
  const source = fileURLToPath(new URL('../scripts/dom-probe.mjs', import.meta.url))
  const text = readFileSync(source, 'utf8')
  assert.match(text, /Usage: node scripts\/dom-probe\.mjs/)
  for (const name of ['PROBE_SURFACE', 'PROBE_SEND', 'PROBE_WAIT']) {
    assert.ok(text.includes(name), `${name} is documented`)
  }
})
