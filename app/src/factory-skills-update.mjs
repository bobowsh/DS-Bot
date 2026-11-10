// The factory skills update themselves from the intranet SkillHub at runtime: the catalog the
// factory publishes (the skills-repo posted there by the import script) moves ahead of what an
// installed machine carries, and this module brings the newer copies over.
//
// The skills live in the data location's skills-repo (a git repository the app pulls at start).
// The sync writes into it only what changed: a slug whose SkillHub version differs from the one
// recorded at the last sync is downloaded and unpacked over the local folder. A slug the repo
// does not have is never pulled — the factory distributes a fixed list, and everything else on
// SkillHub belongs to someone else. The first sync records versions without writing, because a
// machine that just shipped its skills to SkillHub is already current.
//
// The download is a zip, read with the zlib that Node carries; no dependency is added for it.
// The state of the last sync lives in <dataDir>/skills-sync.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { join } from 'node:path'
import { SKILLHUB_REGISTRY } from './profile.mjs'

/** The namespace the factory skills are published under. */
export const SKILLHUB_NAMESPACE = 'global'
/** Where the sync's state is kept. */
const stateFile = dataDir => join(dataDir, 'skills-sync.json')
/** The api base without a trailing slash, so the endpoint paths below never double it. */
const apiBase = registry => String(registry ?? SKILLHUB_REGISTRY).replace(/\/+$/u, '')
/** The download endpoint of one skill. */
const downloadUrl = (registry, namespace, slug) => `${apiBase(registry)}/api/v1/skills/${namespace}/${slug}/download`

/**
 * The skills the intranet SkillHub publishes: slug and the version of its latest release.
 * @param {string} registry - the SkillHub api base
 * @param {typeof fetch} [fetchImpl] - the fetch to use
 * @returns {Promise<Record<string, string>>} slug → version
 */
export async function publishedSkills(registry = SKILLHUB_REGISTRY, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${apiBase(registry)}/api/v1/skills`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const body = await response.json()
  const items = body?.data?.items ?? body?.data ?? body?.items
  if (!Array.isArray(items)) throw new Error('the skill list is not an array')
  const versions = {}
  for (const item of items) {
    if (typeof item?.slug === 'string' && typeof item?.latestVersion?.version === 'string') {
      versions[item.slug] = item.latestVersion.version
    }
  }
  return versions
}

/**
 * The skills the repo carries: the folders under it that hold a SKILL.md.
 * @param {string} repoDir - the skills-repo directory
 * @returns {string[]}
 */
export function installedSkills(repoDir) {
  if (!existsSync(repoDir)) return []
  const names = []
  for (const entry of readDirSyncSafe(repoDir)) {
    if (entry === '.git' || !existsSync(join(repoDir, entry, 'SKILL.md'))) continue
    names.push(entry)
  }
  return names.sort((a, b) => a.localeCompare(b, 'en'))
}

function readDirSyncSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/**
 * The state of the last sync: the version each skill carried when it was written.
 * @param {string} dataDir - the data location
 * @returns {Promise<{ versions: Record<string, string> }>}
 */
export async function readSyncState(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(stateFile(dataDir), 'utf8'))
    return { versions: raw?.versions && typeof raw.versions === 'object' ? raw.versions : {} }
  } catch {
    return { versions: {} }
  }
}

/**
 * Write the sync state.
 * @param {string} dataDir - the data location
 * @param {{ versions?: Record<string, string> }} state
 * @returns {Promise<void>}
 */
export async function writeSyncState(dataDir, state) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(stateFile(dataDir), `${JSON.stringify({ versions: state.versions ?? {} }, undefined, 2)}\n`, 'utf8')
}

/**
 * Read one zip archive: stored and deflate members only, which is what the SkillHub download
 * produces. The reader walks the central directory and follows each member to its local header.
 * @param {Buffer} buffer - the zip
 * @returns {{ path: string, body: Buffer }[]}
 */
export function readZip(buffer) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  let eocd = -1
  for (let at = buffer.length - 22; at >= 0; at -= 1) {
    if (buffer.compare(signature, 0, 4, at, at + 4) === 0) { eocd = at; break }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = buffer.readUInt16LE(eocd + 10)
  let at = buffer.readUInt32LE(eocd + 16)
  const files = []
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory')
    const method = buffer.readUInt16LE(at + 10)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localOffset = buffer.readUInt32LE(at + 42)
    const path = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    if (path !== '' && !path.endsWith('/')) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataAt = localOffset + 30 + localNameLength + localExtraLength
      const compressed = buffer.subarray(dataAt, dataAt + compressedSize)
      const body = method === 0 ? Buffer.from(compressed)
        : method === 8 ? inflateRawSync(compressed)
          : (() => { throw new Error(`unsupported zip method ${String(method)} for ${path}`) })()
      files.push({ path, body })
    }
    at += 46 + nameLength + extraLength + commentLength
  }
  return files
}

/**
 * Unpack a skill zip into a folder. The archive holds the skill's files at its root (SKILL.md
 * and whatever the skill carries); a wrapping folder, when present, is stripped.
 * @param {Buffer} buffer - the zip
 * @param {string} into - the skill's directory in the repo
 * @returns {Promise<void>}
 */
export async function unpackSkillZip(buffer, into) {
  for (const file of readZip(buffer)) {
    const relative = file.path.replace(/^[^/]+\//u, '').replace(/\/+$/u, '')
    if (relative === '') continue
    const target = join(into, ...relative.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, file.body)
  }
}

/**
 * Bring the repo's skills up to the versions SkillHub publishes.
 *
 * @param {object} options
 * @param {string} options.dataDir - the data location
 * @param {string} options.repoDir - the skills-repo directory
 * @param {string} [options.registry] - the SkillHub api base
 * @param {typeof fetch} [options.fetch] - the fetch to use
 * @param {Console} [options.log] - where the outcome is written
 * @returns {Promise<{ checked: boolean, updated: string[], failed: string[], recorded: string[], reason?: string }>}
 */
export async function syncFactorySkills({ dataDir, repoDir, registry = SKILLHUB_REGISTRY, fetch: fetchImpl = globalThis.fetch, log = console }) {
  const result = { checked: false, updated: [], failed: [], recorded: [] }
  let published
  try {
    published = await publishedSkills(registry, fetchImpl)
  } catch (error) {
    result.reason = `the SkillHub skill list could not be read: ${error instanceof Error ? error.message : String(error)}`
    log.error(`LinkHarness: ${result.reason}`)
    return result
  }
  result.checked = true
  const repo = installedSkills(repoDir)
  const state = await readSyncState(dataDir)
  const versions = { ...state.versions }
  for (const slug of repo) {
    const remote = published[slug]
    // The factory distributes a fixed list; a slug SkillHub does not know stays as it is.
    if (remote === undefined) continue
    const known = state.versions[slug]
    if (known === remote) continue
    if (known === undefined) {
      // A machine that just shipped its skills to SkillHub is already current: record, don't
      // overwrite, so the sync never fights the import for the first round.
      versions[slug] = remote
      result.recorded.push(slug)
      continue
    }
    try {
      const response = await fetchImpl(downloadUrl(registry, SKILLHUB_NAMESPACE, slug))
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const archive = Buffer.from(await response.arrayBuffer())
      const outcome = await installSkillUpdate({ dataDir, repoDir, slug, remote, archive })
      if (outcome.updated) {
        versions[slug] = remote
        result.updated.push(slug)
        log.info(`LinkHarness: skill ${slug} updated to ${remote}`)
      } else {
        result.failed.push(slug)
        log.error(`LinkHarness: skill ${slug} was not updated: ${outcome.reason ?? 'unknown reason'}`)
      }
    } catch (error) {
      result.failed.push(slug)
      log.error(`LinkHarness: skill ${slug} was not updated: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await writeSyncState(dataDir, { versions })
  return result
}

