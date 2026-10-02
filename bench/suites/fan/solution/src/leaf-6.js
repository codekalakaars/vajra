export function groupBy(items, key) {
  const out = {}
  for (const item of items) {
    const bucket = item[key]
    if (out[bucket] === undefined) out[bucket] = []
    out[bucket].push(item)
  }
  return out
}
