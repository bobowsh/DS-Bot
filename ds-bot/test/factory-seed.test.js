import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A team made by the user, none of it factory-seeded.
const userTeam = () => ({
  version: 1,
  mainBotIds: ['chief'],
  workspaceId: 'w1',
  bots: { chief: { id: 'chief', name: 'Chief', role: 'Boss', sessionId: 'chief', createdAt: 1 } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})

function seedFile(version, bots, capabilities) {
  return { version, bots, ...(capabilities ? { capabilities } : {}) }
}
const chief = factoryId => ({
  factoryId, name: 'Navigator', role: 'Chief', instructions: 'You run the team.', main: true,
  capabilities: ['review-skill'],
})
const helper = factoryId => ({ factoryId, name: 'Helper', role: 'Support', instructions: 'You help.' })

async function start({ state, seed, dshHome, bundledSeed }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-seed-')))
  const dsh = dshHome ?? join(root, 'dsh')
  const home = join(dsh, 'bot')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(state ?? userTeam()))
  if (seed) {
    mkdirSync(join(dsh, 'factory'), { recursive: true })
    writeFileSync(join(dsh, 'factory', 'factory-team.json'), JSON.stringify(seed))
  }
  // A packaged app also points at its own resources directory, read when the copy has not landed.
  const previousResources = process.env.DS_BOT_FACTORY_RESOURCES
  if (bundledSeed) {
    const res = join(root, 'resources')
    mkdirSync(join(res, 'factory'), { recursive: true })
    writeFileSync(join(res, 'factory', 'factory-team.json'), JSON.stringify(bundledSeed))
    process.env.DS_BOT_FACTORY_RESOURCES = res
  } else delete process.env.DS_BOT_FACTORY_RESOURCES
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh
  let count = 0
  const ctx = fakeContext()
  const registry = new Map([['w1', { id: 'w1', path: join(home, 'workspace'), title: 'DS Bot' }]])
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), defaultModel: () => undefined },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: 'w-new', path, title: 'DS Bot' }
        registry.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${(count += 1)}` }),
      resolveAgent: async () => ({ agent: null }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  // A created Bot's Session needs a resolvable Agent for its scoped tools; give the shape
  // tools.js expects without running a real agent.
  rt.resolveAgent = async sessionId => ({
    id: sessionId,
    session: { id: sessionId },
    ctx: { tools: { register: () => () => {}, restrict: () => {}, schemas: () => [] }, effect: () => {}, on: () => () => {} },
  })
  const stateOf = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousResources === undefined) delete process.env.DS_BOT_FACTORY_RESOURCES
    else process.env.DS_BOT_FACTORY_RESOURCES = previousResources
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, root, dsh, home, stateOf, stop }
}

test('first launch with a seed file creates the factory team', async (t) => {
  const env = await start({
    state: { ...userTeam(), mainBotIds: [], bots: {} },
    seed: seedFile('3', [chief('factory-chief'), helper('factory-helper')]),
  })
  t.after(env.stop)
  await env.rt.bootstrap()
  const state = env.stateOf()
  const seeded = Object.values(state.bots).filter(bot => bot.factoryId)
  assert.equal(seeded.length, 2)
  assert.deepEqual(seeded.map(bot => bot.factoryId).sort(), ['factory-chief', 'factory-helper'])
  assert.equal(state.factorySeedVersion, '3')
  // the seed's main Bot is the team's Main Bot
  const chiefId = seeded.find(bot => bot.factoryId === 'factory-chief').id
  assert.deepEqual(state.mainBotIds, [chiefId])
  assert.equal(seeded.find(bot => bot.factoryId === 'factory-chief').name, 'Navigator')
})

test('no seed file leaves startup untouched — a default Chief is still made', async (t) => {
  const env = await start({ state: { ...userTeam(), mainBotIds: [], bots: {} }, seed: null })
  t.after(env.stop)
  await env.rt.bootstrap()
  const state = env.stateOf()
  assert.equal(Object.values(state.bots).every(bot => bot.factoryId === undefined), true)
  assert.equal(state.mainBotIds.length, 1)
  assert.equal(state.factorySeedVersion, undefined)
})

test('an upgrade refreshes seed Bots to factory values and bumps the version', async (t) => {
  // a team seeded at version 2, whose factory Bot the user renamed away from factory
  const env = await start({
    state: {
      ...userTeam(),
      factorySeedVersion: '2',
      mainBotIds: [],
      bots: {
        old: { id: 'old', name: 'Renamed By User', role: 'Old', instructions: 'stale', sessionId: 'old', createdAt: 1, factoryId: 'factory-chief', capabilities: [] },
      },
    },
    seed: seedFile('5', [chief('factory-chief')]),
  })
  t.after(env.stop)
  await env.rt.bootstrap()
  const bot = env.stateOf().bots.old
  assert.equal(bot.name, 'Navigator')
  assert.equal(bot.role, 'Chief')
  assert.equal(bot.instructions, 'You run the team.')
  assert.equal(env.stateOf().factorySeedVersion, '5')
})

test('a user Bot without a factoryId is never touched by a seed upgrade', async (t) => {
  const env = await start({
    state: {
      ...userTeam(),
      factorySeedVersion: '2',
      bots: {
        chief: { ...userTeam().bots.chief, factoryId: 'factory-chief', name: 'Renamed', capabilities: [] },
        mine: { id: 'mine', name: 'My Bot', role: 'Mine', instructions: 'keep me', sessionId: 'mine', createdAt: 5 },
      },
    },
    seed: seedFile('9', [chief('factory-chief')]),
  })
  t.after(env.stop)
  await env.rt.bootstrap()
  const state = env.stateOf()
  assert.equal(state.bots.mine.name, 'My Bot')
  assert.equal(state.bots.mine.instructions, 'keep me')
  assert.equal(state.bots.mine.factoryId, undefined)
  assert.equal(state.bots.chief.name, 'Navigator')
})

test('the same version on a non-empty team is a no-op', async (t) => {
  const env = await start({
    state: {
      ...userTeam(), factorySeedVersion: '5', mainBotIds: [],
      bots: { old: { id: 'old', name: 'Navigator', role: 'Chief', instructions: 'You run the team.', sessionId: 'old', createdAt: 1, factoryId: 'factory-chief', capabilities: [] } },
    },
    seed: seedFile('5', [chief('factory-chief')]),
  })
  t.after(env.stop)
  await env.rt.bootstrap()
  const state = env.stateOf()
  // nothing added, version kept
  assert.equal(Object.values(state.bots).filter(bot => bot.factoryId === 'factory-chief').length, 1)
  assert.equal(state.factorySeedVersion, '5')
})

test('a seed capability item gets its relative locator resolved under the data home', async (t) => {
  const env = await start({
    state: { ...userTeam(), mainBotIds: [], bots: {} },
    seed: seedFile('1', [chief('factory-chief')], {
      items: { 'review-skill': { kind: 'skill', description: 'Code review', locator: 'skills-repo/review-skill' } },
    }),
  })
  t.after(env.stop)
  await env.rt.bootstrap()
  const item = env.stateOf().capabilities.items['review-skill']
  assert.equal(item.kind, 'skill')
  assert.equal(item.locator, join(env.dsh, 'skills-repo', 'review-skill'))
})

test('a first start whose seed copy has not landed reads the packaged resources instead', async (t) => {
  // The app copies the seed off its ready path, so a first boot can beat that copy. The
  // packaged resources directory then supplies the team.
  const env = await start({
    state: { ...userTeam(), mainBotIds: [], bots: {} },
    seed: null,
    bundledSeed: seedFile('7', [chief('factory-chief')]),
  })
  t.after(env.stop)
  await env.rt.bootstrap()
  const state = env.stateOf()
  const seeded = Object.values(state.bots).filter(bot => bot.factoryId === 'factory-chief')
  assert.equal(seeded.length, 1)
  assert.equal(seeded[0].name, 'Navigator')
  assert.equal(state.factorySeedVersion, '7')
})

test('a Bot created from the seed starts with the skills the seed gives it', async (t) => {
  // A refresh path already set capabilities; a Bot created on a first start did not, so a fresh
  // install opened with the library in place but nobody holding a skill.
  const env = await start({
    state: { ...userTeam(), mainBotIds: [], bots: {} },
    seed: seedFile('1', [
      chief('factory-chief'),
      { ...helper('factory-helper'), capabilities: ['review-skill', 'grilling'] },
    ], { items: { 'review-skill': { kind: 'skill', description: 'Code review', content: '# review\n' }, grilling: { kind: 'skill', description: 'Grill the request', content: '# grilling\n' } } }),
  })
  t.after(env.stop)
  await env.rt.bootstrap()
  const state = env.stateOf()
  const created = Object.values(state.bots).filter(bot => bot.factoryId !== undefined)
  assert.equal(created.length, 2)
  const navigator = created.find(bot => bot.factoryId === 'factory-chief')
  const support = created.find(bot => bot.factoryId === 'factory-helper')
  assert.deepEqual(navigator.capabilities, ['review-skill'], 'the chief holds what the seed gives it')
  assert.deepEqual(support.capabilities, ['review-skill', 'grilling'], 'the helper holds both skills it was given')
  // Both skills are in the library too, so the names resolve.
  for (const name of ['review-skill', 'grilling']) assert.ok(state.capabilities.items[name] !== undefined, `${name} is in the library`)
})

test('a seed Bot with no skills is created with no skills, not an empty override', async (t) => {
  const env = await start({
    state: { ...userTeam(), mainBotIds: [], bots: {} },
    seed: seedFile('1', [{ ...helper('factory-helper'), name: 'Plain' }]),
  })
  t.after(env.stop)
  await env.rt.bootstrap()
  const seeded = Object.values(env.stateOf().bots).filter(bot => bot.factoryId === 'factory-helper')
  assert.equal(seeded.length, 1)
  assert.deepEqual(seeded[0].capabilities, [], 'a Bot the seed gives no skills starts with none')
})
