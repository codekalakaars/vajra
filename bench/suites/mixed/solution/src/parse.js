export function tokenize(text) {
  if (typeof text !== 'string') throw new TypeError('tokenize needs a string')
  return text.split(/\s+/).filter(token => token.length > 0)
}

export function extract(tokens, name) {
  const prefix = name + '='
  for (const token of tokens) {
    if (token.startsWith(prefix)) return token.slice(prefix.length)
  }
  return null
}

export function parseAll(text) {
  const fields = {}
  for (const token of tokenize(text)) {
    const at = token.indexOf('=')
    if (at < 1) continue
    fields[token.slice(0, at)] = token.slice(at + 1)
  }
  return fields
}
