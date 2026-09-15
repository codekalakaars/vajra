const STATUS_STYLES: Record<string, string> = {
  starting: 'border-zinc-800',
  talking: 'border-zinc-700',
  confirming: 'border-zinc-700',
  planning: 'border-zinc-700',
  executing: 'border-zinc-600',
  running: 'border-zinc-600',
  done: 'border-zinc-800',
  failed: 'border-zinc-800',
  stopped: 'border-zinc-900',
}

const STATUS_LABELS: Record<string, string> = {
  starting: 'Starting',
  talking: 'Thinking',
  confirming: 'Reviewing Plan',
  planning: 'Planning',
  executing: 'Executing',
  running: 'Running',
  done: 'Complete',
  failed: 'Error',
  stopped: 'Stopped',
}

export function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABELS[status] || status
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[status] || STATUS_STYLES.stopped}`}
      style={{ background: '#1a1a1a', color: '#737373' }}
    >
      {label}
    </span>
  )
}
