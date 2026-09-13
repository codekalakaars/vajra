import { useState, useEffect, useCallback } from 'react'

export interface Route {
  path: string
  params: Record<string, string>
}

export function useHashRouter(): Route {
  const parse = useCallback((): Route => {
    const hash = window.location.hash.slice(1) || '/'
    // Match /project/:id
    const projectMatch = hash.match(/^\/project\/([^/]+)$/)
    if (projectMatch) {
      return { path: '/project/:id', params: { id: projectMatch[1] } }
    }
    // Match /
    if (hash === '/') {
      return { path: '/', params: {} }
    }
    // Default to home
    return { path: '/', params: {} }
  }, [])

  const [route, setRoute] = useState<Route>(parse)

  useEffect(() => {
    const onHash = () => setRoute(parse())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [parse])

  return route
}

export function navigate(path: string): void {
  window.location.hash = path
}
