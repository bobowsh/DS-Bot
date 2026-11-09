// #3 验证脚本（可复跑的开发验证工具，与 bench.sh / check.sh 同类，不是临时探针）。
// 用途：验证「在 Bot 作用域用 register 遮蔽同名工具后，工具内部还能不能取到宿主的原实现」。
// 结论（2026-11-08 实测）：能包装——ctx.tools.get(name)/executable(name) 不传 scope 时
//   拿到的是宿主原实现（引用不等于包装体，且可真的执行）；传 scope 时拿到的是自己。
//   用途是给 #3 的实现方式定依据，也给宿主升级后复核用。
//
// 关键判据：取到的实现引用，与刚注册进去的那个是不是同一个。
//   不是同一个 → 能包装（只加编码转换，其余复用宿主）
//   是同一个   → 只能重写
//
// 用的是真实 @deepseek-ai/cordis Context + 真实 @deepseek-ai/dsh-tools ToolsService
// + 真实 @deepseek-ai/dsh-scope createScope，不是自己复刻的逻辑。
//
// 运行：cd ds-bot && node dev/verify-tool-shadow.mjs
import { Context } from '@deepseek-ai/cordis'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'

const say = s => process.stdout.write(s + '\n')
const line = t => say('─'.repeat(64) + '\n' + t + '\n' + '─'.repeat(64))

/** 一个最小 systemPrompt 桩：ToolsService 构造时只需 ctx.systemPrompt.tools(cb)。 */
function systemPromptStub() {
  return { tools() { return () => {} } }
}

const readTool = defineTool({
  name: 'read',
  description: '宿主原版的 read 工具',
  parameters: { path: { type: 'string' } },
  output: { schema: { type: 'string' }, render: (_a, v) => ({ type: 'text', text: String(v) }) },
  execute: async () => 'HOST-READ-ORIGINAL',
})

async function main() {
  const ctx = new Context()
  ctx.provide('systemPrompt', systemPromptStub())
  const service = new ToolsService(ctx)
  say('ToolsService 已挂载: ' + (service !== undefined) + ' / name=' + service.name)

  // 1) 宿主在全局层注册 read
  const hostDispose = service.register(readTool)
  say('【1】宿主全局注册 read 完成')

  // 2) Bot 作用域：createScope 造一个带 scope 标签的子 ctx
  const scopeKey = { id: 'bot-scope-1' }
  const { ctx: scopedCtx, dispose: scopeDispose } = createScope(ctx, scopeKey)
  const scopedTools = scopedCtx.get('tools')
  say('【2】作用域 ctx 造好')
  say('    scopedTools 是否存在: ' + (scopedTools !== undefined))
  say('    scopedTools 是否同一实例: ' + (scopedTools === service))
  // 作用域里取到的 tools 实例是否共享同一份注册表（决定包装体能不能用 scope 视图）
  if (scopedTools) {
    say('    scopedTools.get("read") 描述: ' + scopedTools.get('read')?.description)
  }

  // 3) 在作用域注册同名 read（遮蔽）
  let wrapperExecuteRef = null
  const wrapper = defineTool({
    name: 'read',
    description: 'Bot 作用域的包装版 read',
    parameters: { path: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_a, v) => ({ type: 'text', text: String(v) }) },
    execute: async () => {
      // 包装体内部尝试取宿主原实现
      const viaGet = scopedTools.get('read', scopeKey)
      const viaGetNoScope = scopedTools.get('read')
      const viaExecutable = scopedTools.executable('read', scopeKey)
      const viaExecutableNoScope = scopedTools.executable('read')
      const report = {
        get_withScope_same: viaGet === wrapper,
        get_noScope_same: viaGetNoScope === wrapper,
        executable_withScope_same: viaExecutable === wrapper,
        executable_noScope_same: viaExecutableNoScope === wrapper,
        get_withScope_isHost: viaGet === readTool,
        get_noScope_isHost: viaGetNoScope === readTool,
        executable_withScope_isHost: viaExecutable === readTool,
        executable_noScope_isHost: viaExecutableNoScope === readTool,
        names: {
          get_withScope: viaGet?.name,
          get_noScope: viaGetNoScope?.name,
          executable_withScope: viaExecutable?.name,
          executable_noScope: viaExecutableNoScope?.name,
        },
        descriptions: {
          get_withScope: viaGet?.description,
          get_noScope: viaGetNoScope?.description,
          executable_withScope: viaExecutable?.description,
          executable_noScope: viaExecutableNoScope?.description,
        },
      }
      wrapperExecuteRef = report
      // 关键一步：拿到宿主原实现后，能不能真的执行它
      try {
        const hostTool = viaGetNoScope
        const hostOut = await hostTool.execute({ path: 'x' }, {})
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
  say('【3】作用域注册同名 read（遮蔽）完成')

  // 4) 执行包装体，收集内部取法结果
  const out = await wrapper.execute({ path: 'x' }, {})
  say('\n【4】包装体执行结果: ' + JSON.stringify(out))

  line('包装体内部四种取法的真实结果')
  say(JSON.stringify(wrapperExecuteRef, undefined, 2))

  line('判据')
  const r = wrapperExecuteRef
  const hostReachable = r.get_noScope_isHost || r.get_withScope_isHost
    || r.executable_noScope_isHost || r.executable_withScope_isHost
  say('能取到宿主原实现（引用不等于包装体）: ' + hostReachable)
  say('取到的都是自己（会递归）: ' + (!hostReachable))
  say('作用域视图看到的是: ' + r.names.get_withScope + ' / ' + r.descriptions.get_withScope)
  say('全局视图看到的是: ' + r.names.get_noScope + ' / ' + r.descriptions.get_noScope)

  // 5) 清理
  wrapperDispose(); scopeDispose(); hostDispose()
  say('\n【5】已清理注册')
  say('=== DONE ===')
}

main().catch(e => { say('FATAL ' + (e?.stack ?? e)); process.exit(1) })
