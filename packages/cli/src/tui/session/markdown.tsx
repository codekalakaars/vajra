import React from 'react'
import { Box, Text } from 'ink'

/**
 * Markdown for the TUI, rendered with Ink's own primitives.
 *
 * The plain-CLI path sends text through `renderMarkdown`, which emits ANSI
 * escape sequences for the terminal to interpret. Ink does not parse those: it
 * emits the string as-is and counts the escape bytes when it measures width, so
 * every styled line wraps and pads wrongly. Rendering the same structure with
 * `<Text bold>` / `<Text color>` instead keeps Ink's measurement honest, which
 * is what makes the formatting usable rather than decorative.
 *
 * Streaming-safe by construction: an unterminated fence, an unfinished `**` or a
 * half-typed list item all render as the literal text the model has emitted so
 * far, and re-parse correctly as the rest arrives.
 */

interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  /** Rendered dim with the target appended, so a link is still usable. */
  href?: string
}

type Block =
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'list'; ordered: boolean; items: { depth: number; spans: Span[] }[] }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'rule' }
  | { kind: 'paragraph'; spans: Span[] }

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+)\*|_([^_\n]+)_|~~([\s\S]+?)~~|\[([^\]]*)\]\(([^)\s]+)\)/

/** Split a line into styled spans. Unmatched markers stay literal. */
function parseSpans(source: string): Span[] {
  const spans: Span[] = []
  let rest = source
  while (rest.length > 0) {
    const match = INLINE.exec(rest)
    if (!match || match.index === undefined) {
      spans.push({ text: rest })
      break
    }
    if (match.index > 0) spans.push({ text: rest.slice(0, match.index) })

    if (match[2] !== undefined) {
      spans.push({ text: match[2], code: true })
    } else if (match[3] !== undefined || match[4] !== undefined) {
      spans.push({ text: (match[3] ?? match[4]) as string, bold: true })
    } else if (match[5] !== undefined || match[6] !== undefined) {
      spans.push({ text: (match[5] ?? match[6]) as string, italic: true })
    } else if (match[7] !== undefined) {
      spans.push({ text: match[7], strike: true })
    } else if (match[8] !== undefined) {
      const href = match[9]
      spans.push({ text: href === match[8] ? (match[8] as string) : `${match[8]} (${href})`, href })
    }
    rest = rest.slice(match.index + match[0].length)
  }
  return spans.length > 0 ? spans : [{ text: '' }]
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let index = 0

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', spans: parseSpans(paragraph.join(' ').trim()) })
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index]

    // Fenced code — an unterminated fence still renders as code, which is what
    // a half-streamed block should look like.
    const fence = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9+#-]*)\s*$/.exec(line)
    if (fence) {
      flushParagraph()
      const marker = fence[1]
      const lang = fence[2]
      const body: string[] = []
      index++
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        body.push(lines[index])
        index++
      }
      index++ // consume the closing fence, or run off the end mid-stream
      blocks.push({ kind: 'code', lang, lines: body })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: heading[1].length, spans: parseSpans(heading[2].trim()) })
      index++
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'rule' })
      index++
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flushParagraph()
      const body: string[] = [quote[1]]
      index++
      while (index < lines.length) {
        const next = /^\s*>\s?(.*)$/.exec(lines[index])
        if (!next) break
        body.push(next[1])
        index++
      }
      blocks.push({ kind: 'quote', spans: parseSpans(body.join(' ').trim()) })
      continue
    }

    const bullet = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      const depth = Math.floor(bullet[1].replace(/\t/g, '  ').length / 2)
      const items: { depth: number; spans: Span[] }[] = []
      while (index < lines.length) {
        const item = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[index])
        if (!item) break
        const indent = Math.floor(item[1].replace(/\t/g, '  ').length / 2)
        items.push({ depth: indent, spans: parseSpans(item[4]) })
        index++
      }
      blocks.push({ kind: 'list', ordered: bullet[3] !== undefined, items })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      index++
      continue
    }

    paragraph.push(line.trim())
    index++
  }

  flushParagraph()
  return blocks
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, i) => (
        <Text
          key={i}
          bold={span.bold}
          italic={span.italic}
          strikethrough={span.strike}
          color={span.code ? 'yellow' : span.href ? 'blue' : undefined}
          dimColor={span.href ? false : undefined}
        >
          {span.text}
        </Text>
      ))}
    </>
  )
}

/**
 * Rendered as one <Text> tree rather than a <Box> per block.
 *
 * A box-per-block version measured 85ms per frame on a 5.7KB answer — over the
 * 20fps budget, so long answers would have stuttered exactly as before. Ink's
 * cost is per node, so spacing is expressed as newlines inside a single text run
 * and inline styling as nested <Text>, which keeps the node count flat no matter
 * how long the answer is.
 */
export function Markdown({ text, dimColor }: { text: string; dimColor?: boolean }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text])

  return (
    <Text dimColor={dimColor}>
      {blocks.map((block, i) => {
        const gap = i === 0 ? '' : '\n\n'
        switch (block.kind) {
          case 'code':
            return (
              <React.Fragment key={i}>
                {gap}
                {block.lang !== '' && <Text dimColor>{block.lang}</Text>}
                <Text dimColor>
                  {'\n│ '}
                  {block.lines.join('\n│ ')}
                </Text>
              </React.Fragment>
            )
          case 'heading':
            return (
              <React.Fragment key={i}>
                {gap}
                <Text bold color={block.level <= 2 ? 'cyan' : 'green'}>
                  <Spans spans={block.spans} />
                </Text>
              </React.Fragment>
            )
          case 'list':
            return (
              <React.Fragment key={i}>
                {gap}
                {block.items.map((item, j) => (
                  <React.Fragment key={j}>
                    {j > 0 ? '\n' : ''}
                    {'  '.repeat(item.depth + 1)}
                    <Text color="cyan">
                      {block.ordered ? `${j + 1}.` : '•'} {item.depth > 0 ? ' ' : ''}
                    </Text>
                    <Spans spans={item.spans} />
                  </React.Fragment>
                ))}
              </React.Fragment>
            )
          case 'quote':
            return (
              <React.Fragment key={i}>
                {gap}
                <Text color="gray">│ </Text>
                <Text italic dimColor>
                  <Spans spans={block.spans} />
                </Text>
              </React.Fragment>
            )
          case 'rule':
            return (
              <React.Fragment key={i}>
                {gap}
                <Text dimColor>────────</Text>
              </React.Fragment>
            )
          case 'paragraph':
            return (
              <React.Fragment key={i}>
                {gap}
                <Spans spans={block.spans} />
              </React.Fragment>
            )
        }
      })}
    </Text>
  )
}

/** Exported for tests: the block structure a given markdown produces. */
export const __parseBlocks = parseBlocks
export const __parseSpans = parseSpans
