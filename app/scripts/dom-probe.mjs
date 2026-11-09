// Dev check: start the app on throwaway folders, read what the classic page's footer
// looks like in the DOM, print it, and end the app.
// Usage: node scripts/dom-probe.mjs [seconds to wait] [out.png]
// Set DS_BOT_HOME and DS_BOT_SHELL_DATA to throwaway folders, plus the model variables for the Host.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const wait = Number(process.argv[2] ?? 25)
const out = process.argv[3]
if (!process.env.DS_BOT_HOME || !process.env.DS_BOT_SHELL_DATA) {
  console.error('dom-probe: set DS_BOT_HOME and DS_BOT_SHELL_DATA to throwaway folders')
  process.exit(2)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const port = 9300 + Math.floor(Math.random() * 600)
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
const child = spawn(electron, [root, `--remote-debugging-port=${String(port)}`], { stdio: 'inherit', env })
const exited = new Promise((done) => { child.once('exit', (code, signal) => { done({ code, signal }) }) })

async function appPage(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url))
      if (page) return page
    } catch { /* the debugging port is not listening yet */ }
    await sleep(500)
  }
  throw new Error('dom-probe: the app window did not appear')
}

function devtools(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call, close: () => { socket.close() } }
}

// What the footer holds, and where each piece sits.
const PROBE = `(() => {
  const root = document.documentElement
  const box = (el) => {
    if (!el) return undefined
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const overlaps = (a, b) => a && b && !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
  // The shell's footer: the area that holds the account entry, the settings trigger and
  // the actions the plugins added (ours among them).
  const area = document.querySelector('[class*="_footArea"]')
  const account = document.querySelector('.bt-foot-account')
  const aideButtons = [...document.querySelectorAll('button')].filter(b => /AIDE/i.test(b.getAttribute('aria-label') || ''))
  const settings = document.querySelector('[class*="_settingsArea"]')
  const actions = document.querySelector('[class*="_footerActions"]')
  // Where each piece sits, and whether the shell's own settings button and our gear
  // share one spot. The gear is the account entry: in the classic page it fills the
  // shell's settings trigger, so the two are the same box and must not overlap.
  const trigger = settings ? settings.querySelector('button') : null
  const you = document.querySelector('.bt-you')
  const gear = document.querySelector('.bt-you-wrap') ?? you
  const gearBox = box(gear)
  const triggerBox = box(trigger)
  const areaBox = box(area)
  const inside = (b) => b && areaBox && b.x >= areaBox.x && b.y >= areaBox.y
    && b.x + b.w <= areaBox.x + areaBox.w && b.y + b.h <= areaBox.y + areaBox.h
  // Every element that draws inside the foot area, so a stacked pair shows up.
  const painted = area ? [...area.querySelectorAll('button, .bt-you, .bt-round, [class*="_trigger"]')].map(el => ({
    cls: (el.className || '').toString().slice(0, 50),
    aria: el.getAttribute('aria-label'),
    box: box(el),
  })) : []
  const children = area ? [...area.children].map(el => ({
    cls: (el.className || '').toString().slice(0, 60),
    box: box(el),
  })) : []
  const accountBox = box(account)
  const aideBox = box(aideButtons.find(b => box(b).y > 600) ?? aideButtons[0])
  const settingsBox = box(settings)
  const youStyle = you ? (() => {
    const s = getComputedStyle(you)
    return {
      width: s.width, height: s.height, borderRadius: s.borderRadius,
      boxShadow: s.boxShadow, background: s.backgroundColor,
    }
  })() : undefined
  // Which rules actually apply to the gear: the sheets that mention it, and whether
  // the agent-scoped one is among them.
  const sheets = [...document.styleSheets].flatMap(sheet => {
    try { return [...sheet.cssRules] } catch { return [] }
  })
  const gearRules = sheets.filter(r => r.selectorText && r.selectorText.includes('.bt-you'))
    .map(r => r.cssText.slice(0, 160))
  const matchesAgent = sheets.filter(r => r.selectorText && r.selectorText.includes('data-bt-surface=agent') && r.selectorText.includes('bt-you'))
    .map(r => r.cssText.slice(0, 200))
  // Our own sheets carry a tag; the compiled text is what actually applies.
  const ownSheets = [...document.querySelectorAll('style[data-dsh-bot]')].map(el => ({
    tag: el.dataset.dshBot,
    len: el.textContent.length,
    hasBtYou: el.textContent.includes('.bt-you'),
    hasAgentRule: el.textContent.includes('data-bt-surface=agent'),
    // The compiled fragment selectors: what the foot area rule turned into.
    footRule: (el.textContent.match(/[^{}]*_footArea[^{}]*\{[^}]*\}/g) ?? []).slice(0, 2),
    youRule: (el.textContent.match(/[^{}]*bt-you[^{}]*\{[^}]*\}/g) ?? []).slice(0, 3),
  }))
  const areaStyle = area ? (() => {
    const s = getComputedStyle(area)
    return { display: s.display, gridTemplateColumns: s.gridTemplateColumns }
  })() : undefined
  return JSON.stringify({
    title: document.title,
    surface: root.dataset.btSurface,
    footAreaFound: area !== null,
    footAreaBox: areaBox,
    footAreaStyle: areaStyle,
    footAreaChildren: children,
    painted,
    accountFound: account !== null,
    accountBox,
    settingsBox,
    triggerBox,
    youFound: you !== null,
    youBox: box(you),
    youStyle,
    gearRules,
    matchesAgent,
    ownSheets,
    gearBox,
    gearInsideFoot: inside(gearBox),
    // The gear and the shell's own settings trigger are the same spot in the classic
    // page: the gear is drawn inside that trigger. They must not overlap the AIDE button.
    gearOverlapsTrigger: overlaps(gearBox, triggerBox),
    gearOverlapsAide: overlaps(gearBox, aideBox),
    aideCount: aideButtons.length,
    aideBox,
    aideInFooter: inside(aideBox),
    accountOverlapsAide: overlaps(accountBox, aideBox),
    accountOverlapsSettings: overlaps(accountBox, settingsBox),
    aideOverlapsSettings: overlaps(aideBox, settingsBox),
  })
})()`

try {
  const page = await appPage(Date.now() + 60_000)
  const cdp = devtools(page.webSocketDebuggerUrl)
  await cdp.opened
  await sleep(wait * 1000)
  // The classic (Agent) surface: the mode is a preference the page reads at boot.
  if (process.env.PROBE_SURFACE === 'agent') {
    await cdp.call('Runtime.evaluate', { expression: "localStorage.setItem('ds-bot:surface', 'agent')" })
    await cdp.call('Page.reload')
    await sleep(wait * 1000)
  }
  const { result } = await cdp.call('Runtime.evaluate', { expression: PROBE, returnByValue: true })
  console.log(`probe: ${String(result.value)}`)
  if (out !== undefined) {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(out), Buffer.from(data, 'base64'))
    console.log(`probe: saved ${resolve(out)}`)
  }
  void cdp.call('Runtime.evaluate', { expression: 'window.close()' }).catch(() => undefined)
  await sleep(2000)
  const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
  const browser = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    browser.addEventListener('open', done, { once: true })
    browser.addEventListener('error', reject, { once: true })
  })
  browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  browser.close()
} catch (error) {
  console.error(error)
  child.kill()
  process.exitCode = 1
}
const outcome = await Promise.race([exited, sleep(40_000).then(() => undefined)])
if (outcome === undefined) {
  console.error('probe: the app did not exit after the quit')
  child.kill()
  process.exitCode = 1
}
process.exit()
