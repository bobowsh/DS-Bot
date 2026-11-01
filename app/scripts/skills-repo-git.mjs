// The bundled skills repo ships as a repository, but .git can never be committed (git does not
// track a git dir), so this script makes one inside resources/skills-repo before the pack: the
// installed app copies that repository to <dataDir>/skills-repo and updates it with `git pull`.
// scripts/before-pack.mjs runs it for every build; run it by hand after the skills change.
//
// The shipped repository is a mirror of the skills repo it pulls from, so the pull can
// fast-forward: DS_BOT_SKILLS_REPO names that repo (a build with network clones it; a machine
// without one ships a repository of its own, which the pull then cannot fast-forward).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILLS_REPO = fileURLToPath(new URL('../resources/skills-repo', import.meta.url))

function git(args, cwd) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' })
  // A machine without git ships the plain directory: the copy still works, updates stay off.
  if (run.error?.code === 'ENOENT') return undefined
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(run.stderr || run.stdout || '').trim()}`)
  return run.stdout ?? ''
}

function commitAll(dir) {
  git(['add', '-A'], dir)
  if ((git(['status', '--porcelain'], dir) ?? '').trim() === '') return
  git(['-c', 'user.name=DS Bot', '-c', 'user.email=ds-bot@localhost', 'commit', '-q', '-m', 'Ship the factory skills'], dir)
}

function setRemote(dir, url) {
  const remotes = git(['remote'], dir) ?? ''
  git(remotes.includes('origin') ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url], dir)
}

/** Replace the directory with a clone of `url`: the shipped repo is a mirror of that repo. */
function cloneMirror(dir, url, warn) {
  const staging = mkdtempSync(join(tmpdir(), 'ds-bot-skills-'))
  try {
    git(['clone', '--quiet', url, staging], dir)
    rmSync(dir, { recursive: true, force: true })
    cpSync(staging, dir, { recursive: true })
    return true
  } catch (error) {
    warn(`DeepSeek Bot: the skills repo was not cloned from ${url}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Make resources/skills-repo a repository holding its current contents, pulling from `url`.
 * A repository that is already there keeps its history and only records the remote.
 * @returns whether the directory carries git information afterwards.
 */
export function ensureSkillsRepoGit({ dir = SKILLS_REPO, env = process.env, warn = console.warn } = {}) {
  if (!existsSync(dir)) {
    warn('DeepSeek Bot: no bundled skills repo to prepare')
    return false
  }
  if (git(['--version'], dir) === undefined) {
    warn('DeepSeek Bot: git is not installed, so the shipped skills repo has no git information')
    return false
  }
  const url = env.DS_BOT_SKILLS_REPO?.trim() ?? ''
  if (existsSync(join(dir, '.git'))) {
    commitAll(dir)
    if (url !== '') setRemote(dir, url)
    return true
  }
  // A source checkout carries no git dir: mirror the upstream when it can be reached, and
  // otherwise ship a repository of its own, which only the remote-less pull leaves alone.
  if (url !== '' && cloneMirror(dir, url, warn)) return true
  git(['init', '-q', '-b', 'main'], dir)
  commitAll(dir)
  if (url !== '') setRemote(dir, url)
  warn(url === ''
    ? 'DeepSeek Bot: no DS_BOT_SKILLS_REPO, so the shipped skills repo has no remote to pull from'
    : `DeepSeek Bot: the skills repo is not a clone of ${url}, so its history cannot be updated by a pull`)
  return true
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  ensureSkillsRepoGit({ warn: (message) => { console.log(message) } })
}