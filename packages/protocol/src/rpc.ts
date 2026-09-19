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

import type { PushEventPayloads, PushEventName } from './messages.js'

export interface PushEvent<E extends PushEventName = PushEventName, P = PushEventPayloads[E]> {
  kind: 'event'
  event: E
  sessionId?: string
  payload: P
}

export type ServerMessage = RpcResponse | PushEvent
export type ClientMessage = RpcRequest
