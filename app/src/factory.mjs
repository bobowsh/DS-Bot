// The factory seed: the resources the installer ships with are put under the data location
// on first launch, so a fresh install opens on a ready-made Bot team. ds-bot reads the team
// from <dataDir>/factory/factory-team.json (src/host/factory-seed.js). The factory skills and
// plugins travel inside the data tree itself (data/.agents/skills/, data/profiles/), so the
// installer or the first start puts them in place without any network use; the seed below is
// the only resource that is version-checked and copied on first launch.
//
// The factory rules are the other shipped file: AGENTS.md lands in the shared agents root
// (<dataDir>/.agents/AGENTS.md), which the Host reads as DSH_AGENTS_HOME. It is a factory
// component and follows the package it came with, so it is written on every start. The rules a
// user writes for themselves belong in <dataDir>/AGENTS.md, the harness home file: it outranks
// the shared root's, and nothing here ever writes it (only a blank file is put there once, so
// the place to write is visible in the first place).
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const seedFile = dataDir => join(dataDir, 'factory', 'factory-team.json')
/** The shipped factory rules: what every fresh install tells its Bots. */
const bundledRules = resourcesDir => join(resourcesDir, 'factory', 'AGENTS.md')
/** Where the Host reads the shared root's rules from (DSH_AGENTS_HOME/AGENTS.md). */
const rulesFile = dataDir => join(dataDir, '.agents', 'AGENTS.md')
/** The harness home file: the user's own rules, which outrank the shared root's. */
const userRulesFile = dataDir => join(dataDir, 'AGENTS.md')
// Says what the file is for, without adding a rule of its own: an empty file is dropped by the
// instruction loader (blank content is no content), so the hint has to be a comment.
const USER_RULES_PLACEHOLDER = '<!-- Your own rules for every Bot go here. The factory rules are in .agents/AGENTS.md. -->\n'

/** The version a factory seed declares, or undefined when there is none to read. */
function seedVersion(path) {
  try {
    const version = JSON.parse(nodeFs.readFileSync(path, 'utf8'))?.version
    return version === undefined || version === null ? undefined : String(version)
  } catch {
    return undefined
  }
}

/** Whether `candidate` is a newer seed version than `installed`. Plain numbers compare as numbers. */
function newerSeed(candidate, installed) {
  if (installed === undefined) return true
  const a = Number(candidate)
  const b = Number(installed)
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b
  return String(candidate) > String(installed)
}

/** Write the factory rules into the shared agents root. Returns whether there were any to write. */
async function installFactoryRules({ dataDir, resourcesDir, signal }) {
  const bundled = bundledRules(resourcesDir)
  if (!existsSync(bundled)) return false
  // The rules are a factory component like the plugins: an upgrade replaces them, so a copy the
  // package already put there is rewritten rather than compared.
  await mkdir(join(dataDir, '.agents'), { recursive: true, signal })
  await cp(bundled, rulesFile(dataDir), signal)
  return true
}

/** Put the blank harness home file in place, once, and never over rules the user wrote. */
async function installUserRulesPlaceholder({ dataDir, signal }) {
  const file = userRulesFile(dataDir)
  if (existsSync(file)) {
    // A file the user kept and then emptied is still theirs: leave an existing file alone, and
    // only fill one that carries nothing at all, so a blank place to write appears.
    try {
      if ((await readFile(file, 'utf8')).trim() !== '') return false
    } catch {
      return false
    }
    await writeFile(file, USER_RULES_PLACEHOLDER, { encoding: 'utf8', signal })
    return false
  }
  // A first run reaches here before anything else has made the data location.
  await mkdir(dataDir, { recursive: true, signal })
  await writeFile(file, USER_RULES_PLACEHOLDER, { encoding: 'utf8', signal })
  return true
}

export async function installFactoryResources({ dataDir, resourcesDir, signal }) {
  const result = { seedCopied: false, rulesWritten: false, userRulesSeeded: false }
  const bundledSeed = join(resourcesDir, 'factory', 'factory-team.json')
  // A seed that ships a newer version replaces the one already installed: an upgrade must be able
  // to renew the factory team. The copy is skipped while the versions match, so a seed the user
  // edited in place is left alone, and one that carries a version ahead of the installer's keeps
  // winning. ds-bot refreshes the seeded Bots when this version moves (src/host/factory-seed.js).
  if (existsSync(bundledSeed) && newerSeed(seedVersion(bundledSeed), existsSync(seedFile(dataDir)) ? seedVersion(seedFile(dataDir)) : undefined)) {
    await mkdir(join(dataDir, 'factory'), { recursive: true, signal })
    await cp(bundledSeed, seedFile(dataDir), signal)
    result.seedCopied = true
  }
  result.rulesWritten = await installFactoryRules({ dataDir, resourcesDir, signal })
  result.userRulesSeeded = await installUserRulesPlaceholder({ dataDir, signal })
  return result
}