/**
 * Put a newer copy of one skill in place.
 *
 * The zip is unpacked into a staging folder and only then swapped in: the local folder is
 * renamed to a backup, the staged one takes its place, and any failure moves the backup back —
 * the same shape the plugin channel uses (factory-update.mjs), so a half-written skill never
 * replaces the one the reader has.
 * @param {object} options
 * @param {string} options.dataDir - the data location
 * @param {string} options.repoDir - the skills-repo directory
 * @param {string} options.slug - the skill's slug
 * @param {string} options.remote - the version SkillHub publishes
 * @param {Buffer} options.archive - the skill zip
 * @returns {Promise<{ updated: boolean, reason?: string }>}
 */
async function installSkillUpdate({ dataDir, repoDir, slug, remote, archive }) {
  const staging = join(stagingDir(dataDir), slug.replace(/[\\/]/gu, '__'))
  const backup = join(backupDir(dataDir), slug.replace(/[\\/]/gu, '__'))
  const target = join(repoDir, slug)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await unpackSkillZip(archive, staging)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    return { updated: false, reason: `unpack failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  // The unpacked skill has to carry its SKILL.md: an archive without one would leave the
  // reader with a folder DSH does not treat as a skill.
  if (!existsSync(join(staging, 'SKILL.md'))) {
    await rm(staging, { recursive: true, force: true })
    return { updated: false, reason: 'the archive does not carry a SKILL.md' }
  }
  await rm(backup, { recursive: true, force: true })
  await mkdir(backupDir(dataDir), { recursive: true })
  const had = existsSync(target)
  if (had) await rename(target, backup)
  try {
    await rename(staging, target)
  } catch (error) {
    // The swap failed: the old copy goes back, so the repo keeps what it had.
    if (had) await rename(backup, target).catch(() => {})
    await rm(staging, { recursive: true, force: true })
    return { updated: false, reason: `the swap failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  await rm(backup, { recursive: true, force: true })
  return { updated: true }
}

/** Where the new skill copies are unpacked before they are swapped in. */
const stagingDir = dataDir => join(dataDir, 'skills-update-staging')
/** Where the replaced skill folders are kept until the swap is known to have worked. */
const backupDir = dataDir => join(dataDir, 'skills-update-backup')

/**
 * Run the skills sync on the same hourly rhythm as the plugin check; the state file keeps a
 * version change from downloading twice.
 *
 * @param {object} options
 * @param {string} options.dataDir - the data location
 * @param {() => string} options.repoDirOf - where the skills-repo lives, read when the sync runs
 * @param {string} [options.registry] - the SkillHub api base
 * @param {typeof fetch} [options.fetch] - the fetch to use
 * @param {Console} [options.log] - where the outcome is written
 * @returns {{ stop: () => void, check: () => Promise<void> }}
 */
export function watchFactorySkills({ dataDir, repoDirOf, registry, fetch: fetchImpl, log = console }) {
  const HOUR_MS = 60 * 60_000
  let busy = false
  const check = async () => {
    if (busy) return
    busy = true
    try {
      await syncFactorySkills({ dataDir, repoDir: repoDirOf(), registry, fetch: fetchImpl, log })
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => { void check() }, HOUR_MS)
  timer.unref?.()
  void check()
  return { stop: () => { clearInterval(timer) }, check }
}
