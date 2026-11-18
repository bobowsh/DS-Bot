// The branch chip above the composer: the workspace branch, and the two ways a checkout
// answers instead of a branch name.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { branchOf, install } from '../src/host/workspace-branch.js'

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

// The endpoint asks for a session, not a path: which folder that session works in is the
// host's own answer (group folder → member pick → Bot folder → team workspace). Most Bots have
// no folder of their own, and reading `bot.workDir` directly is what made the chip vanish.
function endpointWith({ sessionFolder }) {
  const rt = { sessionFolder }
  install(rt)
  return async (body) => (await rt.branchEndpoint('branch', body)).branch
}

test('a Bot with no folder of its own shows the team workspace branch', async () => {
  const team = fixture({ '.git/HEAD': 'ref: refs/heads/main\n' })
  try {
    // sessionFolder is what falls back to the team workspace; the Bot itself has no workDir.
    const ask = endpointWith({ sessionFolder: () => team })
    assert.equal(await ask({ sessionId: 's-no-folder' }), 'main')
  } finally {
    rmSync(team, { recursive: true, force: true })
  }
})

test('a Bot with its own folder shows that folder branch', async () => {
  const own = fixture({ '.git/HEAD': 'ref: refs/heads/feat/own\n' })
  try {
    const ask = endpointWith({ sessionFolder: ({ id }) => (id === 's-own' ? own : undefined) })
    assert.equal(await ask({ sessionId: 's-own' }), 'feat/own')
  } finally {
    rmSync(own, { recursive: true, force: true })
  }
})

test('a group shows the branch of the folder the group works in', async () => {
  const group = fixture({ '.git/HEAD': 'ref: refs/heads/release/2.0\n' })
  try {
    const ask = endpointWith({ sessionFolder: () => group })
    assert.equal(await ask({ sessionId: 'room-1' }), 'release/2.0')
  } finally {
    rmSync(group, { recursive: true, force: true })
  }
})

test('a session whose folder is not a checkout shows nothing', async () => {
  const plain = tempDirNoGit()
  try {
    const ask = endpointWith({ sessionFolder: () => plain })
    assert.equal(await ask({ sessionId: 's-plain' }), undefined)
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test('no session and no path shows nothing', async () => {
  const ask = endpointWith({ sessionFolder: () => '/never/asked' })
  assert.equal(await ask({}), undefined)
  assert.equal(await ask({ sessionId: '' }), undefined)
})

test('a path still works for direct callers', async () => {
  const dir = fixture({ '.git/HEAD': 'ref: refs/heads/direct\n' })
  try {
    const ask = endpointWith({ sessionFolder: () => undefined })
    assert.equal(await ask({ path: dir }), 'direct')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

