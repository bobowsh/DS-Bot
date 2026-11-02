// The Host's output reaches this process's own stdout and stderr, and a stream whose reader is
// gone must not end the app: a launcher that started it and then went away leaves those streams
// as pipes nobody reads, where a write fails with EPIPE — unhandled, that ends the main process
// and the running team with it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forward } from '../src/host-process.mjs'

// A stream that fails every write the way a pipe without a reader does: it throws.
function throwingStream() {
  const calls = []
  return {
    calls,
    write(text) {
      calls.push(text)
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    },
    on() {},
  }
}

// A stream that reports the failure as an error event instead, which is the other way a pipe
// without a reader fails.
function erroringStream() {
  const handlers = []
  const stream = {
    handlers,
    writes: 0,
    write() { this.writes += 1; return true },
    on(event, handler) { if (event === 'error') handlers.push(handler) },
  }
  return stream
}

test('a write that throws does not escape', () => {
  const stream = throwingStream()
  // The call must not throw: an uncaught EPIPE here is what ends the main process.
  assert.doesNotThrow(() => forward(stream, 'a line on stderr\n'))
  assert.deepEqual(stream.calls, ['a line on stderr\n'], 'the text was offered to the stream')
})

test('the stream carries an error handler that swallows the failure', () => {
  const stream = erroringStream()
  forward(stream, 'a line on stdout\n')
  assert.equal(stream.handlers.length, 1, 'one error handler is installed')
  assert.doesNotThrow(() => stream.handlers[0](Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
  assert.equal(stream.writes, 1, 'the output was still offered to the stream')
})

test('the error handler is installed once, not per write', () => {
  const stream = erroringStream()
  forward(stream, 'one\n')
  forward(stream, 'two\n')
  forward(stream, 'three\n')
  assert.equal(stream.handlers.length, 1, 'a second handler would only collect garbage')
  assert.equal(stream.writes, 3)
})

test('a stream that works is written to as before', () => {
  const written = []
  const stream = { write(text) { written.push(text); return true }, on() {} }
  forward(stream, 'the Host said this\n')
  assert.deepEqual(written, ['the Host said this\n'])
})
