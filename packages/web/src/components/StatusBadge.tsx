const STATUS_STYLES: Record<string, string> = {
  starting: 'border-zinc-700',
  talking: 'border-zinc-600',
  confirming: 'border-zinc-600',
  planning: 'border-zinc-600',
  executing: 'border-zinc-500',
  running: 'border-zinc-500',
  done: 'border-zinc-700',
  failed: 'border-zinc-700',
  stopped: 'border-zinc-800',
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[status] || STATUS_STYLES.stopped}`}
      style={{ background: '#292927', color: '#a5a39a' }}
    >
      {status}
    </span>
  )
}
