import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import type { SessionCreateParams, SessionAttachParams, SessionStopParams, SessionDeleteParams, SessionSendMessageParams, SessionConfirmPlanParams, SessionRejectPlanParams } from '@codekalakaars/vajra-protocol'
import { createProvider } from '../../agent/providers/index.js'

function getProjectId(params: unknown): string {
  const p = params as Record<string, unknown>
  return (p.projectId ?? p.sessionId) as string
}

export function registerSessionHandlers(router: RpcRouter<ServerContext>): void {
  router.register('projects.create', async (params: SessionCreateParams, ctx) => {
    const defaultModel = process.env.VAJRA_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free'
    const model = params.model?.trim() || defaultModel

    const { provider, resolvedModel } = createProvider(model, ctx.apiKeys)

    const withDefaultModel = {
      ...params,
      model: resolvedModel,
      provider,
    }
    const result = await ctx.projects.create(withDefaultModel, (projectId) => ctx.connection.subscribe(projectId))

    return result
  })

  router.register('projects.list', (_params: unknown, ctx) => ctx.projects.list())

  router.register('projects.attach', (params: SessionAttachParams, ctx) => {
    const projectId = getProjectId(params)
    ctx.connection.subscribe(projectId)
    return ctx.projects.attach(projectId, ctx.apiKeys)
  })

  router.register('projects.stop', (params: SessionStopParams, ctx) => {
    ctx.projects.stop(getProjectId(params))
    return { ok: true as const }
  })

  router.register('projects.delete', (params: SessionDeleteParams, ctx) => {
    ctx.projects.delete(getProjectId(params))
    return { ok: true as const }
  })

  router.register('projects.sendMessage', async (params: SessionSendMessageParams, ctx) => {
    if (Object.keys(ctx.apiKeys).length === 0) throw new Error('Server not configured with API keys')
    const projectId = getProjectId(params)
    await ctx.projects.sendMessage(projectId, params.content, ctx.apiKeys)
    return { ok: true as const }
  })

  router.register('projects.confirmPlan', async (params: SessionConfirmPlanParams, ctx) => {
    if (Object.keys(ctx.apiKeys).length === 0) throw new Error('Server not configured with API keys')
    await ctx.projects.confirmPlan(getProjectId(params), params.tasks, ctx.apiKeys)
    return { ok: true as const }
  })

  router.register('projects.rejectPlan', (params: SessionRejectPlanParams, ctx) => {
    ctx.projects.rejectPlan(getProjectId(params))
    return { ok: true as const }
  })

  router.register('projects.setModel', (params: { projectId: string; model: string }, ctx) => {
    const projectId = getProjectId(params)
    ctx.projects.setModel(projectId, params.model, ctx.apiKeys)
    return { ok: true as const }
  })
}
