// 群聊自绘验证：用 CDP 驱动一个隔离的应用实例（假模型、一次性数据目录），
// 建两个 Bot、建群、发消息，把真实 DOM 与截图拿出来，核对：
//   1) 群里没有「已调用工具」折叠标题，没有工具名/参数/输出明细；
//   2) 成员回复气泡原地显示在工具座位里，成员名、时间都在；
//   3)「正在输入」提示出现在成员气泡之前，回复到达后消失、不叠加。
// 用法：node scripts/verify-group-ui.mjs <out-dir>
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const [outDir = 'tmp/group-ui'] = process.argv.slice(2)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '..')
// The screenshots land outside app/: the builder ships app/tmp inside the asar, and
// a verification run is not part of the product.
const out = resolve(repo, outDir)
mkdirSync(out, { recursive: true })
const electron = createRequire(import.meta.url)('electron')
const port = 9600 + Math.floor(Math.random() * 300)
const mockPort = 9800 + Math.floor(Math.random() * 100)
// 一次性目录：绝不用用户自己的数据。
const home = resolve(repo, 'tmp', 'verify-home')
const shellData = resolve(repo, 'tmp', 'verify-shell')
rmSync(home, { recursive: true, force: true })
rmSync(shellData, { recursive: true, force: true })

const env = {
  ...process.env,
  DS_BOT_HOME: home,
  DS_BOT_SHELL_DATA: shellData,
  MOCK_PORT: String(mockPort),
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(mockPort)}/v1`,
  DEEPSEEK_API_KEY: 'mock-key',
}
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...cleanEnv } = env

// 假模型：回一句话，不调工具。
const mock = spawn(process.execPath, [join(repo, 'ds-bot', 'dev', 'mock-llm.mjs')], {
  stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv,
})
mock.stdout.on('data', d => process.stdout.write(`[mock] ${String(d)}`))
mock.stderr.on('data', d => process.stderr.write(`[mock] ${String(d)}`))
await sleep(1500)

const child = spawn(electron, [root, `--remote-debugging-port=${String(port)}`], { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv })
child.stdout.on('data', d => process.stderr.write(`[app] ${String(d)}`))
const exited = new Promise((done) => { child.once('exit', (code, signal) => done({ code, signal })) })

async function appPage(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const page = targets.find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//u.test(t.url))
      if (page) return page
    } catch { /* the port is not listening yet */ }
    await sleep(500)
  }
  throw new Error('verify: the app window did not appear')
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
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = next++
    pending.set(id, { resolve: done, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call, socket, close: () => socket.close() }
}

const probe = expression => `(() => {
  const conv = document.querySelector('[data-conversation-session]')
  const seat = document.querySelector('[data-chat-flow-kind="tool-call"]')
  const header = document.querySelector('[data-step-process] > div:first-child')
  const body = document.querySelector('[data-step-process] > [data-step-process-body]')
  const bubbles = [...document.querySelectorAll('.bt-group-msg')]
  const notices = [...document.querySelectorAll('.bt-activity')]
  const status = [...document.querySelectorAll('.bt-turn-status')]
  const all = [...document.querySelectorAll('.bt-activity, .bt-group-msg')]
  const i = all.findIndex(n => n.className === 'bt-activity')
  const j = all.findIndex(n => n.className === 'bt-group-msg')
  const text = conv?.innerText ?? ''
  return JSON.stringify({
    groupMarked: conv?.hasAttribute('data-bt-group-chat') ?? null,
    toolSeat: seat ? seat.getAttribute('data-chat-flow-kind') : null,
    toolSeatCount: document.querySelectorAll('[data-chat-flow-kind="tool-call"]').length,
    foldHeaderPresent: header !== null,
    foldHeaderVisible: header ? getComputedStyle(header).display !== 'none' : null,
    bodyDisplay: body ? getComputedStyle(body).display : null,
    bubbles: bubbles.length,
    notices: notices.length,
    turnStatusRows: status.length,
    turnStatusText: status.map(n => n.innerText.trim()),
    noticeBeforeBubble: i >= 0 && j >= 0 ? i < j : null,
    bubbleNames: bubbles.map(n => n.querySelector('.bt-group-name')?.textContent ?? ''),
    hasToolHeaderText: text.includes('已调用工具') || text.includes('Called tools'),
    text: text.slice(0, 1500),
  })
})()`

try {
  const page = await appPage(Date.now() + 120_000)
  const dev = devtools(page.webSocketDebuggerUrl)
  const socket = dev.socket
  await dev.opened
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await dev.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (exceptionDetails) throw new Error(`verify: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`)
    return result.value
  }
  // 浏览器控制台与未捕获异常：席位被顶掉时这里会有线索。
  const consoleLines = []
  dev.call('Runtime.enable').catch(() => undefined)
  dev.call('Log.enable').catch(() => undefined)
  const onEvent = (data) => {
    try {
      const message = JSON.parse(String(data))
      if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') {
        consoleLines.push(JSON.stringify(message.params).slice(0, 400))
      }
    } catch { /* not our message */ }
  }
  socket.addEventListener('message', onEvent)
  const shot = async (name) => {
    const { data } = await dev.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(out, name), Buffer.from(data, 'base64'))
    console.log(`verify: saved ${join(out, name)}`)
  }
  const api = async (endpoint, payload) => {
    const raw = await evaluate(`fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: ${JSON.stringify(endpoint)}, payload: ${JSON.stringify(payload ?? null)} }) }).then(r => r.text())`)
    const result = JSON.parse(raw)
    if (!result.ok) throw new Error(`verify: ${endpoint}: ${result.error?.message}`)
    return result.value
  }

  // 等应用起来：团队界面出现了就继续。
  let ready = false
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const body = String(await evaluate('document.body.innerText'))
    if (body.includes('智能工作台') || body.includes('LinkHarness')) { ready = true; break }
  }
  if (!ready) throw new Error('verify: the app did not come up')
  await sleep(8000)

  // 建两个 Bot 与一个群。
  await api('create-bot', { name: 'Writer', role: 'Writer' })
  await api('create-bot', { name: 'Coder', role: 'Engineer' })
  await sleep(2000)
  const state = await api('state', {})
  const writer = state.bots.find(bot => bot.name === 'Writer')
  const coder = state.bots.find(bot => bot.name === 'Coder')
  console.log('verify: bots =', writer?.id, coder?.id)
  const room = await api('create-room', { members: [writer.id, coder.id] })
  console.log('verify: room =', room.id, room.name)
  await sleep(3000)

  // 打开这个群：点侧栏里的群行。
  const opened = await evaluate(`(() => {
    const row = document.querySelector('.bt-row[data-room-id="${room.id}"]')
    if (!row) return 'no-row'
    row.click()
    return 'clicked'
  })()`)
  console.log('verify: open room =', opened)
  await sleep(2500)
  await shot('01-group-open.png')

  // 发一句话，触发成员回复。
  const before = Date.now()
  await api('send', { sessionId: room.id, text: '大家好，各自说一句' })
  console.log('verify: sent at', new Date(before).toISOString())

  // 每 250ms 采一次 DOM：抓「提示出现」与「提示消失」两个时刻。
  let firstNotice = null
  let firstBubble = null
  let afterBubble = null
  for (let i = 0; i < 120; i++) {
    await sleep(250)
    const raw = await evaluate(probe())
    const dom = JSON.parse(raw)
    if (dom.notices > 0 && firstNotice === null) {
      firstNotice = { at: Date.now() - before, dom }
      await shot('02-typing-notice.png')
      console.log('verify: 提示出现，用时', firstNotice.at, 'ms；DOM =', raw.slice(0, 600))
    }
    if (dom.bubbles > 0 && firstBubble === null) {
      firstBubble = { at: Date.now() - before, dom }
      console.log('verify: 气泡出现，用时', firstBubble.at, 'ms')
    }
    if (firstBubble !== null && dom.notices === 0) {
      afterBubble = { at: Date.now() - before, dom }
      await shot('03-reply-done.png')
      console.log('verify: 提示消失，用时', afterBubble.at, 'ms；DOM =', raw.slice(0, 600))
      break
    }
  }
  const finalDom = JSON.parse(await evaluate(probe()))
  console.log('verify: 最终 DOM =', JSON.stringify(finalDom))
  await shot('04-final.png')
  writeFileSync(join(out, 'dom.json'), JSON.stringify({ firstNotice, firstBubble, afterBubble, finalDom }, null, 2))

  // 单聊：普通工具交给宿主自己的视图画（形态2）。
  const openedChat = await evaluate(`(() => {
    const row = document.querySelector('.bt-row[data-bot-id="${writer.id}"]')
    if (!row) return 'no-row'
    row.click()
    return 'clicked'
  })()`)
  console.log('verify: open private chat =', openedChat)
  await sleep(2500)
  // 让它调一次普通工具（假模型在「长任务」这句下会真的调一次 list_bots，
  // 那不是团队工具，宿主树会把它派给宿主自己的视图），单聊里应当画出来。
  await api('send', { sessionId: writer.id, text: '长任务 2' })
  await sleep(12000)
  const privateDom = JSON.parse(await evaluate(`(() => {
    const conv = document.querySelector('[data-conversation-session]')
    const header = document.querySelector('[data-step-process] > div:first-child')
    const body = document.querySelector('[data-step-process] > [data-step-process-body]')
    const seat = document.querySelector('[data-chat-flow-kind="tool-call"]')
    const text = conv?.innerText ?? ''
    // 宿主工具视图的行：宿主给它的容器带 data-chat-call-id。
    const hostRows = [...document.querySelectorAll('[data-chat-call-id]')]
    return JSON.stringify({
      groupMarked: conv?.hasAttribute('data-bt-group-chat') ?? null,
      toolSeat: seat ? seat.getAttribute('data-chat-flow-kind') : null,
      toolSeatCount: document.querySelectorAll('[data-chat-flow-kind="tool-call"]').length,
      foldHeaderPresent: header !== null,
      foldHeaderVisible: header ? getComputedStyle(header).display !== 'none' : null,
      bodyDisplay: body ? getComputedStyle(body).display : null,
      // 团队自己的行（事件行 / 成员气泡）还在不在
      events: document.querySelectorAll('.bt-event').length,
      bubbles: document.querySelectorAll('.bt-group-msg').length,
      // 宿主工具视图画的行：带 data-chat-call-id 的容器
      hostToolRows: hostRows.length,
      hostToolRowText: hostRows.map(n => n.innerText.slice(0, 120)),
      hasToolHeaderText: text.includes('已调用工具') || text.includes('Called tools'),
      text: text.slice(0, 900),
    })
  })()`))
  console.log('verify: 单聊 DOM =', JSON.stringify(privateDom))
  console.log('verify: 控制台 =', consoleLines.slice(0, 12).join('\n  '))
  await shot('05-private-chat.png')
  writeFileSync(join(out, 'dom-private.json'), JSON.stringify(privateDom, null, 2))

  // 展开那一行，给用户看展开态（参数与输出）。
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-chat-call-id]')].find(n => n.querySelector('details'))
    const details = row?.querySelector('details')
    if (details) { details.open = true; details.dispatchEvent(new Event('toggle')) }
    return details !== undefined
  })()`)
  await sleep(1200)
  await shot('06-private-chat-expanded.png')

  dev.close()
  void child.kill()
  mock.kill()
  process.exit(0)
} catch (error) {
  console.error('verify:', error)
  child.kill()
  mock.kill()
  process.exitCode = 1
}
