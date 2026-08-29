// The WebSocket envelope. Every message either side sends fits one of these
// three shapes — there is no bare/untyped message anywhere in the protocol.

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

export interface PushEvent<E extends string = string, P = unknown> {
  kind: 'event'
  event: E
  sessionId?: string
  payload: P
}

export type ServerMessage = RpcResponse | PushEvent
export type ClientMessage = RpcRequest
