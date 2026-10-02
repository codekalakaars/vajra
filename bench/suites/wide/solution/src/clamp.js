export function clamp(value, min, max) {
  if (min > max) throw new RangeError('clamp needs min at or below max')
  if (value < min) return min
  if (value > max) return max
  return value
}
