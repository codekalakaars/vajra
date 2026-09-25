declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked'

  export interface MarkedTerminalOptions {
    code?: (code: string, lang?: string) => string
    blockquote?: (text: string) => string
    html?: (html: string) => string
    heading?: (text: string, depth: number) => string
    firstHeading?: (text: string, depth: number) => string
    hr?: () => string
    listitem?: (text: string, task: boolean, checked: boolean) => string
    list?: (body: string, ordered: boolean) => string
    table?: (header: string, body: string) => string
    paragraph?: (text: string) => string
    strong?: (text: string) => string
    em?: (text: string) => string
    codespan?: (code: string) => string
    del?: (text: string) => string
    link?: (href: string, title: string, text: string) => string
    href?: (href: string, title: string, text: string) => string
    text?: (text: string) => string
    unescape?: boolean
    emoji?: boolean
    width?: number
    showSectionPrefix?: boolean
    reflowText?: boolean
    tab?: number
    tableOptions?: Record<string, unknown>
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension
}
