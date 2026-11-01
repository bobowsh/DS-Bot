// 占位示例脚本：列出一个目录的顶层条目（演示 scripts/ 随技能目录整体挂载）。
import { readdirSync } from 'node:fs'

const target = process.argv[2] ?? '.'
for (const entry of readdirSync(target)) console.log(entry)
