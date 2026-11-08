// The Host's environment: the intranet catalog has to reach the Host process, because the
// plugin market reads it from the environment and not from the profile's config.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { HostProcess } from '../src/host-process.mjs'
import { DSHM_REGISTRY_URL } from '../src/profile.mjs'

describe('the Host environment', () => {
  test('the catalog url reaches the Host process', async () => {
    // The folder is left behind on purpose: the Host runs inside it, and Windows keeps a
    // directory busy while a process works in it.
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-host-env-'))
    const entry = join(root, 'host.mjs')
    writeFileSync(entry, `
if (process.send !== undefined) process.send({ type: 'ready', url: 'http://127.0.0.1:1/', injections: [], env: process.env.DSHM_REGISTRY_URL })
process.exit(0)
`, 'utf8')
    let received
    const host = new HostProcess({
      entry,
      cwd: root,
      env: { ...process.env, DSHM_REGISTRY_URL },
      pnpm: join(root, 'pnpm.mjs'),
      onFailure: () => {},
      output: () => {},
    })
    host.onMessage(message => { received = message?.env })
    await host.start()
    assert.equal(received, DSHM_REGISTRY_URL)
    assert.match(String(received), /^http:\/\/192\.168\.1\.10:/u, 'it is the intranet catalog')
  })
})
