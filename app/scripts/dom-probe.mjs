// Dev check: start the app on throwaway folders, read what a surface shows in the
// DOM, print it, optionally save a screenshot, and end the app.
//
// Usage: node scripts/dom-probe.mjs [out.png]
// Set DS_BOT_HOME and DS_BOT_SHELL_DATA to throwaway folders, plus the model
// variables for the Host (for the ds-bot mock model:
// DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/v1 and DEEPSEEK_API_KEY=mock-key).
//
// Environment:
//   PROBE_SURFACE  'bot' (the team interface, the default) or 'agent' (the classic page)
//   PROBE_SEND     '1' to type a message and send it before reading
//   PROBE_WAIT     seconds to wait for the app to settle (default 20)
//
// It reads, never writes: the folders it is given are throwaway ones.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const out = process.argv[2]
const wait = Number(process.env.PROBE_WAIT ?? 20)
const surface = process.env.PROBE_SURFACE ?? 'bot'
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

// What to read off the page. The probe runs inside the browser, so it sees the
// real layout: every box, every rule, every stylesheet the page ended up with.
const PROBE = `(() => {
  const root = document.documentElement
  const box = (el) => {
    if (!el) return undefined
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const overlaps = (a, b) => a && b && !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
  const cls = (el) => (el?.className || '').toString()

  // Our own classes are on the page; which of them have no rule anywhere?
  const ourClasses = new Set()
  for (const el of document.querySelectorAll('[class*="bt-"]')) {
    for (const name of cls(el).split(/\\s+/)) if (name.startsWith('bt-')) ourClasses.add(name)
  }
  const allRules = []
  for (const sheet of document.styleSheets) {
    try {
      const visit = (rules) => {
        for (const rule of rules) {
          if (rule.selectorText) allRules.push(rule.selectorText)
          if (rule.cssRules) visit(rule.cssRules)
        }
      }
      visit(sheet.cssRules)
    } catch { /* a cross-origin sheet */ }
  }
  const styled = (name) => allRules.some(sel => sel.includes('.' + name))
  const unstyled = [...ourClasses].filter(name => !styled(name)).sort()

  // The footer: the shell's own area, and every piece drawn in it.
  const area = document.querySelector('[class*="_footArea"]')
  const account = document.querySelector('.bt-foot-account')
  const gear = document.querySelector('.bt-you')
  const aide = [...document.querySelectorAll('button')].find(b => /AIDE/i.test(b.getAttribute('aria-label') || ''))
  const settings = document.querySelector('[class*="_settingsArea"]')
  const trigger = settings?.querySelector('button')
  const areaBox = box(area)
  const inside = (b) => b && areaBox && b.x >= areaBox.x && b.y >= areaBox.y
    && b.x + b.w <= areaBox.x + areaBox.w && b.y + b.h <= areaBox.y + areaBox.h

  // Our own stylesheets: the tag says which is which.
  const ownSheets = [...document.querySelectorAll('style[data-dsh-bot]')].map(el => ({
    tag: el.dataset.dshBot,
    len: el.textContent.length,
    hasBtYou: el.textContent.includes('.bt-you'),
    hasTheme: el.textContent.includes('--bt-ink:'),
  }))

  // The theme variables our rules read. They live on the body element.
  const bodyStyle = getComputedStyle(document.body)
  const vars = {}
  for (const name of ['--bt-ink', '--bt-ink-2', '--bt-line', '--bt-main', '--bt-hover', '--bt-sidebar', '--bt-accent']) {
    vars[name] = bodyStyle.getPropertyValue(name).trim()
  }

  // The usage line under the input: the host's own pills carry data-composer-stat.
  const hostStats = [...document.querySelectorAll('[data-composer-stat]')].map(el => ({
    stat: el.getAttribute('data-composer-stat'),
    text: (el.textContent || '').trim().slice(0, 60),
    box: box(el),
  }))
  const ourPills = [...document.querySelectorAll('[class*="bt-"]')].filter(el => {
    const c = cls(el)
    return c.includes('bt-') && /usage|stat|pill|ctx|context|token|cache|speed/i.test(c)
  }).map(el => ({ cls: cls(el).slice(0, 40), text: (el.textContent || '').trim().slice(0, 40), box: box(el) }))
  const input = document.querySelector('textarea, [contenteditable="true"]')
  const inputBox = box(input)
  const composerDock = document.querySelector('[data-composer-dock]')
  // The host's own dock: what it holds.
  const dockChildren = composerDock ? [...composerDock.children].map(el => ({
    cls: cls(el).slice(0, 50),
    text: (el.textContent || '').trim().slice(0, 60),
    box: box(el),
  })) : []
  // Every session the page knows about: the pills read each session's own
  // projections, so a session that ran a turn carries tokenUsage.
  const sessionRows = [...document.querySelectorAll('[data-session-id], [data-session]')].map(el => ({
    id: el.getAttribute('data-session-id') ?? el.getAttribute('data-session'),
    cls: cls(el).slice(0, 40),
    text: (el.textContent || '').trim().slice(0, 50),
  })).slice(0, 12)
  // The page's own session store: every session it knows, with the projections
  // the Host sent for it. This is where the pills' numbers come from.
  const store = window.__dsbSessionStore
  const storeInfo = store === undefined ? undefined : (() => {
    try {
      const byId = store.getSnapshot?.().byId ?? {}
      const out = []
      for (const [id, s] of Object.entries(byId)) {
        out.push({
          id,
          title: (s?.title ?? '').slice(0, 30),
          hasTokenUsage: s?.projections?.values?.tokenUsage !== undefined,
          hasSessionStats: s?.projections?.values?.sessionStats !== undefined,
          hasContextPressure: s?.projections?.values?.contextPressure !== undefined,
          projectionKeys: Object.keys(s?.projections?.values ?? {}),
        })
      }
      return out.slice(0, 8)
    } catch (error) { return { error: String(error) } }
  })()

  return JSON.stringify({
    title: document.title,
    surface: root.dataset.btSurface,
    unstyled,
    vars,
    ownSheets,
    footer: {
      areaFound: area !== null,
      areaBox,
      areaStyle: area ? (() => {
        const s = getComputedStyle(area)
        return { display: s.display, gridTemplateColumns: s.gridTemplateColumns }
      })() : undefined,
      gearBox: box(gear),
      gearStyle: gear ? (() => {
        const s = getComputedStyle(gear)
        return { width: s.width, height: s.height, borderRadius: s.borderRadius }
      })() : undefined,
      aideBox: box(aide),
      accountBox: box(account),
      triggerBox: box(trigger),
      gearInsideFooter: inside(box(gear)),
      aideInsideFooter: inside(box(aide)),
      gearOverlapsAide: overlaps(box(gear), box(aide)),
      gearOverlapsTrigger: overlaps(box(gear), box(trigger)),
    },
    usage: {
      ourPillCount: ourPills.length,
      ourPills: ourPills.slice(0, 6),
      hostStatCount: hostStats.length,
      hostStats,
      inputBox,
      composerDockFound: composerDock !== null,
      dockChildren,
      sessionRows,
      storeInfo,
    },
  })
})()`

