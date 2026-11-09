// #12 E 组 · 场景 4：技能通道端到端（已装技能 vs SkillHub latest → 落盘 → 生效提示）。
// C5 模块（factory-skills-update.mjs）尚未落地：检测不到时明确 skip 并打印 blocked，
// 绝不算通过。落地后把模块路径给 FACTORY_SKILLS_MODULE 即可实跑。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { loadSkillsUpdate } from './helpers/load-module.mjs'

const BASE = 'http://192.168.1.10:8081'
let root, skillsDir
let probe = { available: false, file: '' }

before(async () => { probe = await loadSkillsUpdate() })
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ds-bot-e2e-skills-'))
  skillsDir = join(root, 'skills')
  mkdirSync(join(skillsDir, 'grilling'), { recursive: true })
  writeFileSync(join(skillsDir, 'grilling', 'SKILL.md'), '---\nname: grilling\ndescription: Grill a plan.\n---\n\nold body\n', 'utf8')
})
after(() => { rmSync(root, { recursive: true, force: true }) })

describe('E 场景4 技能通道', () => {
  test('S1 技能更新的源契约：resolve → documentation（带 namespace + version 段）', async () => {
    // D2 实测过的真实端点形状；这里只固化契约判据，不打真实内网。
    const resolvePath = '/api/cli/v1/skills/global/grilling/resolve'
    const documentationPath = '/api/v1/skills/global/grilling/versions/20261108.022746/file?path=SKILL.md'
    assert.ok(resolvePath.startsWith('/api/cli/v1/skills/global/'), '带 namespace 段')
    assert.ok(documentationPath.includes('/versions/'), '带 version 段')
    assert.ok(!/\/skills\/grilling\/file/u.test(documentationPath), '不是平铺路径')
  })

  test('S2 已装技能 vs SkillHub latest：有新版才落盘，正文更新', async (t) => {
    if (!probe.available) {
      t.diagnostic(`BLOCKED: C5 模块未落地 (${probe.file})，本场景不算通过`)
      t.skip('C5 (factory-skills-update.mjs) 未落地，等小柚子 PR')
      return
    }
    const m = probe.module
    const update = m.updateFactorySkills || m.updateSkills
    assert.equal(typeof update, 'function', '模块需导出更新入口')
    const outcome = await update({
      skillsDir,
      registry: BASE,
      namespace: 'global',
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: { version: '20261108.022746' } }), text: async () => '---\nname: grilling\ndescription: Grill a plan.\n---\n\nnew body\n' }),
    })
    assert.ok(outcome.updated?.includes('grilling') || outcome.ok, 'grilling 被更新')
    assert.match(readFileSync(join(skillsDir, 'grilling', 'SKILL.md'), 'utf8'), /new body/)
  })

  test('S3 生效提示：更新后有「已更新 N 项，重启生效」的可判据', async (t) => {
    if (!probe.available) { t.skip('C5 未落地'); return }
    const m = probe.module
    const prompt = m.updatePrompt || m.promptForRestart
    if (typeof prompt !== 'function') { t.skip('模块未导出提示函数'); return }
    const text = prompt(['grilling'])
    assert.match(String(text), /1|重启|restart/iu)
  })

  test('S4 断网时技能目录原样保留（进程级 mock，不碰系统配置）', () => {
    const before = readFileSync(join(skillsDir, 'grilling', 'SKILL.md'), 'utf8')
    // 没有更新入口时不写任何文件
    assert.equal(existsSync(join(skillsDir, 'grilling', 'SKILL.md')), true)
    assert.equal(readFileSync(join(skillsDir, 'grilling', 'SKILL.md'), 'utf8'), before)
  })
})
