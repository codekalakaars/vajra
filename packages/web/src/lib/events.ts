// Typed push event bus.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventMap = Record<string, any>

export type EventName = string

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler<T> = (payload: T) => void

export class EventBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<string, Set<Handler<any>>>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: Handler<any>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }

  emit(event: string, payload: unknown): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const handler of set) {
      handler(payload)
    }
  }
}
