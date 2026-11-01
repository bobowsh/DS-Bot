// The factory seed: the resources the installer ships with are put under the data location
// on first launch, so a fresh install opens on a ready-made Bot team. ds-bot reads the team
// from <dataDir>/factory/factory-team.json (src/host/factory-seed.js); the skills live in a
// git-managed repo at <dataDir>/skills-repo/ that is cloned when online and falls back to the
// bundled copy offline. isomorphic-git is loaded lazily: an offline machine or a build without
// the package must still work with the bundled copy, never fail the start.
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const seedFile = dataDir => join(dataDir, 'factory', 'factory-team.json')
const repoDir = dataDir => join(dataDir, 'skills-repo')

const skillsRepoUrlOf = (seed, env = process.env) => env.DS_BOT_SKILLS_REPO?.trim() || (typeof seed?.skillsRepoUrl === 'string' ? seed.skillsRepoUrl.trim() : '')

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
    console.warn(`DeepSeek Bot: skills updates are unavailable without the isomorphic-git package (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}

async function readSeed(dataDir) {
  try {
    return JSON.parse(await readFile(seedFile(dataDir), 'utf8'))
  } catch {
    return undefined
  }
}

export async function installFactoryResources({ dataDir, resourcesDir, signal, env = process.env }) {
  const result = { seedCopied: false, repo: 'kept' }
  const bundledSeed = join(resourcesDir, 'factory', 'factory-team.json')
  if (existsSync(bundledSeed) && !existsSync(seedFile(dataDir))) {
    await mkdir(join(dataDir, 'factory'), { recursive: true, signal })
    await cp(bundledSeed, seedFile(dataDir), signal)
    result.seedCopied = true
  }
  const target = repoDir(dataDir)
  if (existsSync(join(target, '.git'))) return result
  const seed = await readSeed(dataDir)
  const url = skillsRepoUrlOf(seed, env)
  if (url !== '' && !signal?.aborted) {
    const git = await loadGit()
    if (git !== undefined) {
      try {
        signal?.throwIfAborted()
        await rm(target, { recursive: true, force: true, maxRetries: 5 })
        await git.clone({ fs: nodeFs, http: git.http, dir: target, url, singleBranch: true, depth: 1 })
        result.repo = 'cloned'
        return result
      } catch (error) {
        console.warn(`DeepSeek Bot: the skills repo was not cloned from ${url}: ${error instanceof Error ? error.message : String(error)}`)
        await rm(target, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
      }
    } else result.reason = 'no isomorphic-git'
  } else if (url === '') result.reason = 'no skills repo URL'
  const bundledRepo = join(resourcesDir, 'skills-repo')
  if (existsSync(bundledRepo) && !existsSync(target)) {
    await copyTree(bundledRepo, target, signal)
    result.repo = 'copied'
  }
  return result
}

export async function pullSkillsRepo({ dataDir, resourcesDir, env = process.env }) {
  const target = repoDir(dataDir)
  try {
    if (!existsSync(join(target, '.git'))) return
    const seed = await readSeed(dataDir)
    let url = skillsRepoUrlOf(seed, env)
    if (url === '' && !seed) {
      try {
        url = skillsRepoUrlOf(JSON.parse(await readFile(join(resourcesDir, 'factory', 'factory-team.json'), 'utf8')), env)
      } catch {}
    }
    if (url === '') return
    const git = await loadGit()
    if (git === undefined) return
    await git.fetch({ fs: nodeFs, http: git.http, dir: target, url, singleBranch: true, depth: 1 })
    await git.pull({ fs: nodeFs, http: git.http, dir: target, url, singleBranch: true, fastForwardOnly: true })
  } catch (error) {
    console.warn(`DeepSeek Bot: the skills repo was not updated: ${error instanceof Error ? error.message : String(error)}`)
  }
}
