// Factory seed: the pre-made Bot team shipped with the installer. ds-bot applies it on its
// own at startup (after state is loaded, before the first Bot runs) because it owns the
// state.json shape and Bot creation. The app only drops `factory-team.json` under
// <dshHome>/factory/ on first launch; this module reads it, builds the seed Bots through the
// same createBot path a user-driven create takes, and on an app upgrade refreshes the seed
// Bots back to factory values by their stable `factoryId`, leaving user Bots untouched.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function install(rt) {
  const { state, dshHome } = rt

  // The seed file lives under the data directory the app fixed on first run (rt.dshHome),
  // copied there by the app before ds-bot ever starts. When the app's copy has not landed yet
  // (it runs off the ready path, so a first boot can beat it), the packaged resources directory
  // named by DS_BOT_FACTORY_RESOURCES is read directly: the team still ships on first launch.
  const seedPath = () => join(dshHome, 'factory', 'factory-team.json')
  const bundledSeedPath = () => {
    const dir = process.env.DS_BOT_FACTORY_RESOURCES?.trim()
    return dir ? join(dir, 'factory', 'factory-team.json') : undefined
  }

  function readSeed() {
    for (const path of [seedPath(), bundledSeedPath()]) {
      if (!path) continue
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') rt.warn('ds-bot: factory seed could not be read: %s', error?.message ?? error)
        continue
      }
      let seed
      try {
        seed = JSON.parse(text)
      } catch (error) {
        rt.warn('ds-bot: factory seed is not valid JSON: %s', error?.message ?? error)
        continue
      }
      if (seed && Array.isArray(seed.bots) && seed.bots.length > 0) return seed
    }
    return null
  }

  // A seed capability item, with a relative locator resolved against the data directory so
  // configFor can read `<locator>/SKILL.md` directly. Skill items carry `content` only when
  // inline; a locator item reads its SKILL.md at mount time (capabilities.js), so no content
  // is stored here. MCP items keep the fields capabilities.js expects.
  function seedItem(name, item) {
    const now = Date.now()
    const base = { name, kind: item.kind, description: String(item.description ?? '').trim(), createdBy: null, createdAt: now, updatedAt: now }
    if (item.kind === 'skill') {
      if (item.locator) return { ...base, locator: join(dshHome, item.locator) }
      return { ...base, content: String(item.content ?? '').trim() }
    }
    if (item.kind === 'mcp') {
      const transport = item.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
      if (transport === 'stdio') return { ...base, transport, command: String(item.command ?? '').trim(), args: [...item.args ?? []], env: { ...item.env }, approved: item.approved === true }
      return { ...base, transport, url: String(item.url ?? '').trim(), headers: { ...item.headers }, approved: true }
    }
    if (item.kind === 'pack') return { ...base, items: [...item.items ?? []] }
    return null
  }

  // Merge the seed's capability library into state, overwriting items by name and leaving
  // anything the user made that is not named in the seed.
  function applyCapabilities(seed) {
    state.capabilities ??= { items: {} }
    state.capabilities.items ??= {}
    const items = state.capabilities.items
    for (const [name, raw] of Object.entries(seed.capabilities?.items ?? {})) {
      const built = seedItem(name, raw)
      if (built) items[name] = built
    }
  }

  // Refresh one already-stored seed Bot to factory values. Name, role, instructions, model
  // and the attached capability list are reset; anything the user changed is overwritten —
  // that is what "update the factory team" means.
  function refreshBot(bot, seedBot) {
    const cleanName = String(seedBot.name ?? '').trim().slice(0, 40)
    if (cleanName) bot.name = cleanName
    bot.role = String(seedBot.role ?? '').trim().slice(0, 24)
    if (seedBot.instructions !== undefined) bot.instructions = String(seedBot.instructions).trim()
    if (seedBot.model) bot.model = seedBot.model
    bot.capabilities = [...seedBot.capabilities ?? []]
  }

  // Build a seed Bot through createBot so it gets a real Session, kickoff and greeting like
  // any other Bot. A model the app pool cannot resolve degrades to pickModel (a fresh team
  // still opens and asks), never to a hard failure that stops the whole seed.
  async function createSeedBot(seedBot) {
    const options = {
      name: seedBot.name,
      role: seedBot.role,
      instructions: seedBot.instructions,
      ...(seedBot.color ? { color: seedBot.color } : {}),
      main: seedBot.main === true,
      createdBy: null,
      factoryId: seedBot.factoryId,
      // The skills the seed gives this Bot. Without this a seeded team opens with the capability
      // library in place but nobody holding a skill, which looks like the seed did nothing.
      ...(Array.isArray(seedBot.capabilities) ? { capabilities: [...seedBot.capabilities] } : {}),
    }
    if (seedBot.model) {
      try {
        await rt.resolveModel(seedBot.model)
        options.model = seedBot.model
      } catch {
        options.pickModel = true
      }
    } else {
      options.pickModel = true
    }
    return rt.createBot(options)
  }

  // Apply the factory seed. First launch (empty team) creates every seed Bot; an upgrade
  // (version moved) refreshes seed Bots by factoryId, adds any new ones, and leaves user Bots
  // (no factoryId) untouched. A same version on a non-empty team is a no-op (idempotent).
  async function applySeed() {
    const seed = readSeed()
    if (!seed) return
    const version = String(seed.version ?? '0')
    const empty = Object.keys(state.bots).length === 0
    if (!empty && state.factorySeedVersion === version) return
    applyCapabilities(seed)
    for (const seedBot of seed.bots) {
      const existing = seedBot.factoryId ? Object.values(state.bots).find(bot => bot.factoryId === seedBot.factoryId) : undefined
      if (existing) refreshBot(existing, seedBot)
      else {
        // One bad seed Bot (a name that clashes with a user's Bot, a failed Session create)
        // must not abort the whole seed or hang startup: skip it, keep the rest, and record
        // the version so the next launch does not retry the same failure every boot.
        try {
          await createSeedBot(seedBot)
        } catch (error) {
          rt.warn('ds-bot: factory seed Bot %s not created: %s', seedBot.factoryId ?? seedBot.name, error?.message ?? error)
        }
      }
    }
    state.factorySeedVersion = version
    await rt.save()
  }

  Object.assign(rt, { applySeed })
}
