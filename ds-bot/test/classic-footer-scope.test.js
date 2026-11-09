import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// The classic (Agent) page withdraws the whole shell group. That group carries the
// stylesheets the #7 fix lives in — SHELL_CSS (styles.js) and SIDEBAR_CSS (sidebar.js)
// — so the fix's rules are not on the page at all when the bug is visible.
//
// The two stylesheets are read as text: importing them pulls in React, which the
// unit tests do not have.
const here = dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(join(here, '..', 'src', 'client', name), 'utf8')

test('the classic page mounts no shell group', async () => {
  const { groupsFor } = await import('../src/client/surface.js')
  assert.equal(groupsFor({ mode: 'agent' }).shell, false)
  assert.equal(groupsFor({ mode: 'agent' }).conversation, false)
  assert.equal(groupsFor({ mode: 'bot' }).shell, true)
})

test('the #7 rules live in the stylesheets the shell group installs', () => {
  const styles = read('styles.js')
  const sidebar = read('sidebar.js')
  // The gear takes the host's own shape in the classic page: styles.js, SHELL_CSS.
  assert.match(styles, /:root\[data-bt-surface=agent\][^{]*\.bt-you\{/)
  // The Bot column's own footer grid stops at the Bot surface: sidebar.js, SIDEBAR_CSS.
  assert.match(sidebar, /:root\[data-bt-surface=bot\][^{]*_footArea/)
})

test('neither #7 rule can apply to the classic page as written', () => {
  const styles = read('styles.js')
  const sidebar = read('sidebar.js')
  assert.ok(styles.includes('data-bt-surface=agent'))
  assert.ok(sidebar.includes('data-bt-surface=bot'))
})
