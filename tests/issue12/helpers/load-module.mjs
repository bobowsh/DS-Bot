// #12 E 组：加载被测模块。默认指向合并后的 app/src/factory-update.mjs；
// PR #20 未合并时可用 FACTORY_UPDATE_MODULE 指向 worktree 里的文件先跑通。
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

const DEFAULT = resolve('app/src/factory-update.mjs')

/** @returns {Promise<object>} the factory-update module exports */
export async function loadFactoryUpdate() {
  const file = resolve(process.env.FACTORY_UPDATE_MODULE || DEFAULT)
  if (!existsSync(file)) {
    throw new Error(`factory-update.mjs not found at ${file}. Merge PR #20 into dev-me, or set FACTORY_UPDATE_MODULE.`)
  }
  return import(pathToFileURL(file).href)
}

/** A C5 skills-channel module is not shipped yet; report blocked, never a false pass. */
export async function loadSkillsUpdate() {
  const file = resolve(process.env.FACTORY_SKILLS_MODULE || 'app/src/factory-skills-update.mjs')
  if (!existsSync(file)) return { available: false, file }
  return { available: true, file, module: await import(pathToFileURL(file).href) }
}
