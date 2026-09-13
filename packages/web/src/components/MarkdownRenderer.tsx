import { useMemo } from 'react'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js/lib/core'

// Register only commonly used languages
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import sql from 'highlight.js/lib/languages/sql'
import markdown from 'highlight.js/lib/languages/markdown'
import dockerfile from 'highlight.js/lib/languages/dockerfile'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('dockerfile', dockerfile)

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

// Simple HTML sanitizer — removes dangerous tags and attributes
function sanitize(html: string): string {
  return html
    // Remove script, iframe, object, embed, form tags
    .replace(/<(script|iframe|object|embed|form|input|textarea|button|select)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|iframe|object|embed|form|input|textarea|button|select)[^>]*\/?>/gi, '')
    // Remove on* event handlers
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s+on\w+\s*=\s*\S+/gi, '')
    // Remove javascript: URLs
    .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"')
    .replace(/src\s*=\s*["']javascript:[^"']*["']/gi, 'src=""')
    // Remove data: URLs except images
    .replace(/src\s*=\s*["']data:(?!image\/)[^"']*["']/gi, 'src=""')
}

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
    const raw = markedInstance.parse(processed) as string
    return sanitize(raw)
  }, [content])

  return (
    <div
      className="prose prose-invert prose-sm max-w-none text-zinc-300 leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
