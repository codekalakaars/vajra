// A deliberately small XML reader, scoped to the JUnit subset.
//
// No XML dependency is taken here for two reasons. The core packages in this
// repo are dependency-free, and JUnit XML from the wild is structurally simple
// — elements, attributes, text, CDATA — even when it is inconsistent about
// which of those it emits.
//
// The parser is tolerant by design: a report that cannot be understood
// degrades to null rather than throwing, because a malformed third-party report
// must not take down verification. It is not a general XML implementation and
// makes no attempt to validate against the schema.

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body] ?? match
  })
}

export function parseXml(source: string): XmlNode | null {
  let i = 0

  const skipTo = (marker: string): boolean => {
    const at = source.indexOf(marker, i)
    if (at === -1) return false
    i = at + marker.length
    return true
  }

  const readName = (): string => {
    const start = i
    // `=` must terminate a name as well as whitespace, `>` and `/`, or an
    // attribute name swallows its own value.
    while (i < source.length && /[^\s/>=]/.test(source[i])) i += 1
    return source.slice(start, i)
  }

  const readQuoted = (): string => {
    const quote = source[i]
    i += 1
    const end = source.indexOf(quote, i)
    if (end === -1) {
      i = source.length
      return ''
    }
    const value = source.slice(i, end)
    i = end + 1
    return decodeEntities(value)
  }

  const readAttrs = (): Record<string, string> => {
    const attrs: Record<string, string> = {}
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i += 1
      if (i >= source.length) return attrs
      const c = source[i]
      if (c === '>' || c === '/' || c === '?') return attrs
      const name = readName()
      if (!name) {
        i += 1
        continue
      }
      while (i < source.length && /\s/.test(source[i])) i += 1
      if (source[i] === '=') {
        i += 1
        while (i < source.length && /\s/.test(source[i])) i += 1
        attrs[name] = source[i] === '"' || source[i] === "'" ? readQuoted() : ''
      } else {
        attrs[name] = ''
      }
    }
  }

  const parseElement = (): XmlNode | null => {
    if (!skipTo('<')) return null
    const name = readName()
    if (!name) return null
    const attrs = readAttrs()
    const node: XmlNode = { name, attrs, children: [], text: '' }
    if (source[i] === '/') {
      i = source.indexOf('>', i)
      if (i === -1) return null
      i += 1
      return node
    }
    if (!skipTo('>')) return null

    const parts: string[] = []
    for (;;) {
      if (i >= source.length) return node
      if (source.startsWith('<![CDATA[', i)) {
        const end = source.indexOf(']]>', i)
        if (end === -1) return node
        parts.push(source.slice(i + 9, end))
        i = end + 3
        continue
      }
      if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i)
        if (end === -1) return node
        i = end + 3
        continue
      }
      if (source.startsWith('<?', i) || source.startsWith('<!', i)) {
        const end = source.indexOf('>', i)
        if (end === -1) return node
        i = end + 1
        continue
      }
      if (source.startsWith('</', i)) {
        const end = source.indexOf('>', i)
        if (end === -1) return node
        i = end + 1
        break
      }
      if (source[i] === '<') {
        const child = parseElement()
        if (!child) break
        node.children.push(child)
        continue
      }
      const next = source.indexOf('<', i)
      if (next === -1) {
        parts.push(source.slice(i))
        i = source.length
        break
      }
      parts.push(source.slice(i, next))
      i = next
    }
    node.text = decodeEntities(parts.join('')).trim()
    return node
  }

  // Skip the prolog and any leading processing instructions or comments.
  while (i < source.length) {
    const at = source.indexOf('<', i)
    if (at === -1) return null
    const following = source.slice(at + 1, at + 9)
    if (following.startsWith('?') || following.startsWith('!')) {
      i = at + 1
      continue
    }
    break
  }
  return parseElement()
}

export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name || c.name.endsWith(`:${name}`))
}

export function firstNamed(node: XmlNode, name: string): XmlNode | undefined {
  return childrenNamed(node, name)[0]
}

/** Depth-first collection of every descendant with the given name. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = []
  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.name === name || child.name.endsWith(`:${name}`)) found.push(child)
      walk(child)
    }
  }
  walk(node)
  return found
}
