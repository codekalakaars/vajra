import { ConflictPayload } from '@vajra/protocol'

interface ConflictAlertProps {
  conflicts: ConflictPayload[]
  onDismiss?: () => void
}

export function ConflictAlert({ conflicts, onDismiss }: ConflictAlertProps) {
  if (conflicts.length === 0) return null

  return (
    <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-800 dark:bg-yellow-900/20">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-2">
          <span className="text-yellow-600 dark:text-yellow-400">!</span>
          <div>
            <h3 className="text-sm font-semibold text-yellow-800 dark:text-yellow-200">
              File Conflicts Detected
            </h3>
            <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-300">
              {conflicts.length} conflict{conflicts.length > 1 ? 's' : ''} found. Tasks will be
              serialized to avoid simultaneous edits.
            </p>
          </div>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-yellow-600 hover:text-yellow-800 dark:text-yellow-400 dark:hover:text-yellow-200"
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
          <div key={i} className="text-xs text-yellow-700 dark:text-yellow-300">
            <span className="font-mono">{conflict.task1}</span>
            {' <-> '}
            <span className="font-mono">{conflict.task2}</span>
            {conflict.files.length > 0 && (
              <span className="ml-2 text-yellow-600 dark:text-yellow-400">
                ({conflict.files.join(', ')})
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
