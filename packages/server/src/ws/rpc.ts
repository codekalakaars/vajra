import type { RpcRequest, RpcResponse } from '@vajra/protocol'

export type Handler<Ctx, P = unknown, R = unknown> = (params: P, ctx: Ctx) => Promise<R> | R

export class RpcRouter<Ctx> {
  private handlers = new Map<string, Handler<Ctx>>()

  register<P, R>(method: string, handler: Handler<Ctx, P, R>): void {
    if (this.handlers.has(method)) {
      throw new Error(`RPC method '${method}' is already registered`)
    }
    this.handlers.set(method, handler as Handler<Ctx>)
  }

  async dispatch(request: RpcRequest, ctx: Ctx): Promise<RpcResponse> {
    const handler = this.handlers.get(request.method)
    if (!handler) {
      return {
        kind: 'rpc-result',
        id: request.id,
        ok: false,
        error: { message: `Unknown method '${request.method}'`, code: 'UNKNOWN_METHOD' },
      }
    }

    try {
      const result = await handler(request.params, ctx)
      return { kind: 'rpc-result', id: request.id, ok: true, result }
    } catch (e) {
      return {
        kind: 'rpc-result',
        id: request.id,
        ok: false,
        error: { message: e instanceof Error ? e.message : String(e) },
      }
    }
  }
}
