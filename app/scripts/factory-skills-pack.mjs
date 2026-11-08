// The factory skills ship as plain directories under the data directory's skills/ folder:
// <data>/skills/<slug>/SKILL.md, copied straight from the skills source folder the manifest
// names. There is no repository, no first-start copy and no pull: the data tree the installer
// carries already has them where the runtime reads them, and a newer installer replaces them
// by the rule the installer implements (overwrite, keeping one .bak of the previous content).
// The skills source is the environment's skills folder (DS_BOT_SKILLS_SRC, by default
// <repo>/../skills); every slug the manifest promises must be there with its SKILL.md.
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The folder inside the shipped data directory the factory skills are written to. */
export const bundledSkillsDir = appDir => join(appDir, 'build', 'data', 'skills')

/** The folder the skill source checkouts live in: the environment, else beside the repo. */
export function defaultSkillsSrc(appDir) {
  const fromEnv = process.env.DS_BOT_SKILLS_SRC?.trim()
  if (fromEnv) return fromEnv
  return join(dirname(dirname(appDir)), 'skills')
}

/**
 * Put the skills the factory manifest lists into the data directory the installer ships.
 * @param {string} appDir - the app directory
 * @param {{ slug: string }[]} entries - the manifest's skill entries
 * @param {string} [skillsSrc] - the local skills source folder
 */
export async function prepareFactorySkills(appDir, entries, skillsSrc = defaultSkillsSrc(appDir)) {
  // Build from nothing: the skills-repo layout of the old mechanism must not survive into a
  // package built after it was retired, and neither must a stale skills folder.
  await rm(join(appDir, 'build', 'data', 'skills-repo'), { recursive: true, force: true })
  await rm(bundledSkillsDir(appDir), { recursive: true, force: true })
  await mkdir(bundledSkillsDir(appDir), { recursive: true })
  const made = []
  for (const { slug } of entries) {
    const from = join(skillsSrc, slug)
    if (!existsSync(join(from, 'SKILL.md'))) {
      throw new Error(`The factory skill ${slug} resolved to nothing: ${from} has no SKILL.md. The build stops instead of shipping without it.`)
    }
    const to = join(bundledSkillsDir(appDir), slug)
    await cp(from, to, { recursive: true })
    made.push(to)
  }
  return made
}
