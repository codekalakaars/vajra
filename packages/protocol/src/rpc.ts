export interface RpcRequest<M extends string = string, P = unknown> {
  kind: 'rpc'
  id: string
  method: M
  params: P
}

export interface RpcSuccess<R = unknown> {
  kind: 'rpc-result'
  id: string
  ok: true
  result: R
}

export interface RpcFailure {
  kind: 'rpc-result'
  id: string
  ok: false
  error: { message: string; code?: string }
}

export type RpcResponse<R = unknown> = RpcSuccess<R> | RpcFailure

import type {
  PushEventPayloads,
  PushEventName,
  PermissionsConfig,
  ProjectFileEntry,
  SessionCreateParams,
  SessionCreateResult,
  SessionListResult,
  SessionAttachParams,
  SessionAttachResult,
  SessionStopParams,
  SessionStopResult,
  SessionDeleteParams,
  SessionDeleteResult,
  SessionSendMessageParams,
  SessionSendMessageResult,
  SessionConfirmPlanParams,
  SessionConfirmPlanResult,
  SessionRejectPlanParams,
  SessionRejectPlanResult,
} from './messages.js'

export interface PushEvent<E extends PushEventName = PushEventName, P = PushEventPayloads[E]> {
  kind: 'event'
  event: E
  sessionId?: string
  payload: P
}

export type ServerMessage = RpcResponse | PushEvent
export type ClientMessage = RpcRequest

/**
 * Single source of truth for RPC method names and their params/result shapes.
 * Server RpcRouter.register and web RpcClient.call must both type against this.
 * Contract: experimental server/web adopt this map (Group M).
 */
export interface RpcMethods {
  'project.loadPermissions': { params: { projectDir: string }; result: PermissionsConfig }
  'project.savePermissions': { params: { projectDir: string; config: PermissionsConfig }; result: { ok: true } }
  'project.scan': { params: { projectDir: string }; result: ProjectFileEntry[] }
  'project.browse': { params: { dir: string }; result: Array<{ name: string; path: string; isDir: boolean }> }
  'projects.list': { params: Record<string, never>; result: SessionListResult }
  'projects.create': { params: SessionCreateParams; result: SessionCreateResult }
  'projects.attach': { params: SessionAttachParams; result: SessionAttachResult }
  'projects.stop': { params: SessionStopParams; result: SessionStopResult }
  'projects.delete': { params: SessionDeleteParams; result: SessionDeleteResult }
  'projects.sendMessage': { params: SessionSendMessageParams; result: SessionSendMessageResult }
  'projects.confirmPlan': { params: SessionConfirmPlanParams; result: SessionConfirmPlanResult }
  'projects.rejectPlan': { params: SessionRejectPlanParams; result: SessionRejectPlanResult }
  'projects.setModel': { params: { projectId: string; model: string }; result: { ok: true } }
}

export type RpcMethodName = keyof RpcMethods
export type RpcMethodParams<M extends RpcMethodName> = RpcMethods[M]['params']
export type RpcMethodResult<M extends RpcMethodName> = RpcMethods[M]['result']
