# Offline kit tools

`setup-kit.mjs` repairs a checkout that was **copied or moved** to another machine or path. Run it
once, after the copy is in place:

```sh
node tools/offline-kit/setup-kit.mjs
```

It does two things, both idempotent:

1. **Recreates the two directory junctions the repository keeps inside itself.** Windows junctions
   store an absolute target, so they cannot travel with a copy; copying usually also materializes
   them into real duplicates.

   | link | target |
   |---|---|
   | `ds-bot/node_modules/deep-view` | `app/node_modules/deep-view` |
   | `ds-bot/node_modules/@deepseek-ai` | `ds-bot/dev/harness/node_modules/@deepseek-ai` |

   The first one is not only about resolution: esbuild names a bundled module by its real path, so a
   materialized copy rewrites the region comment in `client.js` and `npm test` then reports
   `client.js is the build of src/client` for an otherwise correct build.

2. **Drops worktree registrations whose worktree no longer exists.** A copy carries the source
   machine's entries in `.git/worktrees`; the directories they point at are gone, so `git worktree
   list` would show dead paths. Registrations that still resolve are left alone, so running this in a
   normal checkout with live worktrees changes nothing. Branches are never touched.

## Where this comes from

The offline kit delivered on 2026-11-02 (`E:\dsbot-work\offline-kit`) was built with this script.
The kit and its full checklist — what to carry, the exact packaging command, the known traps — are
described in `docs/OFFLINE-PACKAGING.md`; this directory only holds the repair script that the copied
checkout needs.
