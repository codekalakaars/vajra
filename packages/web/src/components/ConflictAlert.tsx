import { ConflictPayload } from '@codekalakaars/protocol'
import { AlertTriangle, X } from 'lucide-react'

interface ConflictAlertProps { conflicts: ConflictPayload[]; onDismiss?: () => void }

export function ConflictAlert({ conflicts, onDismiss }: ConflictAlertProps) {
  if (conflicts.length === 0) return null
  return (
    <div className="rounded-lg p-4" style={{ border: '1px solid #333333', background: '#1a1a1a' }}>
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} style={{ color: '#737373' }} />
          <div>
            <h3 className="text-sm font-semibold" style={{ color: '#e5e5e5' }}>File Conflicts Detected</h3>
            <p className="mt-1 text-sm" style={{ color: '#737373' }}>
              {conflicts.length} conflict{conflicts.length > 1 ? 's' : ''} found. Tasks will be serialized to avoid simultaneous edits.
            </p>
          </div>
        </div>
        {onDismiss && (
          <button onClick={onDismiss} style={{ color: '#737373' }}>
            <span className="sr-only">Dismiss</span>
            <X size={16} />
          </button>
        )}
      </div>
      <div className="mt-3 space-y-2">
        {conflicts.map((conflict, i) => (
          <div key={i} className="text-xs" style={{ color: '#737373' }}>
            <span className="font-mono">{conflict.task1}</span> {' <-> '} <span className="font-mono">{conflict.task2}</span>
            {conflict.files.length > 0 && <span className="ml-2">({conflict.files.join(', ')})</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
