import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
// Installed before the subject loads: the SDK captures `fetch` when it does.
import { useProvider } from './_provider.mjs'

const { streamChatCompletion } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'dist', 'model', 'chat.js')).href
)

/** A provider that accepts the request and never answers it. */
function hangingProvider(seen) {
  return (_url, init) => {
    seen.push(init)
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  }
}

test('an abort stops a round the provider never answers', async () => {
  const seen = []
  const restore = useProvider(hangingProvider(seen))
  try {
    const startedAt = Date.now()
    await assert.rejects(
      streamChatCompletion(
        { apiKey: 'sk-test', model: 'zen/x', messages: [{ role: 'user', content: 'hi' }], signal: AbortSignal.timeout(200) },
        () => {},
      ),
      err => err instanceof Error && err.name === 'AbortError',
    )
    assert.ok(Date.now() - startedAt < 5_000, 'the abort must end the round, not the provider')
  } finally {
    restore()
  }
})

test('signal and timeout are request options, never fields of the request body', async () => {
  const seen = []
  const restore = useProvider(hangingProvider(seen))
  try {
    await assert.rejects(
      streamChatCompletion(
        { apiKey: 'sk-test', model: 'zen/x', messages: [{ role: 'user', content: 'hi' }], signal: AbortSignal.timeout(100) },
        () => {},
      ),
    )
    assert.equal(seen.length, 1)
    const body = JSON.parse(seen[0].body)
    assert.equal('signal' in body, false)
    assert.equal('timeout' in body, false)
  } finally {
    restore()
  }
})
