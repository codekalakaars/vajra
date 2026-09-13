import { ConflictPayload } from '@codekalakaars/protocol'

interface ConflictAlertProps {
  conflicts: ConflictPayload[]
  onDismiss?: () => void
}

export function ConflictAlert({ conflicts, onDismiss }: ConflictAlertProps) {
  if (conflicts.length === 0) return null

  return (
    <div className="rounded-lg p-4" style={{ border: '1px solid #3b2020', background: '#3b2020' }}>
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-2">
          <span style={{ color: '#ef7772' }}>!</span>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: '#ffc0bc' }}>
              File Conflicts Detected
            </h3>
            <p className="mt-1 text-sm" style={{ color: '#ef7772' }}>
              {conflicts.length} conflict{conflicts.length > 1 ? 's' : ''} found. Tasks will be
              serialized to avoid simultaneous edits.
            </p>
          </div>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            style={{ color: '#ef7772' }}
          >
            <span className="sr-only">Dismiss</span>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      <div className="mt-3 space-y-2">
        {conflicts.map((conflict, i) => (
          <div key={i} className="text-xs" style={{ color: '#ef7772' }}>
            <span className="font-mono">{conflict.task1}</span>
            {' <-> '}
            <span className="font-mono">{conflict.task2}</span>
            {conflict.files.length > 0 && (
              <span className="ml-2" style={{ color: '#ef7772' }}>
                ({conflict.files.join(', ')})
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
