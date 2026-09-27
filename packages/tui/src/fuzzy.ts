/**
 * Fuzzy search over a list the user is choosing from.
 *
 * The model list is seventy-five rows long and grows every month, and a picker
 * that can only be walked with the arrow key is a picker you scroll through
 * looking for one name. So typing narrows it, and the narrowing has to put the
 * thing you meant *first* — a matcher that keeps every subsequence match in
 * catalog order is barely better than no matcher at all, because "gpt5" and
 * "gpt-5.4-pro" and "glm-5" all match and the one you wanted is wherever the
 * gateway happened to list it.
 *
 * The scoring is therefore about *order of evidence*, cheapest first:
 *
 *  - the query must appear in order, as a subsequence, *anchored to a word* — a
 *    run of consecutive characters that starts the text or starts a word after
 *    a separator. This is the rule that makes "gpt5" find "gpt-5.4" (the
 *    punctuation an id is full of is not something a user types) while
 *    "opus" does not find "go/qwen3.6-plus", where the o is in "go" and the
 *    "pus" is in "plus" and nothing about that is a match;
 *  - a match at the start of the text beats one in the middle, because that is
 *    the difference between typing a prefix and typing a fragment;
 *  - consecutive characters beat scattered ones, so "cl5" prefers
 *    "claude-4.5" over "c-l-a-u-d-e-4-5";
 *  - a match that starts a word beats one inside a word, so "glm" prefers
 *    "glm-5.3" over "xglm-5.3";
 *  - and a shorter text beats a longer one at equal evidence, so an exact id
 *    outranks a longer id that contains it.
 *
 * No dependency, no index, no precomputation: the lists are at most a few
 * hundred rows and a keystroke is one pass over them.
 */

/** What one candidate scored, and where the query's characters landed. */
export interface FuzzyMatch {
  score: number
  /** Index in the text of each query character, for highlighting. */
  indices: number[]
}

/** A match that did not happen. The score is meaningless; `indices` is empty. */
const NO_MATCH: FuzzyMatch = { score: Number.NEGATIVE_INFINITY, indices: [] }

/** Characters that begin a word, and so earn a word-start bonus. */
const SEPARATORS = new Set([' ', '/', '-', '_', '.', ':', '+'])

/**
 * Consecutiveness is the strongest evidence, and it is weighted to beat the
 * whole of the rest: a hyphenated id where every letter is its own word
 * (`o-p-u-s`) scores well on word starts and is still worse than the same
 * letters sitting together in the middle of a longer id (`claude-opus-4-5`),
 * because that is the match the user meant.
 */
const SCORE_FIRST_CHAR = 20
const SCORE_CONSECUTIVE = 30
const SCORE_WORD_START = 8
const SCORE_FIRST_OF_TEXT = 20
/** Charged per character of text the query skipped, so sparse matches sink. */
const PENALTY_PER_GAP = 6

/**
 * The local evidence for putting one query character at one text position.
 *
 * `continues` is true when this character continues the previous one, which is
 * the strongest signal there is; `atWordStart` is what makes a match anchored
 * rather than coincidental.
 */
interface Placement {
  score: number
  continues: boolean
  atWordStart: boolean
}

function placementAt(haystack: string, pos: number, previous: number, first: boolean): Placement {
  const continues = previous !== -1 && pos === previous + 1
  const atWordStart = pos === 0 || SEPARATORS.has(haystack[pos - 1]!)
  let score = 0
  if (pos === 0) score += SCORE_FIRST_OF_TEXT
  if (continues) score += SCORE_CONSECUTIVE
  else if (first && pos === 0) score += SCORE_FIRST_CHAR
  else if (previous !== -1) score -= PENALTY_PER_GAP * (pos - previous - 1)
  if (atWordStart && pos > 0) score += SCORE_WORD_START
  return { score, continues, atWordStart }
}

/**
 * The best anchored alignment of `needle` in `haystack`, or null.
 *
 * A greedy left-to-right scan is not good enough, and the case that proves it
 * is the one a model picker meets on the first letter: the `s` of "spark" is
 * inside "muse", so a greedy scan takes it, cannot anchor anything afterwards,
 * and reports no match for a name that is right there in the id. So the scan
 * tries every position the first character could take and keeps the best — a
 * dynamic program over (character, position), which is a few hundred states for
 * a model id and a keystroke's worth of work.
 *
 * Two values per state: the best score from here *given that an anchor still
 * has to happen* (`need`), and the best score from here when one already has
 * (`have`). A match is only accepted through `need`, which is what keeps
 * scattered coincidences out.
 */
