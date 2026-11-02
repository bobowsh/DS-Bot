// Runs the Host in Electron's Node mode and owns its lifetime.
// Follows DeepSeek Harness apps/desktop/src/host-process.ts (MIT); see NOTICE.
import { spawn } from 'node:child_process'

const STDERR_TAIL_CHARS = 8 * 1024

// The web server prints its launch URL, and the launch token in it opens the Host.
const redact = (text) => text.replace(/([?&]token=)[^&\s]+/gu, '$1<hidden>')

const settlesWithin = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => { resolve(false) }, ms)
  void promise.then(() => { clearTimeout(timer); resolve(true) })
})

/**
 * Write to one of this process's own streams, keeping a stream that cannot be written to from
 * ending the process.
 *
 * A launcher that started the app and then went away leaves stdout and stderr as pipes with no
 * reader: writing throws EPIPE, or emits it as an `error` event, and either one is uncaught and
 * fatal. The Host's output is only echoed here, so a write that cannot be made is dropped.
 * @param {NodeJS.WriteStream} stream - the stream to write to
 * @param {string} text - what to write
 */
export function forward(stream, text) {
  // The handler stays for the life of the stream: a later write fails the same way, and the
  // write that failed has already been dropped.
  if (!stream.__dsBotForwardGuard) {
    stream.__dsBotForwardGuard = true
    stream.on('error', () => {})
  }
  try {
    stream.write(text)
  } catch {
    // EPIPE and its siblings: the reader is gone, so this output has nowhere to go.
  }
}

export class HostProcess {
  #options
  #child
  #ready
  #exit
  #stderr = ''
  #stopping = false
  #failed = false
  #messageListeners = new Set()

  /**
   * @param {{ entry: string, cwd: string, env: NodeJS.ProcessEnv, pnpm: string, onFailure: (error: Error) => void }} options
   *   `onFailure` receives the first unexpected failure, also after the Host was ready.
   */
  constructor(options) { this.#options = options }

  /**
   * @returns {Promise<{ url: string, injections: unknown[] } | { unreadable: string[] }>} the Host's launch URL
   *   and index injections; for the first-run check, the Sessions it cannot read
   */
  start() {
    this.#ready ??= new Promise((resolve, reject) => {
      const { entry, cwd, env, pnpm } = this.#options
      const child = spawn(process.execPath, ['--expose-internals', entry, pnpm], {
        cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.#child = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      // The Host's output goes to this process's own stdout and stderr, which are pipes when the
      // app was started by a launcher that has gone away: a write then fails with EPIPE (or
      // ECONNRESET), and an unhandled one of those ends the main process, which would take the
      // running team down with it. The output is only a copy of what the Host said, so a write
      // that cannot be made is dropped.
      child.stdout.on('data', (chunk) => { forward(process.stdout, redact(chunk)) })
      child.stderr.on('data', (chunk) => {
        forward(process.stderr, redact(chunk))
        this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_CHARS)
      })
      child.on('message', (message) => {
        for (const listener of this.#messageListeners) listener(message)
        if (message?.type === 'ready') resolve({ url: message.url, injections: message.injections })
        else if (message?.type === 'fatal') this.#fail(new Error(message.message), reject)
      })
      child.once('error', (error) => { this.#fail(error, reject) })
      this.#exit = new Promise((done) => {
        child.once('close', (code) => {
          const tail = redact(this.#stderr.trim())
          this.#fail(new Error(`The DSH Host stopped (exit ${String(code)})${tail === '' ? '' : `:\n${tail}`}`), reject)
          done()
        })
      })
    })
    return this.#ready
  }

  onMessage(listener) { this.#messageListeners.add(listener); return () => this.#messageListeners.delete(listener) }

  send(message) {
    if (!this.#child?.connected) throw new Error('The DSH Host IPC channel is closed')
    this.#child.send(message)
  }

  /** Ask the Host to shut down, then end it if it does not exit in time. */
  async stop() {
    const child = this.#child
    if (child === undefined) return
    this.#stopping = true
    if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error) console.error(error) })
    if (!await settlesWithin(this.#exit, 10_000)) child.kill()
    if (!await settlesWithin(this.#exit, 5_000)) child.kill('SIGKILL')
    this.#child = undefined
  }

  #fail(error, reject) {
    reject(error)
    if (this.#failed || this.#stopping) return
    this.#failed = true
    this.#options.onFailure(error)
  }
}
