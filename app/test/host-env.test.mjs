// The Host's environment and the plugin market's catalog.
//
// The app used to hand the Host a DSHM_REGISTRY_URL pointing at the intranet catalog. That
// variable REPLACES dshmarket's whole catalog source list (its official domain plus the
// published npm package), so while the intranet service was down the market could read no
// catalog at all. The app now adds no catalog override: the variable only ever arrives from
// the user's own environment, and then it is theirs to state.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { HostProcess } from '../src/host-process.mjs'
import * as profile from '../src/profile.mjs'

describe('the Host environment', () => {
  test('the app names no catalog source of its own', () => {
    assert.equal('DSHM_REGISTRY_URL' in profile, false)
    assert.equal('CATALOG_URL' in profile, false)
  })

  test("a catalog the user set themselves reaches the Host untouched", async () => {
    // The folder is left behind on purpose: the Host runs inside it, and Windows keeps a
    // directory busy while a process works in it.
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-host-env-'))
    const entry = join(root, 'host.mjs')
    writeFileSync(entry, `
if (process.send !== undefined) process.send({ type: 'ready', url: 'http://127.0.0.1:1/', injections: [], env: process.env.DSHM_REGISTRY_URL })
process.exit(0)
`, 'utf8')
    const own = 'https://their.example/plugins.json'
    let received
    const host = new HostProcess({
      entry,
      cwd: root,
      env: { ...process.env, DSHM_REGISTRY_URL: own },
      pnpm: join(root, 'pnpm.mjs'),
      onFailure: () => {},
      output: () => {},
    })
    host.onMessage(message => { received = message?.env })
    await host.start()
    // Passed through verbatim: the app neither rewrites nor drops the user's own statement.
    assert.equal(received, own)
  })
})
