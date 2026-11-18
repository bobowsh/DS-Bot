// The branch chip above the composer: the workspace branch, and the two ways a checkout
// answers instead of a branch name.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { branchOf } from '../src/host/workspace-branch.js'

/** A throwaway directory with the given files written into it. */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-branch-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return dir
}

test('a symbolic HEAD gives its branch name', async () => {
  const dir = fixture({ '.git/HEAD': 'ref: refs/heads/feat/branch-chip\n' })
  try {
    assert.equal(await branchOf(dir), 'feat/branch-chip')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a detached HEAD has no branch to show', async () => {
  const dir = fixture({ '.git/HEAD': '4f2a0d3c9b1e8a7f6d5c4b3a2918f7e6d5c4b3a2\n' })
  try {
    assert.equal(await branchOf(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unborn head names the branch the first commit will go on', async () => {
  // `git init` leaves HEAD pointing at a ref that does not exist yet; the name is still
  // the branch, so the chip shows it.
  const dir = fixture({ '.git/HEAD': 'ref: refs/heads/main\n' })
  try {
    assert.equal(await branchOf(dir), 'main')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a workspace that is not a git tree shows nothing', async () => {
  const dir = tempDirNoGit()
  try {
    assert.equal(await branchOf(dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a worktree follows its gitdir pointer', async () => {
  // A linked worktree's `.git` is a file naming the checkout's real directory.
  const main = fixture({
    'real-worktrees/tree1/HEAD': 'ref: refs/heads/fix/linked\n',
    'linked/.git': 'gitdir: ../real-worktrees/tree1\n',
  })
  try {
    assert.equal(await branchOf(join(main, 'linked')), 'fix/linked')
  } finally {
    rmSync(main, { recursive: true, force: true })
  }
})

test('a missing or empty path shows nothing', async () => {
  assert.equal(await branchOf(''), undefined)
  assert.equal(await branchOf(undefined), undefined)
  assert.equal(await branchOf(join(tmpdir(), 'ds-branch-does-not-exist-xyz')), undefined)
})

test('a very long branch name is shortened rather than overflowing the card', async () => {
  const long = 'feat/' + 'x'.repeat(300)
  const dir = fixture({ '.git/HEAD': `ref: refs/heads/${long}\n` })
  try {
    const name = await branchOf(dir)
    assert.ok(name.length <= 120, `expected at most 120 characters, got ${name.length}`)
    assert.ok(name.endsWith('…'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A directory that exists but holds no .git. */
function tempDirNoGit() {
  return mkdtempSync(join(tmpdir(), 'ds-branch-plain-'))
}
