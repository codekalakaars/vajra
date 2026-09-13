import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import type { SessionCreateParams, SessionAttachParams, SessionStopParams, SessionDeleteParams, SessionSendMessageParams, SessionConfirmPlanParams, SessionRejectPlanParams } from '@codekalakaars/vajra-protocol'
import { createProvider } from '../../agent/providers/index.js'

export function registerSessionHandlers(router: RpcRouter<ServerContext>): void {
  router.register('session.create', async (params: SessionCreateParams, ctx) => {
    const defaultModel = process.env.VAJRA_MODEL || 'openrouter/free'
    const model = params.model?.trim() || defaultModel

    // Create provider from model string
    const { provider, resolvedModel } = createProvider(model, ctx.apiKeys)

    const withDefaultModel = {
      ...params,
      model: resolvedModel,
      provider,
    }
    const result = await ctx.sessions.create(withDefaultModel, (sessionId) => ctx.connection.subscribe(sessionId))

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

  router.register('session.sendMessage', (params: SessionSendMessageParams, ctx) => {
    const apiKey = Object.values(ctx.apiKeys)[0]
    if (!apiKey) throw new Error('Server not configured with API keys')
    // Fire-and-forget: the agent loop runs in the background, emitting push
    // events as it progresses. The RPC returns immediately so the client
    // doesn't time out while the LLM is working.
    ctx.sessions.sendMessage(params.sessionId, params.content, apiKey).catch((err) => {
      console.error(`Agent loop failed for session ${params.sessionId}:`, err)
    })
    return { ok: true as const }
  })

  router.register('session.confirmPlan', async (params: SessionConfirmPlanParams, ctx) => {
    const apiKey = Object.values(ctx.apiKeys)[0]
    if (!apiKey) throw new Error('Server not configured with API keys')
    await ctx.sessions.confirmPlan(params.sessionId, params.tasks, apiKey)
    return { ok: true as const }
  })

  router.register('session.rejectPlan', (params: SessionRejectPlanParams, ctx) => {
    ctx.sessions.rejectPlan(params.sessionId)
    return { ok: true as const }
  })
}
