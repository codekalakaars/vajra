import { useMemo } from 'react'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'

const markedInstance = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext'
      return hljs.highlight(code, { language }).value
    }
  })
)

markedInstance.setOptions({ gfm: true })

function isCodeLine(trimmed: string): boolean {
  if (!trimmed) return false
  if (trimmed.startsWith('/*') || trimmed.startsWith('//') || trimmed.startsWith('#!')) return true
  if (/^[a-zA-Z_$][\w$]*\s*[\({]/.test(trimmed)) return true
  if (/^\}\s*$/.test(trimmed)) return true
  if (/:\s*[\{"\[\d]/.test(trimmed) && trimmed.endsWith(',')) return true
  if (/^[\w$]+\s*:\s*.+,$/.test(trimmed)) return true
  if (/^import\s/.test(trimmed) || /^export\s/.test(trimmed) || /^const\s/.test(trimmed) || /^let\s/.test(trimmed) || /^var\s/.test(trimmed) || /^function\s/.test(trimmed) || /^return\s/.test(trimmed)) return true
  if (/^\s*[{}();].*$/.test(trimmed) && !trimmed.match(/^[,.\s]*$/)) return true
  return false
}

function wrapRawCodeBlocks(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let codeBuf: string[] = []
  let inFence = false

  const flush = () => {
    if (codeBuf.length >= 2) {
      result.push('```', ...codeBuf, '```')
    } else {
      result.push(...codeBuf)
    }
    codeBuf = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    // Skip lines inside existing fenced code blocks
    if (trimmed.startsWith('```')) {
      flush()
      inFence = !inFence
      result.push(line)
      continue
    }

    if (inFence) {
      result.push(line)
      continue
    }

    if (isCodeLine(trimmed)) {
      codeBuf.push(line)
    } else {
      flush()
      result.push(line)
    }
  }
  flush()
  return result.join('\n')
}

export function MarkdownRenderer({ content }: { content: string }) {
  const html = useMemo(() => {
    const processed = wrapRawCodeBlocks(content)
    return markedInstance.parse(processed) as string
  }, [content])

  return (
    <div
      className="prose prose-invert prose-sm max-w-none text-gray-200 leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
