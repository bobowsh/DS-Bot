import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

const home = mkdtempSync(join(tmpdir(), 'ds-bot-frame-'))
const ctx = fakeContext({ services: { attachments: fakeAttachments() } })
const rt = createRuntime(ctx, { home })
console.log('rt.browserFrame =', typeof rt.browserFrame)
console.log('rt.browserChannel =', typeof rt.browserChannel)
console.log('rt.config.browserPlugin =', JSON.stringify(rt.config.browserPlugin))
console.log('rt.config.browserPluginApi =', typeof rt.config.browserPluginApi)
rmSync(home, { recursive: true, force: true })
