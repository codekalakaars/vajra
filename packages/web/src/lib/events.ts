// Typed push event bus.

export type EventMap = {
  'session.statusChanged': { sessionId: string; status: string }
  'session.assistantDelta': { sessionId: string; text: string }
  'session.thinkingDelta': { sessionId: string; text: string }
  'session.planStarted': { sessionId: string }
  'session.planTask': { sessionId: string; task: string; index: number; total: number }
  'session.planComplete': { sessionId: string; tasks: string[] }
  'session.planProposed': { sessionId: string; tasks: string[] }
  'session.planConfirmed': { sessionId: string; tasks: string[] }
  'session.workerStarted': { sessionId: string; workerId: string; task: string }
  'session.workerCompleted': { sessionId: string; workerId: string; result: string }
  'session.workerFailed': { sessionId: string; workerId: string; error: string }
  'session.conflictDetected': { sessionId: string; message: string }
  'session.completed': { sessionId: string }
  'session.failed': { sessionId: string; message: string }
  'session.deleted': { sessionId: string }
  'session.sandboxStatus': { sessionId: string; enforced: boolean; warnings: string[] }
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
