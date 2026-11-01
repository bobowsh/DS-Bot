import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { copySessions, findTeam, newerSessions, sessionIdsOf, teamInUse, userDshHome } from '../src/import.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function treeHash(dir) {
  const hash = createHash('sha256')
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else hash.update(relative(dir, path)).update(readFileSync(path))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

// A user's DSH home: Chief in two parts, Writer, a group where Chief is in two parts and
// which has its own Session, the team's own files, two profiles and one that DSH cannot read.
const TEAM = {
  version: 1,
  workspaceId: 'w-old',
  mainBotIds: ['session-a'],
  bots: {
    'session-a': { id: 'session-a', name: 'Chief', sessionId: 'session-a2', segments: [{ sessionId: 'session-a' }] },
    'session-b': { id: 'session-b', name: 'Writer', workDir: '/projects/site' },
  },
  rooms: {
    'session-r1': {
      id: 'session-r1', name: 'Ops', members: ['session-a', 'session-b'],
      sessions: { 'session-a': 'session-g', 'session-b': 'session-gone' },
      segments: { 'session-a': [{ sessionId: 'session-g0', endedAt: 1 }] },
    },
  },
  agents: { x: { id: 'x' } },
}
const TEAM_SESSIONS = [['--team--', 'session-a'], ['--team--', 'session-a2'], ['--team--', 'session-g'], ['--team--', 'session-g0'], ['--team--', 'session-r1'], ['--site--', 'session-b']]

function oldHome(root) {
  const from = join(root, 'dsh')
  write(join(from, 'bot', 'state.json'), JSON.stringify(TEAM))
  write(join(from, 'bot', 'state.lock'), '{}')
  write(join(from, 'bot', 'inflight.json'), '{}')
  write(join(from, 'bot', 'memory', 'session-a.md'), 'remember')
  write(join(from, 'bot', 'workspace', 'notes.txt'), 'old notes')
  write(join(from, 'bot', 'workspace', 'kept.txt'), 'old kept')
  for (const [group, id] of TEAM_SESSIONS) write(join(from, 'sessions', group, id, 'session.v4.jsonl.zstd'), id)
  write(join(from, 'sessions', '--team--', 'session-other', 'session.v4.jsonl.zstd'), 'not the team')
  write(join(from, 'attachments', 'ab', 'cdef'), 'file')
  write(join(from, '.credentials.yaml'), 'DEEPSEEK_API_KEY: fake\n')
  write(join(from, '.env'), 'X=1\n')
  write(join(from, 'profiles', 'desktop', 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      moonshotai:', '        apiKeyEnv: MOONSHOTAI_API_KEY',
    '- id: agent-default-model', '  config:', '    model: deepseek-official/deepseek-flash',
    '- id: some-plugin', '  name: some-plugin', '',
  ].join('\n'))
  write(join(from, 'profiles', 'web', 'cordis.patch.yml'), '- id: some-plugin\n  name: some-plugin\n')
  write(join(from, 'profiles', 'broken', 'cordis.patch.yml'), '- id: llm-deepseek\n  config: [unclosed\n')
  return from
}

describe('finding the team', () => {
  let root, from
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-app-find-'))
    from = oldHome(root)
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('counts the Bots and groups and lists only the readable profiles with model settings', () => {
    const found = findTeam(from)
    assert.equal(found.bots, 2)
    assert.equal(found.rooms, 1)
    assert.deepEqual(found.profiles.map(entry => [entry.name, entry.rows.map(row => row.id)]), [['desktop', ['llm-pi-ai', 'agent-default-model']]])
    assert.equal(findTeam(join(root, 'none')), undefined)
  })

  test('names each Session of the team once', () => {
    assert.deepEqual(sessionIdsOf(TEAM), ['session-a', 'session-a2', 'session-b', 'session-r1', 'session-g', 'session-gone', 'session-g0'])
  })

  test('names the own Session of every group, so an imported group can be opened', () => {
    assert.ok(sessionIdsOf(TEAM).includes('session-r1'))
    assert.deepEqual(sessionIdsOf({ bots: {}, rooms: { 'session-r2': { id: 'session-r2' } } }), ['session-r2'])
  })

  test('copies only the Sessions of the team, and changes nothing in the old home', async () => {
    const oldTree = treeHash(from)
    const home = join(root, 'check')
    const ids = await copySessions(from, TEAM, home)
    assert.deepEqual(ids.toSorted(), TEAM_SESSIONS.map(([, id]) => id).toSorted())
    for (const [group, id] of TEAM_SESSIONS) assert.equal(readFileSync(join(home, 'sessions', group, id, 'session.v4.jsonl.zstd'), 'utf8'), id)
    assert.equal(existsSync(join(home, 'sessions', '--team--', 'session-other')), false)
    assert.equal(treeHash(from), oldTree)
  })

  test('stops copying once the app quits', async () => {
    const home = join(root, 'check-stopped')
    await assert.rejects(copySessions(from, TEAM, home, AbortSignal.abort()), { name: 'AbortError' })
    assert.equal(existsSync(join(home, 'sessions')), false)
  })

  test('finds Sessions written in a newer format than the pinned DSH reads', () => {
    assert.deepEqual(newerSessions(from, TEAM), [])
    write(join(from, 'sessions', '--site--', 'session-b', 'session.v99.jsonl.zstd'), 'newer')
    write(join(from, 'sessions', '--team--', 'session-g0', 'session.v99.jsonl.zstd'), 'newer')
    assert.deepEqual(newerSessions(from, TEAM), ['session-b', 'session-g0'])
  })

  test('takes the team for in use while a live process on this machine or a fresh lock elsewhere holds it', () => {
    const lock = join(from, 'bot', 'state.lock')
    write(lock, JSON.stringify({ pid: process.pid, host: 'here' }))
    assert.equal(teamInUse(from, { host: 'here' }), true)
    const ended = spawnSync(process.execPath, ['-e', '']).pid
    write(lock, JSON.stringify({ pid: ended, host: 'here' }))
    assert.equal(teamInUse(from, { host: 'here' }), false)
    write(lock, JSON.stringify({ pid: 1, host: 'elsewhere' }))
    assert.equal(teamInUse(from, { host: 'here' }), true)
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock, old, old)
    assert.equal(teamInUse(from, { host: 'here' }), false)
  })

  test('reads DSH_HOME as DSH does', () => {
    assert.equal(userDshHome({}), join(homedir(), '.dsh'))
    assert.equal(userDshHome({ DSH_HOME: ' ' }), join(homedir(), '.dsh'))
    assert.equal(userDshHome({ DSH_HOME: '~/dsh-x' }), join(homedir(), 'dsh-x'))
  })
})
