// Typed push event bus.

import type { PushEventPayloads, PushEventName } from '@codekalakaars/protocol'

export type EventMap = PushEventPayloads

export type EventName = PushEventName

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler<T> = (payload: T) => void

export class EventBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<string, Set<Handler<any>>>()

  on<E extends EventName>(event: E, handler: Handler<EventMap[E]>): () => void {
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
