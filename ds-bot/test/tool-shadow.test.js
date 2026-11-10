// The premise the Bot's own `read` rests on: inside a scope, a tool that shadows
// a global one can still reach the global implementation.
//
// The shadow read (src/host/fs-read-tool.js) delegates to the host's own read
// first and only takes over when the host refuses with FS_NOT_TEXT. That only
// works if `ctx.tools.get('read')` without a scope returns the host's
// implementation rather than the shadow itself.
//
// This was verified on 2026-11-08 with a real cordis Context, a real
// @deepseek-ai/dsh-tools ToolsService and a real @deepseek-ai/dsh-scope
// createScope — not a re-implementation of their logic. The result was:
//
//   {"get_noScope_isHost": true, "get_noScope_same": false,
//    "executable_noScope_isHost": true,
//    "host_execute_result": "HOST-READ-ORIGINAL", "host_execute_ok": true}
//
// The judgement: the reference taken without a scope is not the wrapper
// (different reference) and it really executes. With a scope it is the
// wrapper, which would recurse.
//
// This test is that check, made permanent so a host upgrade cannot silently
// break the delegation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'

/** The smallest systemPrompt stand-in: ToolsService only needs ctx.systemPrompt.tools(cb). */
const systemPromptStub = () => ({ tools() { return () => {} } })

const hostRead = defineTool({
  name: 'read',
  description: '宿主原版的 read 工具',
  parameters: { path: { type: 'string' } },
  output: { schema: { type: 'string' }, render: (_a, v) => ({ type: 'text', text: String(v) }) },
  execute: async () => 'HOST-READ-ORIGINAL',
})

test('a tool that shadows a global one can still reach the global implementation', async (t) => {
  const ctx = new Context()
  ctx.provide('systemPrompt', systemPromptStub())
  const service = new ToolsService(ctx)
  const hostDispose = service.register(hostRead)

  const scopeKey = { id: 'bot-scope-1' }
  const { ctx: scopedCtx, dispose: scopeDispose } = createScope(ctx, scopeKey)
  const scopedTools = scopedCtx.get('tools')
  t.after(() => { scopeDispose(); hostDispose() })

  let report
  const wrapper = defineTool({
    name: 'read',
    description: 'Bot 作用域的包装版 read',
    parameters: { path: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_a, v) => ({ type: 'text', text: String(v) }) },
    execute: async () => {
      // The four ways a wrapper can ask for the implementation it shadows.
      const viaGet = scopedTools.get('read', scopeKey)
      const viaGetNoScope = scopedTools.get('read')
      const viaExecutable = scopedTools.executable('read', scopeKey)
      const viaExecutableNoScope = scopedTools.executable('read')
      report = {
        get_withScope_same: viaGet === wrapper,
        get_noScope_same: viaGetNoScope === wrapper,
        executable_withScope_same: viaExecutable === wrapper,
        executable_noScope_same: viaExecutableNoScope === wrapper,
        get_withScope_isHost: viaGet === hostRead,
        get_noScope_isHost: viaGetNoScope === hostRead,
        executable_withScope_isHost: viaExecutable === hostRead,
        executable_noScope_isHost: viaExecutableNoScope === hostRead,
      }
      // The step that decides the delegation: the host's implementation must
      // really run when it is taken.
      try {
        const hostOut = await viaGetNoScope.execute({ path: 'x' }, {})
        report.host_execute_result = hostOut
        report.host_execute_ok = true
      } catch (error) {
        report.host_execute_ok = false
        report.host_execute_error = error instanceof Error ? error.message : String(error)
      }
      return 'WRAPPER-READ'
    },
  })
  const wrapperDispose = scopedTools.register(wrapper)
  t.after(() => wrapperDispose())

  await wrapper.execute({ path: 'x' }, {})

  assert.ok(report !== undefined, 'the wrapper ran and reported')
  // Without a scope the host's implementation is what comes back.
  assert.equal(report.get_noScope_isHost, true)
  assert.equal(report.executable_noScope_isHost, true)
  assert.equal(report.get_noScope_same, false)
  assert.equal(report.executable_noScope_same, false)
  // And it really executes.
  assert.equal(report.host_execute_ok, true)
  assert.equal(report.host_execute_result, 'HOST-READ-ORIGINAL')
  // With a scope the wrapper finds itself: that is the recursion the shadow
  // read avoids by asking without a scope.
  assert.equal(report.get_withScope_same, true)
  assert.equal(report.executable_withScope_same, true)
})