try {
  const page = await appPage(Date.now() + 60_000)
  const cdp = devtools(page.webSocketDebuggerUrl)
  await cdp.opened
  await sleep(wait * 1000)
  // The surface to look at: the mode is a preference the page reads at boot.
  await cdp.call('Runtime.evaluate', { expression: `localStorage.setItem('ds-bot:surface', ${JSON.stringify(surface)})` })
  await cdp.call('Page.reload')
  await sleep(wait * 1000)
  // Open a Bot's chat: the composer's dock only mounts with a session behind it.
  const opened = await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      const wanted = ${JSON.stringify(process.env.PROBE_OPEN ?? '')}
      const rows = [...document.querySelectorAll('[data-bot-id]')]
      const row = wanted ? rows.find(r => (r.getAttribute('aria-label') ?? '').includes(wanted)) : rows[0]
      if (!row) return 'no row'
      row.click()
      return 'clicked ' + (row.getAttribute('aria-label') ?? row.getAttribute('data-bot-id') ?? '')
    })()`,
    returnByValue: true,
  })
  console.log(`opened: ${String(opened?.result?.value ?? '')}`)
  await sleep(wait * 1000)
  // Send a message so the host's own pills have something to show: they read the
  // session's own statistics, which a fresh page has none of.
  if (process.env.PROBE_SEND === '1') {
    await cdp.call('Runtime.evaluate', {
      expression: `(() => {
        const input = document.querySelector('textarea, [contenteditable="true"]')
        if (!input) return 'no input'
        const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype : HTMLElement.prototype, 'value')?.set
        if (setter) setter.call(input, 'hello')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return 'typed'
      })()`,
      returnByValue: true,
    })
    await sleep(500)
    await cdp.call('Runtime.evaluate', {
      expression: `(() => {
        const btn = [...document.querySelectorAll('button')].find(b => /send|发送/i.test(b.getAttribute('aria-label') || ''))
        if (btn) { btn.click(); return 'clicked' }
        const input = document.querySelector('textarea, [contenteditable="true"]')
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return 'entered'
      })()`,
      returnByValue: true,
    })
    await sleep(wait * 1000)
  }
  // The host's own session list: each row carries the projection hints the pills
  // read. The page is already authenticated, so it can ask for them.
  const hostSessions = await cdp.call('Runtime.evaluate', {
    expression: `(async () => {
      try {
        const r = await fetch('/api/sessions')
        const j = await r.json()
        const items = j?.items ?? j?.sessions ?? []
        return JSON.stringify({
          status: r.status,
          count: items.length,
          rows: items.slice(0, 8).map(s => ({
            id: s.sessionId ?? s.id,
            title: String(s.title ?? '').slice(0, 24),
            projectionKeys: s.projections?.values ? Object.keys(s.projections.values) : undefined,
            tokenUsage: s.projections?.values?.tokenUsage,
          })),
        })
      } catch (e) { return JSON.stringify({ error: String(e) }) }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  console.log(`host sessions: ${String(hostSessions?.result?.value ?? '')}`)

  const { result } = await cdp.call('Runtime.evaluate', { expression: PROBE, returnByValue: true })
  console.log(`probe: ${String(result.value)}`)
  if (out !== undefined) {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(out), Buffer.from(data, 'base64'))
    console.log(`probe: saved ${resolve(out)}`)
  }
  void cdp.call('Runtime.evaluate', { expression: 'window.close()' }).catch(() => undefined)
  await sleep(2000)
  // The tray's Quit ends the app. The script cannot click the tray icon, so it asks
  // the browser target of the debugging port to close, which ends the app gracefully.
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
  console.error('dom-probe: the app did not exit after the quit')
  child.kill()
  process.exitCode = 1
}
process.exit()
