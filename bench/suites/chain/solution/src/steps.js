export function splitWords(text) {
  if (typeof text !== 'string') throw new TypeError('splitWords needs a string')
  return text.split(/\s+/).filter(word => word.length > 0)
}

export function joinWords(words) {
  return words
    .map(word => word.trim())
    .filter(word => word.length > 0)
    .join(' ')
}

export function topWords(counts, limit) {
  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new TypeError('topWords needs an integer limit')
  }
  if (limit < 1) throw new RangeError('topWords needs a limit of at least 1')
  const pairs = []
  for (const [word, count] of Object.entries(counts)) {
    if (pairs.some(([seen]) => seen === word)) continue
    pairs.push([word, count])
  }
  // A stable sort leaves words with equal counts in first-appearance order.
  pairs.sort((a, b) => b[1] - a[1])
  return pairs.slice(0, limit)
}

export function reportLine(text, limit) {
  const counts = {}
  for (const word of splitWords(text)) counts[word] = (counts[word] ?? 0) + 1
  return topWords(counts, limit)
    .map(([word, count]) => word + ':' + count)
    .join(', ')
}
