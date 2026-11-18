// The git branch of the Bot's workspace, for the chip above the composer.
//
// Read straight out of `.git/HEAD`, not by running git: this runs on every composer
// mount and on focus, and a subprocess per call would cost more than the whole chip.
// The two shapes that matter are a symbolic ref (`ref: refs/heads/<name>`) and a
// detached head (a raw object id), which has no branch name to show.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Cap on the porcelain answer: a repository that says nothing is not worth a round trip. */
const MAX_BRANCH = 120

/**
 * The branch a working tree has checked out, or undefined when it is not a git tree,
 * is on a detached or unborn head, or HEAD cannot be read.
 * @param {string} workDir
 * @returns {Promise<string | undefined>}
 */
export async function branchOf(workDir) {
  if (typeof workDir !== 'string' || workDir === '') return undefined
  // A worktree's `.git` is a file pointing at the real directory; a plain clone's is a
  // directory. `rev-parse` handles both, but reading it does not, so the file form is
  // followed by hand below.
  const dotGit = join(workDir, '.git')
  let headPath = join(dotGit, 'HEAD')
  try {
    const info = await stat(dotGit)
    if (info.isFile()) {
      // `gitdir: <path>` — the checkout lives elsewhere, and HEAD lives with it.
      const pointer = (await readFile(dotGit, 'utf8')).trim()
      const target = pointer.match(/^gitdir:\s*(.+)$/u)?.[1]
      if (target === undefined) return undefined
      headPath = join(workDir, target.trim(), 'HEAD')
    }
  } catch {
    return undefined
  }
  let head
  try {
    head = (await readFile(headPath, 'utf8')).trim()
  } catch {
    return undefined
  }
  // `ref: refs/heads/feat/x` names a branch; anything else is a detached head.
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/u)
  if (ref === null) return undefined
  const name = ref[1].trim()
  if (name === '') return undefined
  return name.length > MAX_BRANCH ? `${name.slice(0, MAX_BRANCH - 1)}…` : name
}

export function install(rt) {
  /**
   * The branch chip asks for a session, not a path: where that session actually works is
   * `sessionFolder`'s answer — the group's folder, else this member's pick inside it, else the
   * Bot's own folder, else the team workspace. Most Bots have no folder of their own, so a
   * caller that read `bot.workDir` directly got undefined and rendered nothing.
   *
   * Resolving here rather than in the client keeps one copy of those rules; the client would
   * otherwise have to mirror the fallbacks and drift from them.
   */
  rt.branchEndpoint = async (endpoint, body) => {
    if (endpoint !== 'branch') return { branch: undefined }
    // `path` stays supported: it is what the unit tests and any direct caller use.
    if (typeof body.path === 'string' && body.path !== '') {
      return { branch: await branchOf(body.path) }
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return { branch: undefined }
    // `sessionFolder` reads `session.id` (and `session.header`, which a bare id leaves
    // undefined so the folder is resolved from the roster instead of a reported cwd).
    const folder = rt.sessionFolder?.({ id: sessionId })
    if (typeof folder !== 'string' || folder === '') return { branch: undefined }
    return { branch: await branchOf(folder) }
  }
}
