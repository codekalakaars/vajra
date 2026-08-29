// Typed push event bus.

export type EventMap = {
  'session.assistantDelta': { sessionId: string; text: string }
  'session.thinkingDelta': { sessionId: string; text: string }
  'session.sandboxStatus': { sessionId: string; enforced: boolean; warnings: string[] }
  'session.completed': { sessionId: string }
  'session.failed': { sessionId: string; error: string }
  'session.deleted': { sessionId: string }
}

export type EventName = keyof EventMap

type Handler<T> = (payload: T) => void

export class EventBus {
  private listeners = new Map<string, Set<Handler<unknown>>>()

  on<E extends EventName>(event: E, handler: Handler<unknown>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler as Handler<unknown>)
    return () => set!.delete(handler as Handler<unknown>)
  }

  emit(event: string, payload: unknown): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const handler of set) {
      handler(payload)
    }
  }
}
