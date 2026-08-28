// Minimal reactive signal.

type Listener = () => void

export interface Signal<T> {
  get(): T
  set(value: T): void
  subscribe(fn: Listener): () => void
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const listeners = new Set<Listener>()
  return {
    get: () => value,
    set: (next: T) => {
      if (Object.is(value, next)) return
      value = next
      for (const fn of listeners) fn()
    },
    subscribe: (fn: Listener) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

export function derived<T>(deps: Array<Signal<unknown>>, compute: () => T): Signal<T> {
  const s = signal<T>(compute())
  for (const dep of deps) {
    dep.subscribe(() => s.set(compute()))
  }
  return s
}
