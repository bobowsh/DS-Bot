// The factory seed: the resources the installer ships with are put under the data location
// on first launch, so a fresh install opens on a ready-made Bot team. ds-bot reads the team
// from <dataDir>/factory/factory-team.json (src/host/factory-seed.js); the skills live in the
// git repository at <dataDir>/skills-repo/, which travels with the installer as a repository
// of its own and is only copied here — the first run never reaches the network. Later starts
// update it with `git pull` against the remote the repository carries (or DS_BOT_SKILLS_REPO).
// isomorphic-git is loaded lazily: an offline machine or a build without the package still
// works with the copy, and never fails the start.
import { cp, mkdir } from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const seedFile = dataDir => join(dataDir, 'factory', 'factory-team.json')
const repoDir = dataDir => join(dataDir, 'skills-repo')
// The identity a pull authors with when it cannot fast-forward; the shipped repo has none.
const GIT_IDENTITY = { name: 'LinkBot', email: 'ds-bot@localhost' }

async function copyTree(from, to, signal) {
  await mkdir(to, { recursive: true })
  await cp(from, to, { recursive: true, signal })
}

async function loadGit() {
  try {
    // The network layer exports its http client as default: clone/fetch/pull take it as `http`.
    const [git, httpModule] = await Promise.all([import('isomorphic-git'), import('isomorphic-git/http/node')])
    return { ...git, http: httpModule.default ?? httpModule }
  } catch (error) {
    console.warn(`LinkBot: skills updates are unavailable without the isomorphic-git package (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}

export async function installFactoryResources({ dataDir, resourcesDir, signal }) {
  const result = { seedCopied: false, repo: 'kept' }
  const bundledSeed = join(resourcesDir, 'factory', 'factory-team.json')
  if (existsSync(bundledSeed) && !existsSync(seedFile(dataDir))) {
    await mkdir(join(dataDir, 'factory'), { recursive: true, signal })
    await cp(bundledSeed, seedFile(dataDir), signal)
    result.seedCopied = true
  }
  const bundledRepo = join(resourcesDir, 'skills-repo')
  if (!existsSync(bundledRepo)) {
    result.reason = 'no bundled skills repo'
    return result
  }
  const target = repoDir(dataDir)
  // A repository is already in place: it is the user's, and the pull keeps it current.
  if (existsSync(join(target, '.git'))) return result
  if (!existsSync(target)) {
    // The bundled repository ships whole, its .git included, so the installed copy can pull.
    await copyTree(bundledRepo, target, signal)
    result.repo = 'copied'
    return result
  }
  // An install from a build whose bundle was no repository: hand it the shipped .git so the
  // pull works from here on. The working tree the user has stays as it is.
  if (existsSync(join(bundledRepo, '.git'))) {
    await cp(join(bundledRepo, '.git'), join(target, '.git'), { recursive: true, signal })
    result.repo = 'git-added'
  }
  return result
}

/** The remote the pull uses: the environment, then the repository's own configuration, else none. */
export async function skillsRepoRemote(dir, git, env = process.env) {
  const fromEnv = env.DS_BOT_SKILLS_REPO?.trim()
  if (fromEnv) return fromEnv
  try {
    const url = await git.getConfig({ fs: nodeFs, dir, path: 'remote.origin.url' })
    return typeof url === 'string' ? url.trim() : ''
  } catch {
    return ''
  }
}

export async function pullSkillsRepo({ dataDir, env = process.env }) {
  const target = repoDir(dataDir)
  try {
    if (!existsSync(join(target, '.git'))) return
    const git = await loadGit()
    if (git === undefined) return
    const url = await skillsRepoRemote(target, git, env)
    // No remote: nothing to update, and nothing to warn about.
    if (url === '') return
    await git.fetch({ fs: nodeFs, http: git.http, dir: target, url, singleBranch: true, depth: 1 })
    // pull wants an identity even when it only fast-forwards, and the installed repository
    // carries none; the merge itself never authors anything under fastForwardOnly.
    await git.pull({ fs: nodeFs, http: git.http, dir: target, url, singleBranch: true, fastForwardOnly: true, author: GIT_IDENTITY })
  } catch (error) {
    console.warn(`LinkBot: the skills repo was not updated: ${error instanceof Error ? error.message : String(error)}`)
  }
}