import type { RpcRouter } from '../rpc.js'
import type { ServerContext } from '../server.js'
import type { SessionCreateParams, SessionAttachParams, SessionStopParams, SessionDeleteParams, SessionSendMessageParams, SessionConfirmPlanParams, SessionRejectPlanParams } from '@codekalakaars/vajra-protocol'
import { createProvider } from '../../agent/providers/index.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParams = Record<string, any>
function getProjectId(params: unknown): string {
  const p = params as AnyParams
  return p.projectId ?? p.sessionId
}

export function registerProjectHandlers(router: RpcRouter<ServerContext>): void {
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

  router.register('projects.sendMessage', (params: SessionSendMessageParams, ctx) => {
    const apiKey = Object.values(ctx.apiKeys)[0]
    if (!apiKey) throw new Error('Server not configured with API keys')
    const projectId = getProjectId(params)
    ctx.projects.sendMessage(projectId, params.content, apiKey).catch((err) => {
      console.error(`Agent loop failed for project ${projectId}:`, err)
    })
    return { ok: true as const }
  })

  router.register('projects.confirmPlan', async (params: SessionConfirmPlanParams, ctx) => {
    const apiKey = Object.values(ctx.apiKeys)[0]
    if (!apiKey) throw new Error('Server not configured with API keys')
    await ctx.projects.confirmPlan(getProjectId(params), params.tasks, apiKey)
    return { ok: true as const }
  })

  router.register('projects.rejectPlan', (params: SessionRejectPlanParams, ctx) => {
    ctx.projects.rejectPlan(getProjectId(params))
    return { ok: true as const }
  })

  router.register('projects.setModel', (params: { projectId: string; model: string }, ctx) => {
    const projectId = getProjectId(params)
    ctx.projects.setModel(projectId, params.model)
    return { ok: true as const }
  })
}
