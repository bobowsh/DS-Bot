// 造一个最小的老格式会话样本（V0–V3）：一条 user 消息 + 一个 tool/call + 一条 tool/result，
// 故意不带 role（老日志的样子），用来验证指定 V4 之后导入能过宿主的校验。
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'ds-bot-old-session-'))
const dir = join(root, 'sessions', 'ws', 'sess-1')
mkdirSync(dir, { recursive: true })

const events = [
  { type: 'turn/start', turn: 1, time: 1 },
  { type: 'user/message', turn: 1, message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
  { type: 'step/start', turn: 1, step: 1, time: 2 },
  { type: 'assistant/message', turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'let me look' }], source: { kind: 'model', provider: 'test', model: 'test' } }, stream: [] },
  { type: 'tool/call', turn: 1, step: 1, id: 'call-1', name: 'read', arguments: { path: 'a.txt' }, time: 3 },
  { type: 'tool/result', turn: 1, step: 1, message: { id: 'm3', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file' }] }], source: { kind: 'tool', callId: 'call-1' } } },
  { type: 'step/end', turn: 1, step: 1, time: 4 },
  { type: 'turn/end', turn: 1, reason: { kind: 'completed' }, time: 5 },
]

writeFileSync(join(dir, 'session.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
console.log('样本目录:', dir)
console.log('内容:')
for (const event of events) console.log('  ', event.type)
