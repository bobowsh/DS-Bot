import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Chief (the admin) speaks in group 'r1' from 'ga'; Writer from 'gb'. The group's own
// Session is 'r1' itself: the chat the user reads and writes in.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-ask-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const prompts = []
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const inbox = { nextStep: [], nextTurn: [], remove() { return false } }
      agents.set(sessionId, { session: { id: sessionId }, calls, inbox, followup(message) { calls.push(message) }, steer(message) { calls.push(message) }, cancel() {} })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      prompt: async (request) => {
        prompts.push(request)
        const inbox = agentOf(request.sessionId).inbox
        inbox[request.mode === 'steer' ? 'nextStep' : 'nextTurn'].push({ id: `m${prompts.length}`, role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
        return { accepted: true }
      },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const state = async () => (await call('state', {})).value
  await tool('list_bots', {}, 'a')
  return { rt, ctx, emit, tool, call, state, prompts, agentOf }
}

test('a card asked in a group chat sits on the group\'s own Session, where the user reads it', async (t) => {
  const { tool, state } = await start(t)
  const ended = { value: false }
  const result = await tool('ask_user', { question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }, 'ga', {
    callId: 'c1',
    concludeTurn() { ended.value = true },
  })
  assert.match(result, /on screen in the group chat/)
  assert.equal(ended.value, true, 'the asking member\'s turn ends at once')

  const questions = (await state()).questions
  assert.deepEqual(Object.keys(questions), ['r1'], 'the card lives on the group\'s own Session')
  const card = questions.r1
  assert.equal(card.question, 'Which one?')
  assert.equal(card.roomId, 'r1')
  assert.equal(card.askerBotId, 'a')
  assert.equal(card.askerSessionId, 'ga')
  assert.equal(card.callId, undefined, 'no call id: the card goes to the dock, not to a call row')
  assert.deepEqual(card.options.map(option => option.label), ['A', 'B'])
})

test('a second card in the same group is refused while the first waits', async (t) => {
  const { tool } = await start(t)
  await tool('ask_user', { question: 'One?', options: [{ label: 'A' }] }, 'ga', { callId: 'c1' })
  const second = await tool('ask_user', { question: 'Two?', options: [{ label: 'B' }] }, 'gb', { callId: 'c2' })
  assert.match(second, /already has a question card waiting/)
})

test('the user\'s answer goes back into the group, addressed to the Bot that asked', async (t) => {
  const { tool, call, state, prompts } = await start(t)
  await tool('ask_user', { question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }, 'ga', { callId: 'c1' })
  const card = (await state()).questions.r1

  const answered = await call('answer-question', { sessionId: 'r1', questionId: card.id, answer: { selected: ['B'] } })
  assert.equal(answered.ok, true)

  assert.equal((await state()).questions.r1, undefined, 'the card is gone once it is answered')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'r1', 'the answer goes into the group\'s own Session')
  const text = prompts[0].content.map(block => block.text).join('\n')
  assert.match(text, /@Chief/, 'the Bot that asked is named')
  assert.match(text, /B/)
  assert.doesNotMatch(text, /A/)
})

test('an answer the card did not offer is refused, and the card stays open', async (t) => {
  const { tool, call, state } = await start(t)
  await tool('ask_user', { question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }, 'ga', { callId: 'c1' })
  const card = (await state()).questions.r1

  const answered = await call('answer-question', { sessionId: 'r1', questionId: card.id, answer: { selected: ['Z'] } })
  assert.equal(answered.ok, false)
  assert.equal(answered.error.code, 'bot/invalid')
  assert.ok((await state()).questions.r1, 'the card is still open')
})

test('a second answer to the same card is refused', async (t) => {
  const { tool, call, state } = await start(t)
  await tool('ask_user', { question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }, 'ga', { callId: 'c1' })
  const card = (await state()).questions.r1
  assert.equal((await call('answer-question', { sessionId: 'r1', questionId: card.id, answer: { selected: ['A'] } })).ok, true)
  const again = await call('answer-question', { sessionId: 'r1', questionId: card.id, answer: { selected: ['A'] } })
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'bot/stale')
})

test('a card in a group can be dismissed, and the group is left without one', async (t) => {
  const { tool, call, state } = await start(t)
  await tool('ask_user', { question: 'Which one?', options: [{ label: 'A' }] }, 'ga', { callId: 'c1' })
  assert.equal((await call('dismiss-question', { sessionId: 'r1' })).ok, true)
  assert.equal((await state()).questions.r1, undefined)
})

test('a Bot\'s own chat keeps its own card, unchanged', async (t) => {
  const { tool, state } = await start(t)
  await tool('ask_user', { question: 'Which name?', options: [{ label: 'Lookout' }] }, 'a', { callId: 'c2' })
  const questions = (await state()).questions
  assert.ok(questions.a, 'the card is on the Bot\'s own chat')
  assert.equal(questions.a.callId, 'c2', 'the card stays at its call')
  assert.equal(questions.r1, undefined, 'nothing lands on the group')
})
