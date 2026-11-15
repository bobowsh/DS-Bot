// The build pulls the factory plugins from the intranet registry with `npm pack`. On Windows
// `npm` is a `.cmd` shim, which `spawn` cannot start without a shell: the pull used to fail
// silently and every plugin fell back to the development folder, so a build that promised
// skillhub 0.6.3 shipped the 0.6.2 in that folder instead.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, test } from 'node:test'
import { npmCommand, npmSpawnOptions } from '../scripts/bundled-plugin.mjs'

describe('the npm command the build runs', () => {
  test('on Windows it goes through a shell, because a .cmd shim cannot be spawned', () => {
    assert.equal(npmCommand(), 'npm')
    assert.deepEqual(npmSpawnOptions(), process.platform === 'win32' ? { shell: true } : {})
  })

  test('the command it names can actually be started', async () => {
    // The failure this guards against is ENOENT and EINVAL: the spawn fails before npm runs.
    const child = spawn(npmCommand(), ['--version'], { ...npmSpawnOptions(), stdio: ['ignore', 'pipe', 'pipe'] })
    const version = await new Promise((resolve, reject) => {
      let out = ''
      child.stdout.on('data', data => { out += data })
      child.on('error', reject)
      child.on('exit', code => { code === 0 ? resolve(out.trim()) : reject(new Error(`exited with ${code}`)) })
    })
    assert.match(version, /^\d+\.\d+\.\d+/u, 'npm prints its version')
  })
})
