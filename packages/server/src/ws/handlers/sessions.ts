import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import type { SessionCreateParams, SessionAttachParams, SessionStopParams, SessionDeleteParams, SessionSendMessageParams } from '@vajra/protocol'

export function registerSessionHandlers(router: RpcRouter<ServerContext>): void {
  router.register('session.create', async (params: SessionCreateParams, ctx) => {
    const defaultModel = process.env.VAJRA_MODEL || 'openrouter/free'
    const withDefaultModel = {
      ...params,
      model: params.model?.trim() || defaultModel,
    }
    const result = await ctx.sessions.create(withDefaultModel, (sessionId) => ctx.connection.subscribe(sessionId))

    // Start the agent loop in the background — the handler returns immediately
    // with the sessionId, and the loop runs concurrently, emitting push events
    // as it progresses. Skip if task is empty (user will send via sendMessage)
    // or if the launcher failed (status would be 'failed', no handle set).
    const status = ctx.sessions.getStatus(result.sessionId)
    if (ctx.apiKey && withDefaultModel.task && status === 'running') {
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

  router.register('session.delete', (params: SessionDeleteParams, ctx) => {
    ctx.sessions.delete(params.sessionId)
    return { ok: true as const }
  })

  router.register('session.sendMessage', async (params: SessionSendMessageParams, ctx) => {
    if (!ctx.apiKey) throw new Error('Server not configured with API key')
    await ctx.sessions.sendMessage(params.sessionId, params.content, ctx.apiKey)
    return { ok: true as const }
  })
}
