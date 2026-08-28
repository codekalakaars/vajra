// Hash-based router.

type RouteHandler = (params: Record<string, string>) => void
type Cleanup = () => void

export class Router {
  private routes: Array<{ pattern: RegExp; paramNames: string[]; handler: RouteHandler }> = []
  private cleanup: Cleanup | null = null

  on(pattern: string, handler: RouteHandler): void {
    const paramNames: string[] = []
    const regexStr = pattern.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name)
      return '([^/]+)'
    })
    this.routes.push({ pattern: new RegExp(`^${regexStr}$`), paramNames, handler })
  }

  start(): void {
    const onHash = () => this.resolve()
    window.addEventListener('hashchange', onHash)
    this.cleanup = () => window.removeEventListener('hashchange', onHash)
    this.resolve()
  }

  stop(): void {
    this.cleanup?.()
    this.cleanup = null
  }

  navigate(path: string): void {
    window.location.hash = path
  }

  private resolve(): void {
    const hash = window.location.hash.slice(1) || '/scan'
    for (const route of this.routes) {
      const match = hash.match(route.pattern)
      if (match) {
        const params: Record<string, string> = {}
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1])
        })
        route.handler(params)
        return
      }
    }
    // Default: navigate to scan
    window.location.hash = '#/scan'
  }
}

export function h(tag: string, attrs?: Record<string, string>, ...children: Array<string | HTMLElement | null>): HTMLElement {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (key === 'className') el.className = val
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), val as EventListener)
      else el.setAttribute(key, val)
    }
  }
  for (const child of children) {
    if (child == null) continue
    if (typeof child === 'string') el.appendChild(document.createTextNode(child))
    else el.appendChild(child)
  }
  return el
}
