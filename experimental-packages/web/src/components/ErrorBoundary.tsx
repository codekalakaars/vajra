import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0a0a0a',
            color: '#e5e5e5',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ textAlign: 'center', maxWidth: 480, padding: 32 }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: 14, color: '#a3a3a3', marginBottom: 24 }}>
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 16px',
                background: '#262626',
                border: '1px solid #404040',
                borderRadius: 6,
                color: '#e5e5e5',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
