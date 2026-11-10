import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// The rules both surfaces need live in BASE_CSS, which is installed outside the
// shell group. The classic Agent page mounts no shell group, so without this the
// icons it shows (the AIDE button, the account gear, the brand) fall back to the
// host's defaults: no theme, no size, and the icons overlap each other.
//
// These tests pin that arrangement, so a rule cannot quietly move back.
//
// The two stylesheets are read as text: importing them pulls in React, which the
// unit tests do not have.
const here = dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(join(here, '..', 'src', 'client', name), 'utf8')

const styles = read('styles.js')
const base = styles.slice(styles.indexOf('export const BASE_CSS'), styles.indexOf('export const SHELL_CSS'))
const shell = styles.slice(styles.indexOf('export const SHELL_CSS'), styles.indexOf('export const CONVERSATION_CSS'))

test('the classic page mounts no shell group', async () => {
  const { groupsFor } = await import('../src/client/surface.js')
  assert.equal(groupsFor({ mode: 'agent' }).shell, false)
  assert.equal(groupsFor({ mode: 'agent' }).conversation, false)
  assert.equal(groupsFor({ mode: 'bot' }).shell, true)
})

test('the rules both surfaces need live in BASE_CSS', () => {
  // The theme the rules read, and the base look of our own marks.
  assert.match(base, /body\{--bt-im-telegram:/)
  assert.match(base, /body\[data-ds-dark-theme\]\{--bt-im-telegram:/)
  assert.match(base, /\.bt-round\{width:36px/)
  assert.match(base, /\.bt-you\{width:36px/)
  assert.match(base, /\.bt-account\{flex:none/)
  assert.match(base, /\.bt-brand-whale\{display:inline-flex/)
  assert.match(base, /\.bt-brand-name\{font-weight:600/)
  // And they are gone from the shell group's table, so they load only once.
  assert.doesNotMatch(shell, /\.bt-round\{width:36px/)
  assert.doesNotMatch(shell, /\.bt-you\{width:36px/)
  assert.doesNotMatch(shell, /body\{--bt-im-telegram:/)
})

test('the base table is installed outside the shell group', () => {
  const index = read('index.js')
  const line = index.split('\n').find(l => l.includes('installCompiledStyles(BASE_CSS'))
  assert.ok(line !== undefined, 'BASE_CSS is installed')
  // It is a plain effect, like the tables that belong to neither group — not one
  // of the steps the shell group mounts and withdraws with the surface.
  assert.match(line, /ctx\.effect\(\(\) => installCompiledStyles\(BASE_CSS, 'base'\)/)
  // The shell group's own steps never mention it.
  const shellStart = index.indexOf('const installShell = () => [')
  const shellEnd = index.indexOf('const installConversation = () => [')
  assert.doesNotMatch(index.slice(shellStart, shellEnd), /BASE_CSS/)
})

test('the gear takes the host\'s shape in the classic page', () => {
  // The rule is in BASE_CSS, so it is on the classic page: the gear fills the
  // host's own settings button instead of drawing a second circle on top of it.
  assert.match(base, /:root\[data-bt-surface=agent\][^{]*_settingsArea[^{]*\.bt-you\{/)
})

// The Bot surface keeps what it had: the shell group still loads, and the rules
// that were in SHELL_CSS are the same ones now in BASE_CSS — only the table they
// live in changed. The Bot surface reads both, so it draws the same.
test('the Bot surface draws the same: the rules are in both tables, unchanged', () => {
  const index = read('index.js')
  // The shell group installs the shell table, and the base table is installed for
  // both surfaces: the Bot surface therefore has every rule it had before.
  assert.match(index, /ctx\.effect\(\(\) => installCompiledStyles\(BASE_CSS, 'base'\)/)
  // The shell group's table is listed in SHELL_SHEETS as [SHELL_CSS, 'shell'] and
  // installed from there (upstream v0.3.2 turned the list into data).
  assert.match(index, /\[SHELL_CSS, 'shell'\]/)
  // The Bot surface's own footer grid is scoped to it and stays where it was.
  const sidebar = read('sidebar.js')
  assert.match(sidebar, /:root\[data-bt-surface=bot\][^{]*_footArea/)
})
