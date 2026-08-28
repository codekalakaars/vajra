import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import type { SessionCreateParams, SessionAttachParams, SessionStopParams } from '@vajra/protocol'

export function registerSessionHandlers(router: RpcRouter<ServerContext>): void {
  router.register('session.create', async (params: SessionCreateParams, ctx) => {
    const result = await ctx.sessions.create(params, (sessionId) => ctx.connection.subscribe(sessionId))

    // Start the agent loop in the background — the handler returns immediately
    // with the sessionId, and the loop runs concurrently, emitting push events
    // as it progresses.
    if (ctx.apiKey) {
      ctx.sessions.startSession(result.sessionId, ctx.apiKey).catch((err) => {
        console.error(`Agent loop failed for session ${result.sessionId}:`, err)
      })
    }

    return result
  })

  router.register('session.list', (_params: unknown, ctx) => ctx.sessions.list())

  router.register('session.attach', (params: SessionAttachParams, ctx) => {
    // Subscribing before reading current state means no push event fired
    // between the read and the subscription can be missed.
    ctx.connection.subscribe(params.sessionId)
    return ctx.sessions.attach(params.sessionId)
  })

  router.register('session.stop', (params: SessionStopParams, ctx) => {
    ctx.sessions.stop(params.sessionId)
    return { ok: true as const }
  })
}