function bestAlignment(haystack: string, needle: string): { score: number; indices: number[] } | null {
  const m = needle.length
  const n = haystack.length
  const NEG = Number.NEGATIVE_INFINITY

  // (qi, at) -> the best continuation, plus the position chosen at qi.
  const need = new Map<number, { score: number; pos: number }>()
  const have = new Map<number, { score: number; pos: number }>()
  const key = (qi: number, at: number) => qi * (n + 1) + at

  // Nothing left to place: the anchor has already happened, and the rest of the
  // query is worth zero. Without this the last character has no successor and
  // nothing matches at all.
  for (let at = 0; at <= n; at++) have.set(key(m, at), { score: 0, pos: at })

  for (let qi = m - 1; qi >= 0; qi--) {
    for (let at = n; at >= 0; at--) {
      let bestNeed: { score: number; pos: number } | null = null
      let bestHave: { score: number; pos: number } | null = null
      for (let pos = at; pos < n; pos++) {
        if (haystack[pos] !== needle[qi]) continue
        // Already placed characters end at `at - 1`, so `pos === at` means this
        // character continues the run.
        const { score, continues, atWordStart } = placementAt(haystack, pos, at - 1, qi === 0)
        const anchors = atWordStart && (continues || qi === 0)
        // `have`: the anchor already happened, so this position needs no more
        // evidence and the rest is `have` too.
        const afterHave = have.get(key(qi + 1, pos + 1))?.score ?? NEG
        if (afterHave !== NEG && (!bestHave || score + afterHave > bestHave.score)) {
          bestHave = { score: score + afterHave, pos }
        }
        // `need`: an anchor is still owed, and this position either pays it or
        // passes the debt on.
        const afterNeed = anchors ? afterHave : need.get(key(qi + 1, pos + 1))?.score ?? NEG
        if (afterNeed !== NEG && (!bestNeed || score + afterNeed > bestNeed.score)) {
          bestNeed = { score: score + afterNeed, pos }
        }
      }
      if (bestNeed) need.set(key(qi, at), bestNeed)
      if (bestHave) have.set(key(qi, at), bestHave)
    }
  }

  const start = need.get(key(0, 0))
  if (!start) return null

  // Walk the chosen positions back out, following the same states the score
  // came from: a position that anchored moves the walk into `have`.
  const indices: number[] = []
  let at = 0
  let settled = false
  for (let qi = 0; qi < m; qi++) {
    const step = (settled ? have : need).get(key(qi, at))
    if (!step) return null
    indices.push(step.pos)
    const { continues, atWordStart } = placementAt(haystack, step.pos, at - 1, qi === 0)
    settled = settled || (atWordStart && (continues || qi === 0))
    at = step.pos + 1
  }
  return { score: start.score - Math.round(n / 2), indices }
}

/**
 * Score `query` against `text`, case-insensitively.
 *
 * An empty query matches everything with a score of 0, which is what keeps an
 * unfiltered list in the order the host sent it: a stable sort on equal scores
 * leaves the catalog order alone.
 */
export function fuzzyScore(query: string, text: string): FuzzyMatch {
  if (query === '') return { score: 0, indices: [] }
  const needle = query.toLowerCase()
  const haystack = text.toLowerCase()
  if (needle.length > haystack.length) return NO_MATCH
  const alignment = bestAlignment(haystack, needle)
  if (!alignment) return NO_MATCH
  return alignment
}

/** True when the query is a subsequence of the text, case-insensitively. */
export function fuzzyMatches(query: string, text: string): boolean {
  return fuzzyScore(query, text).indices.length > 0 || query === ''
}

/**
 * The items matching `query`, best first, and in the order they were given when
 * the evidence is equal.
 *
 * `text` is a function rather than a field so a caller can search several
 * things at once — a model's id and its name, a command's name and its summary
 * — and keep the best score of the two, which is how `gpt` finds
 * "GPT-5.4 Pro" by its display name.
 */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
): T[] {
  if (query === '') return [...items]
  const scored: { item: T; score: number; order: number }[] = []
  for (const [order, item] of items.entries()) {
    const { score, indices } = fuzzyScore(query, text(item))
    if (indices.length === 0 && query !== '') continue
    scored.push({ item, score, order })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(entry => entry.item)
}

/**
 * The best score of several fields for one item.
 *
 * Searching two strings and taking the better one is not the same as searching
 * their concatenation: `glm 5` must not match "glm-5.3" by way of a space that
 * is not in it, and a model whose *name* contains the query should rank with
 * the ones whose id does.
 */
export function bestScore(query: string, ...fields: string[]): FuzzyMatch {
  let best: FuzzyMatch = NO_MATCH
  for (const field of fields) {
    const candidate = fuzzyScore(query, field)
    if (candidate.indices.length > 0 && candidate.score > best.score) best = candidate
  }
  return best
}
