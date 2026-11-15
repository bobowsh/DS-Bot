// The writeBytes patch generator: it must be repeatable, refuse to patch a host whose
// anchors moved, and produce source that really carries the byte channel.
//
// The patched backend itself is exercised in ds-bot/test/fs-write.test.js, against the
// harness tree where it is applied for real; this file only guards the generator.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const { run, revert, patchForPack } = await import(new URL('../scripts/fs-writebytes-patch.mjs', import.meta.url).href)
const HOST_MODULES = fileURLToPath(new URL('../node_modules/@deepseek-ai/', import.meta.url))
const PKGS = ['dsh-fs', 'dsh-fs-local', 'dsh-fs-sandbox']
const FILE = 'lib/index.js'

/**
 * A throwaway node_modules holding pristine copies of the three patched packages.
 *
 * The repo's own node_modules carries the patch already, so the pristine source is the
 * `.orig` backup the generator keeps beside each file.
 * @returns {string} the node_modules directory the generator takes as its root
 */
function staged(t) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-patch-'))
  const modules = join(root, 'node_modules')
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  for (const pkg of PKGS) {
    const source = join(HOST_MODULES, pkg, FILE)
    const pristine = existsSync(`${source}.orig`) ? `${source}.orig` : source
    const to = join(modules, '@deepseek-ai', pkg, FILE)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, readFileSync(pristine))
  }
  return modules
}

const sourceOf = (modules, pkg) => readFileSync(join(modules, '@deepseek-ai', pkg, FILE), 'utf8')

test('the generator patches, is idempotent, and reverts', (t) => {
  const modules = staged(t)

  const first = run(modules)
  assert.deepEqual(first.map(row => row.state), ['applied', 'applied', 'applied'])
  for (const row of first) assert.ok(row.added > 0, `${row.pkg} gained lines`)

  assert.deepEqual(run(modules).map(row => row.state), ['patched', 'patched', 'patched'], 'running twice changes nothing')
  assert.deepEqual(run(modules, { check: true }).map(row => row.state), ['patched', 'patched', 'patched'])

  assert.deepEqual(revert(modules).map(row => row.state), ['reverted', 'reverted', 'reverted'])
  assert.deepEqual(run(modules, { check: true }).map(row => row.state), ['unpatched', 'unpatched', 'unpatched'])
})

test('the patched sources carry the byte channel the plan describes', (t) => {
  const modules = staged(t)
  run(modules)

  // dsh-fs: the abstract class gains writeBytes, refusing by name where unimplemented.
  const abstractSource = sourceOf(modules, 'dsh-fs')
  assert.match(abstractSource, /async writeBytes\(target, bytes, expected, signal\) \{/u)
  assert.match(abstractSource, /Raw byte writes are not supported/u)

  // dsh-fs-local: the atomic write stops forcing utf8 for a Buffer, and writeBytes uses
  // the SAME lock and the SAME publication path — no second atomic write.
  const localSource = sourceOf(modules, 'dsh-fs-local')
  assert.match(localSource, /Buffer\.isBuffer\(content\) \? \{\} : \{ encoding: "utf8" \}/u, 'the utf8 encoding is skipped for a Buffer')
  assert.match(localSource, /async writeBytes\(target, bytes, expected, signal\) \{\s*\n\s*return this\.withLock\(target\.targetKey/u, 'writeBytes takes the same per-target lock')
  assert.match(localSource, /writeFileAtomic\(target\.targetKey, Buffer\.from\(bytes\)/u, 'writeBytes publishes through writeFileAtomic')
  assert.equal(localSource.match(/function writeFileAtomic/gu).length, 1, 'still exactly one atomic write implementation')

  // dsh-fs-sandbox: the fence is applied, never bypassed.
  const sandboxSource = sourceOf(modules, 'dsh-fs-sandbox')
  assert.match(sandboxSource, /async writeBytes\(target, bytes, expected, signal, sandboxPolicy\) \{\s*\n\s*return super\.writeBytes\(await this\.checkedTarget\(/u)
})

test('an unknown host version is refused rather than patched blindly', (t) => {
  const modules = staged(t)
  const file = join(modules, '@deepseek-ai', 'dsh-fs', FILE)
  const source = readFileSync(file, 'utf8')
  writeFileSync(file, source.replaceAll('get sandboxMode() {}', 'get sandboxMode() { return undefined }'), 'utf8')
  assert.throws(() => run(modules), /anchor not found/u)
})

test('a run reports every target package by name', (t) => {
  const modules = staged(t)
  assert.deepEqual(run(modules).map(row => row.pkg), PKGS.map(pkg => `@deepseek-ai/${pkg}`), 'every target is reported')
})

// The pack entry: before-pack calls it so `npm run pack`/`dist` carry the byte channel without
// anyone remembering to run the script first. What matters is that it cannot let an unpatched
// Host into the package — every way the patch fails must throw, not skip.
test('patchForPack applies once and is idempotent across runs', (t) => {
  const modules = staged(t)
  const first = patchForPack('app-dir', [modules])
  assert.deepEqual(first[0].report.map(row => row.state), ['applied', 'applied', 'applied'])
  // A second pack over the same tree changes nothing: already patched, still in place.
  const again = patchForPack('app-dir', [modules])
  assert.deepEqual(again[0].report.map(row => row.state), ['patched', 'patched', 'patched'])
})

test('patchForPack stops the pack when the app node_modules is not there', () => {
  assert.throws(() => patchForPack('app-dir', [join(tmpdir(), 'ds-bot-no-such-modules')]),
    /the pack needs .* to patch writeBytes into, and it is not there/u)
})

test('patchForPack stops the pack when a package is missing from the tree', (t) => {
  const modules = staged(t)
  rmSync(join(modules, '@deepseek-ai', 'dsh-fs-local', FILE))
  assert.throws(() => patchForPack('app-dir', [modules]),
    /writeBytes could not reach @deepseek-ai\/dsh-fs-local/u)
})

test('patchForPack stops the pack when an anchor moved under a new Host version', (t) => {
  const modules = staged(t)
  const file = join(modules, '@deepseek-ai', 'dsh-fs', FILE)
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('get sandboxMode() {}', 'get sandboxMode() { return undefined }'), 'utf8')
  assert.throws(() => patchForPack('app-dir', [modules]), /anchor not found/u)
})
