export function taxRate(kind) {
  if (kind === 'standard') return 0.2
  if (kind === 'reduced') return 0.05
  return 0
}
