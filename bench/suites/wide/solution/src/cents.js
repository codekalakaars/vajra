export function formatCents(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) {
    throw new TypeError('formatCents needs a finite number of cents')
  }
  const negative = cents < 0
  const absolute = Math.abs(cents)
  const dollars = group(Math.floor(absolute / 100))
  const rest = String(absolute % 100).padStart(2, '0')
  return (negative ? '-' : '') + '$' + dollars + '.' + rest
}

/** Commas every three digits, counted from the right. */
function group(digits) {
  const text = String(digits)
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (i > 0 && (text.length - i) % 3 === 0) out += ','
    out += text[i]
  }
  return out
}
