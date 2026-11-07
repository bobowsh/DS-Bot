// Verifies the work-details fold of a running desktop app: it drives the host's
// own group header and reports whether the process rows follow it.
//
//   node scripts/verify-fold.mjs [port] [--rounds=5]
//
// The port is the desktop app's --remote-debugging-port. The script speaks
// DevTools Protocol to the app's page, because the group header is rendered by
// Chromium: it has no accessibility handle to invoke, so the only reliable way
// to turn it is the element's own click.
import { readFileSync } from 'node:fs'

const port = process.argv[2] ?? '9240'
const roundsArg = process.argv.find(arg => arg.startsWith('--rounds='))
const rounds = roundsArg ? Number(roundsArg.split('=')[1]) : 5

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.filter(target => target.type === 'page')[0]
if (!page) {
  console.error(`no page on port ${port}`)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const call = (method, params = {}) => new Promise(resolve => {
  const mid = ++id
  pending.set(mid, resolve)
  ws.send(JSON.stringify({ id: mid, method, params }))
})
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result)
    pending.delete(message.id)
  }
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws')) })
await call('Runtime.enable')

const evaluate = async expression => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result?.exceptionDetails) {
    return 'ERR ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result?.result?.value
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// The host disables the header when the Turn cannot fold (a live, stopped or
// failed Turn, or a mode that never folds), so a disabled header is a mode
// choice, not a broken fold.
const headerState = async () => {
  const raw = await evaluate(`(() => {
    const header = [...document.querySelectorAll('.l_V-RG_root')]
      .find(el => { const r = el.getBoundingClientRect(); return r.top > 60 && r.top < 500 })
    if (!header) return JSON.stringify({ err: 'no visible group header' })
    const hidden = document.querySelectorAll('.EvIC1a_flowItem[data-turn-process-hidden]')
    return JSON.stringify({
      label: header.textContent.trim().slice(0, 24),
      expanded: header.getAttribute('aria-expanded'),
      disabled: header.disabled === true,
      hiddenFlowItems: hidden.length,
      hiddenFlowItemsTall: [...hidden].filter(el => el.getBoundingClientRect().height > 0).length,
      processRows: document.querySelectorAll('.o3BgMG_row').length,
    })
  })()`)
  return JSON.parse(raw)
}

const clickHeader = async () => {
  await evaluate(`(() => {
    const header = [...document.querySelectorAll('.l_V-RG_root')]
      .find(el => { const r = el.getBoundingClientRect(); return r.top > 60 && r.top < 500 })
    header?.click()
    return 'clicked'
  })()`)
  await wait(800)
}

console.log(`fold check on port ${port}`)
let before = await headerState()
if (before.err) {
  console.error(before.err)
  process.exit(1)
}
if (before.disabled) {
  console.log(`the header "${before.label}" is disabled: this mode never folds (host design).`)
  console.log('pick a mode that folds (standard or compact) and run again.')
  process.exit(0)
}

const results = []
for (let round = 1; round <= rounds; round += 1) {
  before = await headerState()
  await clickHeader()
  const after = await headerState()
  const flipped = before.expanded !== after.expanded
  const folded = after.expanded === 'false'
  const rowsHidden = after.hiddenFlowItemsTall === 0
  results.push({ flipped, folded, rowsHidden })
  console.log(`round ${round}: ${before.expanded} -> ${after.expanded}`
    + ` | hidden flow items ${after.hiddenFlowItems} (tall ${after.hiddenFlowItemsTall})`
    + ` | process rows ${after.processRows} | ${flipped ? 'OK' : 'FAIL'}`)
}

const allFlipped = results.every(result => result.flipped)
const allRowsFollow = results.every(result => (result.folded ? result.rowsHidden : true))
console.log(`\nevery round flipped: ${allFlipped ? 'yes' : 'no'}`)
console.log(`the process rows follow the fold: ${allRowsFollow ? 'yes' : 'no'}`)
ws.close()
process.exit(allFlipped && allRowsFollow ? 0 : 1)
