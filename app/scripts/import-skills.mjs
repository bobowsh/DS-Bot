// Import the bundled skills-repo into the intranet SkillHub with the official SkillHub CLI.
//
// One-shot deployment tool: after it runs, skills are version-managed by SkillHub and the
// shipped skills-repo is only a first-boot seed. Follows the official cli/README.md:
// skillhub login (token from environment), publish <dir> --dry-run to validate, then publish.
// The CLI packs a folder into a zip and reads name + description from SKILL.md frontmatter.
//
// The token is read from the environment only: never printed, written to a file, or put on a
// command line (process lists are visible). CLI output is scrubbed before it is logged.
//
// Usage:
//   node scripts/import-skills.mjs --precheck   # frontmatter only, no token, no network
//   node scripts/import-skills.mjs --dry-run    # login + validate all, publish nothing
//   node scripts/import-skills.mjs --publish    # login + validate + publish missing
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILLHUB_REGISTRY = 'http://192.168.1.10:8081'
export const SKILLS_ROOT = fileURLToPath(new URL('../resources/skills-repo', import.meta.url))

/** Parse the simple YAML frontmatter of a SKILL.md; enough for name/description presence. */
export function readFrontmatter(text) {
  const lines = text.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return null
  let end = -1
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break }
  if (end < 0) return null
  const fields = {}
  let key = null
  for (let i = 1; i < end; i++) {
    const match = lines[i].match(/^([A-Za-z0-9_.-]+):\s*(.*)$/u)
    if (match) { key = match[1]; fields[key] = match[2] }
    else if (key && /^\s+/u.test(lines[i])) fields[key] += ' ' + lines[i].trim()
  }
  return fields
}

/** The official CLI requires name + description; add them from the folder name and body. */
export function completeFrontmatter(name, text) {
  const fields = readFrontmatter(text)
  if (fields?.name?.trim() && fields?.description?.trim()) return text
  const title = (text.match(/^#\s+(.+)$/mu) || [, name])[1].trim()
  const description = text.split(/\r?\n/u)
    .find(line => line.trim() && !line.startsWith('#') && !line.startsWith('---'))?.trim()
    || 'DS Bot factory skill: ' + title
  return '---\nname: ' + name + '\ndescription: ' + description.slice(0, 200) + '\n---\n\n' + text
}

/** The skill directories that ship (everything except .git). */
export function skillDirectories(root = SKILLS_ROOT) {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== '.git')
    .map(entry => entry.name)
}

/** Copy skills into a disposable directory and complete missing frontmatter. Never edits the source. */
export function stageSkills(root = SKILLS_ROOT, stage = join(tmpdir(), 'ds-bot-import-skills-')) {
  // The staging folder must not sit inside the source: skillDirectories would list it as a
  // skill and cpSync would try to copy the folder into itself.
  const source = resolve(root)
  const destination = resolve(stage)
  if (destination === source || destination.startsWith(source + '/') || destination.startsWith(source + '\\')) {
    throw new Error('the staging directory must not be inside the skills source')
  }
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const staged = []
  for (const name of skillDirectories(root)) {
    const to = join(stage, name)
    cpSync(join(root, name), to, { recursive: true, filter: source => !source.includes('.git') })
    const skillMd = join(to, 'SKILL.md')
    if (existsSync(skillMd)) writeFileSync(skillMd, completeFrontmatter(name, readFileSync(skillMd, 'utf8')), 'utf8')
    staged.push({ name, dir: to })
  }
  return { stage, staged }
}

/** Run the official CLI with the token only in the environment; scrub any token from output. */
export function skillhub(args, { token, cli = 'skillhub', env = process.env } = {}) {
  const runEnv = { ...env, SKILLHUB_TOKEN: token }
  const run = spawnSync(process.platform === 'win32' ? 'cmd.exe' : cli,
    process.platform === 'win32' ? ['/c', cli, ...args] : args,
    { env: runEnv, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  const escaped = token ? token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') : null
  const safe = ((run.stdout || '') + (run.stderr || ''))
    .replace(escaped ? new RegExp(escaped, 'gu') : /$^/u, '<redacted>')
    .replace(/sk_[A-Za-z0-9_-]{16,}/gu, '<redacted>')
  return { status: run.status, output: safe, ok: /"ok":true/u.test(safe) }
}

/** Which slugs the registry already holds (anonymous read). */
export async function publishedSlugs(registry, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(registry + '/api/v1/skills', { signal: AbortSignal.timeout(10_000) })
  const body = await response.json()
  return (body.items || []).map(item => item.slug)
}

/** One-shot deployment entry point. Validates every skill, publishes only missing ones. */
export async function importSkills(options = {}) {
  const registry = options.registry || process.env.SKILLHUB_REGISTRY || SKILLHUB_REGISTRY
  const namespace = options.namespace || 'global'
  const visibility = options.visibility || 'public'
  const cli = options.cli || 'skillhub'
  const token = options.token ?? process.env.DSH_SECRET_SKILLHUB_TOKEN ?? process.env.SKILLHUB_TOKEN ?? ''
  const publish = options.publish === true
  const report = { registry, namespace, visibility, publish, skills: [], dryRun: [], published: [], errors: [] }

  const { staged } = stageSkills(options.root)
  report.skills = staged.map(s => s.name)
  if (!token) { report.errors.push('SKILLHUB_TOKEN is not set'); return report }

  const login = skillhub(['login', '--registry', registry, '--json'], { token, cli })
  report.login = { status: login.status, ok: login.ok, output: login.output }
  if (!login.ok) { report.errors.push('login failed'); return report }

  for (const skill of staged) {
    const args = ['publish', skill.dir, '--namespace', namespace, '--visibility', visibility, '--registry', registry, '--dry-run', '--json']
    const dry = skillhub(args, { token, cli })
    report.dryRun.push({ name: skill.name, status: dry.status, output: dry.output })
    if (!dry.ok) { report.errors.push(skill.name + ': dry-run failed'); return report }
  }
  if (!publish) return report

  const have = await publishedSlugs(registry, options.fetch).catch(() => [])
  for (const skill of staged.filter(s => !have.includes(s.name))) {
    const args = ['publish', skill.dir, '--namespace', namespace, '--visibility', visibility, '--registry', registry, '--json']
    const result = skillhub(args, { token, cli })
    report.published.push({ name: skill.name, status: result.status, output: result.output })
  }
  report.serverSlugs = await publishedSlugs(registry, options.fetch).catch(() => [])
  return report
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : undefined
  if (args.includes('--precheck')) {
    for (const name of skillDirectories(root)) {
      const fields = readFrontmatter(readFileSync(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8'))
      console.log((fields?.name?.trim() && fields?.description?.trim() ? 'ok   ' : 'fix  ') + ' ' + name)
    }
  } else {
    const report = await importSkills({ publish: args.includes('--publish'), root })
    console.log(JSON.stringify(report, null, 2))
    if (report.errors.length) process.exitCode = 1
  }
}
