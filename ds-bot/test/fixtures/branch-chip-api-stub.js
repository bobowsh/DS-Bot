// A stub of the client's API module, used by the branch chip test: the branch endpoint
// answered from a table the test owns, so no call leaves the test.
//
// The table is handed in by the test through the sandbox's globals.
//
// The endpoint's contract is the host's business: it may be asked for a workspace path
// or for the session that works in one. The stub answers for both — `paths` maps a
// directory to its branch, `sessions` maps a session to the directory it works in — so
// this test does not decide which of the two the host uses.
// `globalThis.__branchStub` is set before this module is bundled; the sandbox's view of it
// differs from the test's, so it is read from the global object rather than a free name.
const table = globalThis.__branchStub ?? (globalThis.__branchStub = { branches: new Map(), calls: [], sessions: new Map(), answered: new Map() })

export const calls = table.calls

export const call = async (endpoint, payload) => {
  table.calls.push([endpoint, payload])
  if (endpoint !== 'branch') return undefined
  // Asked for a session: the directory it works in is what the host knows.
  const path = payload?.path ?? table.sessions.get(payload?.sessionId)
  const branch = table.branches.get(path)
  // What was answered is remembered for that session, so a later render of it reads
  // the same branch back.
  if (payload?.sessionId !== undefined) table.answered.set(payload.sessionId, branch)
  return { branch }
}
