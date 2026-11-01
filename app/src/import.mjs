// Reading a DSH home: the Bot team there, its Session folders, and whether a running DSH holds it.
// The team-copy that used to live here is gone — a fresh install is seeded by the factory
// (src/factory.mjs + ds-bot's factory-seed) — but the Session-level pieces stay: the auto-import
// of the user's historical Sessions (the plan after the factory team) builds on them.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { parse } from 'yaml'
import { within } from './copy-tree.mjs'

export { within }

// The rows of a profile patch that hold model settings: DeepSeek's API and account, other
// providers, the default model and the agent presets. Rows of other plugins may name plugins
// that the app does not have.
export const MODEL_ROWS = ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'agent-default-model', 'agent-preset-registry']
const LOCK_STALE_MS = 60_000

/** The DSH home of the user's own DSH, read as DSH reads DSH_HOME. */
export function userDshHome(env = process.env) {
  const value = env.DSH_HOME?.trim()
  if (!value) return join(homedir(), '.dsh')
  return resolve(value === '~' ? homedir() : /^~[\\/]/u.test(value) ? join(homedir(), value.slice(2)) : value)
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** Every Session the team names: each Bot's and group's parts, the group conversations and each group's own Session. */
export function sessionIdsOf(team) {
  const ids = segments => segments.map(part => part?.sessionId)
  return [...new Set([
    ...Object.values(team.bots ?? {}).flatMap(bot => [bot.id, bot.sessionId, ...ids(bot.segments ?? [])]),
    // A group keeps the earlier parts per member: { [botId]: segments }. The group's own
    // Session, the one it relays in, has the group's id.
    ...Object.values(team.rooms ?? {}).flatMap(room => [room.id, ...Object.values(room.sessions ?? {}), ...ids(Object.values(room.segments ?? {}).flat())]),
  ].filter(id => typeof id === 'string' && id !== ''))]
}

/**
 * The team in a DSH home, with the profiles that hold model settings.
 * @returns {{ from: string, team: any, bots: number, rooms: number, profiles: { name: string, rows: any[] }[] } | undefined}
 */
export function findTeam(from) {
  const statePath = join(from, 'bot', 'state.json')
  if (!existsSync(statePath)) return undefined
  const team = readJson(statePath)
  const bots = Object.keys(team.bots ?? {}).length
  if (bots === 0) return undefined
  return { from, team, bots, rooms: Object.keys(team.rooms ?? {}).length, profiles: modelProfiles(from) }
}

function modelProfiles(from) {
  const dir = join(from, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap((entry) => {
    const file = join(dir, entry.name, 'cordis.patch.yml')
    if (!existsSync(file)) return []
    let patch
    try {
      patch = parse(readFileSync(file, 'utf8'))
    } catch (error) {
      // An unreadable profile has no model settings to copy; the team is still there.
      console.warn(`LinkBot: skipped the model settings in ${file}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    const rows = Array.isArray(patch) ? patch.filter(row => MODEL_ROWS.includes(row?.id)) : []
    return rows.length > 0 ? [{ name: entry.name, rows }] : []
  })
}

/** Whether a running DSH holds the team, as ds-bot's own lock tells (src/host/home-lock.js). */
export function teamInUse(from, { host = hostname(), now = Date.now() } = {}) {
  const path = join(from, 'bot', 'state.lock')
  if (!existsSync(path)) return false
  const fresh = now - statSync(path).mtimeMs < LOCK_STALE_MS
  let holder
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fresh
  }
  if (holder?.host !== host) return fresh
  try {
    process.kill(holder.pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// sessions/<group>/<id>/: the group is the folder the Session works in.
function sessionDirs(from, ids) {
  const root = join(from, 'sessions')
  const groups = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : []
  const found = []
  const missing = []
  for (const id of ids) {
    const group = groups.find(name => existsSync(join(root, name, id)))
    if (group === undefined) missing.push(id)
    else found.push({ id, group })
  }
  return { found, missing }
}

async function copySessionDirs(from, to, sessions, signal) {
  for (const { id, group } of sessions) {
    signal?.throwIfAborted()
    await cp(join(from, 'sessions', group, id), join(to, 'sessions', group, id), { recursive: true })
  }
}

/**
 * Copy the team's Sessions into the DSH home `to`, as they lie in `from`; an abort stops it between Sessions.
 * @param {string} from @param {any} team @param {string} to @param {AbortSignal} [signal]
 * @returns {Promise<string[]>} their ids
 */
export async function copySessions(from, team, to, signal) {
  const { found } = sessionDirs(from, sessionIdsOf(team))
  await copySessionDirs(from, to, found, signal)
  return found.map(({ id }) => id)
}

const logVersion = name => parseSessionFormatLogFilename(name.replace(/\.(zstd|zst|gz|br)$/u, ''))

/** The Sessions whose log is in a newer format than the pinned DSH reads. */
export function newerSessions(from, team) {
  const { found } = sessionDirs(from, sessionIdsOf(team))
  return found.filter(({ id, group }) => readdirSync(join(from, 'sessions', group, id))
    .some(name => (logVersion(name) ?? 0) > sessionFormatCatalog.currentVersion)).map(({ id }) => id)
}
