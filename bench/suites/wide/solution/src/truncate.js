export function truncate(text, limit) {
  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new TypeError('truncate needs an integer limit')
  }
  if (limit < 1) throw new RangeError('truncate needs a limit of at least 1')
  if (text.length <= limit) return text
  return text.slice(0, limit - 1) + '\u2026'
}
