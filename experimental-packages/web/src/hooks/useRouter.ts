import { useState, useEffect, useCallback } from 'react'

export interface Route {
  path: string
  params: Record<string, string>
}

export function useRouter(): Route {
  const parse = useCallback((): Route => {
    const pathname = window.location.pathname
    const projectMatch = pathname.match(/^\/project\/([^/]+)$/)
    if (projectMatch) {
      return { path: '/project/:id', params: { id: projectMatch[1] } }
    }
    const videoMatch = pathname.match(/^\/video\/(.+)$/)
    if (videoMatch) {
      return { path: '/video/:dir', params: { dir: decodeURIComponent(videoMatch[1]) } }
    }
    if (pathname === '/') {
      return { path: '/', params: {} }
    }
    return { path: '/', params: {} }
  }, [])

  const [route, setRoute] = useState<Route>(parse)

  useEffect(() => {
    const onPop = () => setRoute(parse())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [parse])

  return route
}

export function navigate(path: string): void {
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
