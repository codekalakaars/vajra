export function discount(amount, pct) {
  return Math.max(0, Math.round(amount * (1 - pct / 100) * 100) / 100)
}
