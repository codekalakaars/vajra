export function sum(values) {
  let total = 0
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('sum needs finite numbers')
    }
    total += value
  }
  return total
}
