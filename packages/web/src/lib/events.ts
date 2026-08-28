// Typed push event bus.

type EventMap = {
  'session.planUpdated': { sessionId: string; plan: Array<{ index: number; title: string; status: string }> }
  'session.assistantDelta': { sessionId: string; text: string }
  'session.toolCall': { sessionId: string; id: string; name: string; arguments: string }
  'session.toolResult': { sessionId: string; id: string; result: string; error?: string }
  'session.stepStatus': { sessionId: string; index: number; status: string }
  'session.sandboxStatus': { sessionId: string; enforced: boolean; warnings: string[] }
  'session.completed': { sessionId: string; summary: string }
  'session.failed': { sessionId: string; error: string }
}

export type EventName = keyof EventMap

type Handler<T> = (payload: T) => void

export class EventBus {
  private listeners = new Map<string, Set<Handler<unknown>>>()

  on<E extends EventName>(event: E, handler: Handler<EventMap[E]>): () => void {
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
