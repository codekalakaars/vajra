export function chunk(items, size) {
  if (typeof size !== 'number' || !Number.isInteger(size)) {
    throw new TypeError('chunk needs an integer size')
  }
  if (size < 1) throw new RangeError('chunk needs a size of at least 1')
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
