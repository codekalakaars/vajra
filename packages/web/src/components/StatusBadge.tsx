const STATUS_STYLES: Record<string, string> = {
  starting: 'bg-zinc-800 text-zinc-400 border-zinc-700',
  talking: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  confirming: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  planning: 'bg-zinc-800 text-zinc-300 border-zinc-700',
  executing: 'bg-white text-black border-white',
  running: 'bg-white text-black border-white',
  done: 'bg-zinc-700 text-zinc-300 border-zinc-600',
  failed: 'bg-zinc-800 text-zinc-500 border-zinc-700',
  stopped: 'bg-zinc-900 text-zinc-500 border-zinc-800',
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[status] || STATUS_STYLES.stopped}`}>
      {status}
    </span>
  )
}
