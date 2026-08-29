import { useState, useEffect, useCallback } from 'react'

export interface Route {
  path: string
  params: Record<string, string>
}

export function useHashRouter(): Route {
  const parse = useCallback((): Route => {
    const hash = window.location.hash.slice(1) || '/'
    // Match /session/:id
    const sessionMatch = hash.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      return { path: '/session/:id', params: { id: sessionMatch[1] } }
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
