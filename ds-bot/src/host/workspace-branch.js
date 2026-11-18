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
   * The branch chip asks on mount and when the window regains focus: the branch can change
   * in a terminal beside the app. `path` is the workspace the session runs in.
   */
  rt.branchEndpoint = async (endpoint, body) => {
    if (endpoint !== 'branch') return { branch: undefined }
    return { branch: await branchOf(String(body.path ?? '')) }
  }
}
