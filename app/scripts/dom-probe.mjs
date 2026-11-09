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
    connected: el.isConnected,
    parent: el.parentElement?.tagName,
    hasBtYou: el.textContent.includes('.bt-you'),
    hasAgentRule: el.textContent.includes('data-bt-surface=agent'),
    hasTheme: el.textContent.includes('--bt-ink:'),
    // The foot area rule: what the compiled text turned into.
    footRule: (el.textContent.match(/[^{}]*_footArea[^{}]*\{[^}]*\}/g) ?? []).slice(0, 2),
    youRule: (el.textContent.match(/[^{}]*bt-you[^{}]*\{[^}]*\}/g) ?? []).slice(0, 3),
  }))
  // Every style element in the head, so a table that never landed is visible.
  const headStyles = [...document.querySelectorAll('head style')].map(el => ({
    plugin: el.dataset.plugin ?? undefined,
    dshBot: el.dataset.dshBot ?? undefined,
    len: el.textContent.length,
  }))
  // Is our module loaded at all, and what did it install?
  const areaStyle = area ? (() => {
    const s = getComputedStyle(area)
    return { display: s.display, gridTemplateColumns: s.gridTemplateColumns }
  })() : undefined
  // Which of our own classes are on the page but have no rule in any loaded sheet:
  // those are the styles the classic page lost with the shell group.
  const ourClasses = new Set()
  for (const el of document.querySelectorAll('[class*="bt-"]')) {
    for (const name of (el.className || '').toString().split(/\s+/)) {
      if (name.startsWith('bt-')) ourClasses.add(name)
    }
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
    } catch { /* cross-origin sheet */ }
  }
  const styled = (cls) => allRules.some(sel => sel.includes('.' + cls))
  const unstyled = [...ourClasses].filter(cls => !styled(cls)).sort()
  // The theme variables our rules read: are they set? They live on the body element.
  const bodyStyle = getComputedStyle(document.body)
  const vars = {}
  for (const name of ['--bt-ink', '--bt-ink-2', '--bt-line', '--bt-main', '--bt-hover', '--bt-sidebar', '--bt-accent', '--bt-glass-bg']) {
    vars[name] = bodyStyle.getPropertyValue(name).trim()
  }

  return JSON.stringify({
    title: document.title,
    surface: root.dataset.btSurface,
    unstyled,
    vars,
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
    headStyles,
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
  // The experiment: put the base rules of our own icons on the classic page and
  // see whether the icons take their own shape again.
  if (process.env.PROBE_INJECT === '1') {
    await cdp.call('Runtime.evaluate', {
      expression: `(() => {
        const style = document.createElement('style')
        style.textContent = [
          '.bt-round{width:36px;height:36px;border-radius:50%;border:1px solid var(--bt-line);background:var(--bt-main);color:var(--bt-ink);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}',
          '.bt-you{width:36px;height:36px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--bt-ink) 5%,var(--bt-sidebar));color:var(--bt-ink-2);box-shadow:inset 0 0 0 1px var(--bt-line)}',
          '.bt-you-wrap{display:inline-flex;padding:0}',
          '.bt-account{flex:none;width:36px;height:36px;border:0;padding:0;background:none;border-radius:50%;cursor:pointer;display:inline-flex}',
          '.bt-brand-whale{display:inline-flex;color:var(--bt-accent)}',
          '.bt-brand-name{font-weight:600;font-size:14px;white-space:nowrap}',
        ].join('')
        document.head.appendChild(style)
        return 'injected'
      })()`,
    })
    await sleep(1500)
  }
  // The console the page printed: a failed install says so.
  const { result: logs } = await cdp.call('Runtime.evaluate', {
    expression: `(window.__dsbLogs ?? []).slice(0, 20)`,
    returnByValue: true,
  })
  console.log(`page logs: ${JSON.stringify(logs?.value ?? [])}`)
  // What our module installed, and whether those tables are still in the document.
  const { result: moduleInfo } = await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      const sheets = [...document.querySelectorAll('style')]
      return JSON.stringify({
        total: sheets.length,
        dsBot: sheets.filter(s => s.dataset.plugin === 'ds-bot').map(s => [s.dataset.dshBot, s.textContent.length, s.isConnected]),
      })
    })()`,
    returnByValue: true,
  })
  console.log(`module: ${String(moduleInfo?.value ?? '')}`)
  // Does the module's own code carry the base table? The bundled client keeps the
  // stylesheet text in its own source, so look for it there.
  const { result: bundle } = await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      const src = [...document.querySelectorAll('script')].map(s => s.textContent).join('')
      const at = src.indexOf('installCompiledStyles(BASE_CSS')
      return JSON.stringify({ found: at !== -1, around: at === -1 ? '' : src.slice(at - 60, at + 90) })
    })()`,
    returnByValue: true,
  })
  console.log(`bundle: ${String(bundle?.value ?? '')}`)
  // Call the same install the module calls, and report what it throws.
  const { result: installTry } = await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      try {
        const style = document.createElement('style')
        style.dataset.dshBot = 'probe'
        style.dataset.plugin = 'ds-bot'
        style.textContent = ''
        document.head.appendChild(style)
        const names = new Set()
        for (const sheet of document.styleSheets) {
          if (sheet.ownerNode?.dataset?.dshBot) continue
          let list = []
          try {
            const visit = (rules) => {
              for (const rule of rules) {
                if (rule.selectorText) for (const m of rule.selectorText.matchAll(/\\.((?:\\\\.|[\\w-])+)/g)) list.push(m[1])
                if (rule.cssRules) visit(rule.cssRules)
              }
            }
            visit(sheet.cssRules)
          } catch { /* cross-origin */ }
          for (const n of list) names.add(n)
        }
        return JSON.stringify({ ok: true, names: names.size })
      } catch (error) {
        return JSON.stringify({ ok: false, message: error?.message ?? String(error), stack: String(error?.stack ?? '').slice(0, 300) })
      }
    })()`,
    returnByValue: true,
  })
  console.log(`install try: ${String(installTry?.value ?? '')}`)
  // Which script did the page load? The module loader's source shows the file.
  const { result: sources } = await cdp.call('Runtime.evaluate', {
    expression: `(() => {
      const mods = window.__ModuleLoader__?.modules ?? window.__ModuleLoader__?.registry
      const out = []
      try {
        for (const key of Object.keys(mods ?? {})) {
          const m = mods[key]
          out.push([key, typeof m === 'function' ? 'fn' : typeof m, String(m?.url ?? m?.source ?? '').slice(0, 120)])
        }
      } catch (e) { out.push(['err', e.message]) }
      return JSON.stringify({ keys: Object.keys(window.__ModuleLoader__ ?? {}), mods: out.slice(0, 10) })
    })()`,
    returnByValue: true,
  })
  console.log(`loader: ${String(sources?.value ?? '')}`)
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
