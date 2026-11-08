// Re-creates the two directory junctions this repository keeps inside itself.
//
//   node tools/offline-kit/setup-kit.mjs
//
// Windows junctions store an absolute target, so they cannot travel with a copy of the repo: after
// the checkout is moved (a copy on a removable disk, a fresh clone on another machine) the links
// either dangle or were materialized into real copies by the copy tool. This script points them at
// this checkout's own directories again:
//
//   ds-bot/node_modules/deep-view     -> app/node_modules/deep-view
//   ds-bot/node_modules/@deepseek-ai  -> ds-bot/dev/harness/node_modules/@deepseek-ai
//
// The first link matters for more than resolution: esbuild names the bundled module by its real
// path, so a materialized copy rewrites the region comment in client.js and `npm test` then reports
// `client.js is the build of src/client` for a build that is otherwise correct.
//
// It also drops worktree registrations that point outside this checkout, which a copy carries over
// from the machine that made it. Only registrations whose worktree directory is really gone are
// removed: a registration that still resolves keeps working, so running this in a normal checkout
// with live worktrees touches nothing.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const findRepo = (start) => {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'app')) && existsSync(join(dir, 'ds-bot'))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

const repo = findRepo(dirname(fileURLToPath(import.meta.url)))
if (!repo) {
  console.error('could not find the repository root above this script')
  process.exit(1)
}

const links = [
  { link: join(repo, 'ds-bot', 'node_modules', 'deep-view'), target: join(repo, 'app', 'node_modules', 'deep-view') },
  {
    link: join(repo, 'ds-bot', 'node_modules', '@deepseek-ai'),
    target: join(repo, 'ds-bot', 'dev', 'harness', 'node_modules', '@deepseek-ai'),
  },
]

let failed = 0
for (const { link, target } of links) {
  const shown = relative(repo, link)
  if (!existsSync(target)) {
    console.error(`target missing, cannot link: ${relative(repo, target)}`)
    failed += 1
    continue
  }
  if (existsSync(link)) {
    const stat = lstatSync(link)
    if (stat.isSymbolicLink()) {
      if (readlinkSync(link) === target) {
        console.log(`already linked: ${shown}`)
        continue
      }
      unlinkSync(link)
    } else {
      // A materialized copy of the same content; drop it so the link can take its place.
      rmSync(link, { recursive: true, force: true })
    }
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, 'junction')
  console.log(`linked: ${shown}`)
}

if (failed > 0) {
  console.error(`${failed} link(s) could not be created`)
  process.exit(1)
}

const worktrees = join(repo, '.git', 'worktrees')
if (existsSync(worktrees)) {
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'inherit' })
  } catch {
    console.log('git not available; skipped the prune step')
  }
  // `prune` removes the whole directory when nothing is left to keep, so look again before reading.
  if (existsSync(worktrees)) {
    for (const name of readdirSync(worktrees)) {
      const entry = join(worktrees, name)
      let gitdir = ''
      try {
        gitdir = readFileSync(join(entry, 'gitdir'), 'utf8').trim().replaceAll('\\', '/')
      } catch {
        continue
      }
      // The registration points at <worktree>/.git; keep it whenever that worktree is still there,
      // wherever it lives. Only a registration whose worktree no longer exists is dropped, and then
      // only through git, so the index and the branch of a live worktree are never touched.
      const inside = gitdir.startsWith(`${repo.replaceAll('\\', '/')}/`)
      if (!inside && !existsSync(gitdir)) {
        rmSync(entry, { recursive: true, force: true })
        console.log(`dropped a worktree registration whose worktree is gone: ${name}`)
      }
    }
  }
}

console.log('the checkout is ready')
