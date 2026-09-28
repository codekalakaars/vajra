/**
 * OpenCode's default theme, resolved from `theme/assets/opencode.json` in
 * anomalyco/opencode — the same file, the same `defs` lookups, the same values.
 *
 * It lives in its own module because three things need it: the prompt, the
 * sidebar, and the syntax palette, and the last one takes the whole object
 * rather than a handful of fields. OpenCode resolves themes at runtime from a
 * user config; we take the shipped default, because a theme picker is a feature
 * nobody asked for yet and the default is what "the same interface" means.
 */
export const theme = {
  primary: '#fab283',
  secondary: '#5c9cf5',
  accent: '#9d7cd8',
  error: '#e06c75',
  warning: '#f5a742',
  success: '#7fd88f',
  info: '#56b6c2',
  text: '#eeeeee',
  textMuted: '#808080',
  background: '#0a0a0a',
  backgroundPanel: '#141414',
  backgroundElement: '#1e1e1e',
  border: '#484848',
  borderActive: '#606060',
  borderSubtle: '#2e2e2e',
  diffAdded: '#4fd6be',
  diffRemoved: '#c53b53',
  diffContext: '#828bb8',
  diffAddedBg: '#20303b',
  diffRemovedBg: '#37222c',
  diffContextBg: '#141414',
  diffLineNumber: '#8f8f8f',
  diffAddedLineNumberBg: '#1b2b34',
  diffRemovedLineNumberBg: '#2d1f26',
  markdownText: '#eeeeee',
  markdownHeading: '#9d7cd8',
  markdownLink: '#fab283',
  markdownLinkText: '#56b6c2',
  markdownCode: '#7fd88f',
  markdownBlockQuote: '#e5c07b',
  markdownEmph: '#e5c07b',
  markdownStrong: '#f5a742',
  markdownHorizontalRule: '#808080',
  markdownListItem: '#fab283',
  markdownListEnumeration: '#56b6c2',
  markdownImage: '#fab283',
  markdownImageText: '#56b6c2',
  markdownCodeBlock: '#eeeeee',
  syntaxComment: '#808080',
  syntaxKeyword: '#9d7cd8',
  syntaxFunction: '#fab283',
  syntaxVariable: '#e06c75',
  syntaxString: '#7fd88f',
  syntaxNumber: '#f5a742',
  syntaxType: '#e5c07b',
  syntaxOperator: '#56b6c2',
  syntaxPunctuation: '#eeeeee',
  /**
   * The row the cursor is on: the theme's blue.
   *
   * One list, two colours, and the cursor has to be findable at a glance in a
   * panel of eight similar lines — which is the whole job of a selection colour.
   * `secondary` is the theme's blue; it is named here so the list's two colours
   * sit next to each other and a change to either is one edit.
   */
  listSelected: '#5c9cf5',
  /**
   * A row the cursor is not on.
   *
   * Light gray, not the theme's `textMuted` — that is the gray of things that
   * are switched off, and every command and every model in these lists is
   * available. Not cyan either: a second saturated colour beside the cursor
   * competes with it, and the cursor is the only thing in the panel that is
   * telling you something.
   */
  listOption: '#b4b4b4',
  /**
   * How solid thinking text is. OpenCode's default, and the reason a reasoning
   * block never competes with the answer that follows it.
   */
  thinkingOpacity: 0.6,
} as const

export type Theme = typeof theme

/** `zen/space-bunny-free` → provider `zen`, model `space-bunny-free`. */
export function providerOf(model: string): string {
  const slash = model.indexOf('/')
  return slash === -1 ? '' : model.slice(0, slash)
}

export function bareModel(model: string): string {
  const slash = model.indexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}

export function titlecase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
