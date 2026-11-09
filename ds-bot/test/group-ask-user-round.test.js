import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The whole line of #11: a member asks a question in a group chat, the user taps
// an option, and the answer comes back into the group addressed to that member —
// so the group round picks it up and calls that member, and the round goes on.
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
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-ask-round-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const sent = []
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) {
      const inbox = {
        nextTurn: [],
        nextStep: [],
        remove(id) {
          for (const list of [inbox.nextTurn, inbox.nextStep]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      inboxes.set(sessionId, inbox)
    }
    return inboxes.get(sessionId)
  }
  const agentOf = (sessionId) => {
    const inbox = inboxOf(sessionId)
    return { session: { id: sessionId }, inbox, followup(message) { sent.push({ sessionId, message }) }, steer(message) { sent.push({ sessionId, message }) }, cancel() {} }
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      prompt: async (request) => {
        // As DSH holds it: the message waits in the Session's inbox until the
        // group's relay takes it up. The group host reads it there.
        const inbox = inboxOf(request.sessionId)
        inbox[request.mode === 'steer' ? 'nextStep' : 'nextTurn'].push({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
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
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const state = async () => (await call('state', {})).value
  const relay = (callId, signal = new AbortController().signal) => tool('group_relay', {}, 'r1', { callId, signal, agent: { id: 'r1', inbox: inboxOf('r1') } })  // The member's turn, played back through the session events.
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  await tool('list_bots', {}, 'a')
  return { rt, ctx, emit, tool, call, state, relay, answer, sent, inboxOf }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}

test('the answer to a group card opens a round that calls the Bot that asked', async (t) => {
  const { tool, call, state, relay, answer, sent, rt } = await start(t)

  // The Writer asks the user a question in the group.
  await tool('ask_user', { question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }, 'gb', { callId: 'c1' })
  const card = (await state()).questions.r1
  assert.ok(card, 'the card is on the group\'s own Session')

  // The user taps an option.
  assert.equal((await call('answer-question', { sessionId: 'r1', questionId: card.id, answer: { selected: ['B'] } })).ok, true)

  // The answer is the user's own message in the group, so the relay opens a round.
  const running = relay('relay')
  // The relay opens with the admin (the group's own Session had no other post), and
  // the user's answer joins that round and calls the Bot that asked.
  const admin = await waitFor(() => sent.find(entry => entry.sessionId === 'ga' && entry.message.source.role === 'room'))
  assert.ok(admin, 'the admin opens the round')
  const turn = await waitFor(() => sent.find(entry => entry.sessionId === 'gb' && entry.message.source.role === 'room'))
  assert.ok(turn, 'the Bot that asked gets a turn')
  const prompt = turn.message.content[0].text
  assert.match(prompt, /@Writer the user answered your question "Which one\?": B/)
  assert.match(prompt, /User: @Writer the user answered your question/, 'the answer reads as the user\'s own line')

  // The group log shows the answer as the user's line.
  const log = rt.state.rooms.r1.log.filter(line => line.who === 'User' && line.text !== '')
  assert.equal(log.length, 1)
  assert.match(log[0].text, /@Writer the user answered your question/)

  await answer(admin.sessionId, admin.message.source.exchangeId, 'Noted.', 1)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'B it is.', 2)
  const result = JSON.parse(await running)
  assert.ok(result.replies.some(reply => reply.text === 'B it is.'), 'the Writer answers in the group')
  assert.ok(result.replies.some(reply => reply.kind === 'user'), 'the answer is the user\'s line in the round')
})

test('a card asked in a group is answered in the group, not in the asker\'s own chat', async (t) => {
  const { tool, call, state, sent } = await start(t)
  await tool('ask_user', { question: 'Which one?', options: [{ label: 'A' }] }, 'gb', { callId: 'c1' })
  const card = (await state()).questions.r1
  await call('answer-question', { sessionId: 'r1', questionId: card.id, answer: { selected: ['A'] } })
  // Nothing was delivered into the Writer's own chat.
  assert.equal(sent.filter(entry => entry.sessionId === 'b').length, 0)
  assert.equal(sent.filter(entry => entry.sessionId === 'gb').length, 0)
})
