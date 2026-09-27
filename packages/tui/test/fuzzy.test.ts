import { test, expect, describe } from 'bun:test'
import { bestScore, fuzzyFilter, fuzzyMatches, fuzzyScore } from '../src/fuzzy'

/**
 * The scorer, on the strings it will actually be given: model ids full of
 * punctuation, and a query that types none of it.
 *
 * The contract is two-part and both halves matter. An item the query cannot be
 * a subsequence of is *out* — that is the filter. Among the rest, the one the
 * user meant has to come *first* — that is the score. A matcher that only does
 * the first half leaves the user scrolling a shorter list, which is the thing
 * this is replacing.
 */

const score = (query: string, text: string) => fuzzyScore(query, text).score
const matches = (query: string, text: string) => fuzzyScore(query, text).indices.length > 0

describe('fuzzyScore', () => {
  test('an empty query matches everything at zero', () => {
    expect(fuzzyScore('', 'anything at all')).toEqual({ score: 0, indices: [] })
  })

  test('the query must be a subsequence, or there is no match at all', () => {
    expect(matches('gpt5', 'gpt-5.4')).toBe(true)
    expect(matches('xyz', 'gpt-5.4')).toBe(false)
    expect(matches('ptg', 'gpt-5.4')).toBe(false)
  })

  test('a query longer than the text is not a match', () => {
    expect(matches('space-bunny-free', 'bunny')).toBe(false)
  })

  test('matching ignores case and punctuation the user does not type', () => {
    expect(matches('gpt54', 'GPT-5.4-Pro')).toBe(true)
    expect(matches('GLM53', 'glm-5.3')).toBe(true)
    expect(matches('opus45', 'claude-opus-4-5')).toBe(true)
  })

  test('indices point at the characters that matched, in order', () => {
    expect(fuzzyScore('gpt5', 'gpt-5.4').indices).toEqual([0, 1, 2, 4])
    expect(fuzzyScore('cl5', 'claude-4.5').indices).toEqual([0, 1, 9])
  })

  test('a prefix beats a fragment', () => {
    expect(score('glm', 'glm-5.3')).toBeGreaterThan(score('glm', 'xglm-5.3'))
    expect(score('opus', 'claude-opus-4-5')).toBeGreaterThan(score('opus', 'xopus-4-5'))
  })

  test('consecutive characters beat scattered ones', () => {
    expect(score('opus', 'claude-opus-4-5')).toBeGreaterThan(score('opus', 'o-p-u-s-4-5'))
  })

  test('a word start beats the middle of a word', () => {
    expect(score('5.3', 'glm-5.3')).toBeGreaterThan(score('5.3', 'glm-15.32'))
  })

  test('at equal evidence the shorter text wins', () => {
    expect(score('glm-5.3', 'glm-5.3')).toBeGreaterThan(score('glm-5.3', 'glm-5.3-preview'))
  })

  test('an exact match beats a longer one that contains it', () => {
    expect(score('opus', 'opus')).toBeGreaterThan(score('opus', 'claude-opus-4-5-very-long'))
    expect(score('kimi-k3', 'kimi-k3')).toBeGreaterThan(score('kimi-k3', 'kimi-k2.7-code'))
  })
})

describe('anchoring', () => {
  // A match has to attach to a word. Letters floating in unrelated words are
  // coincidence, and a model list full of them turns every query into a search
  // that returns everything.
  test('a name in a different word is not a match', () => {
    expect(matches('opus', 'go/qwen3.6-plus')).toBe(false)
    expect(matches('opus', 'zen/claude-opus-5-5')).toBe(true)
  })

  test('a single letter only matches at a word start', () => {
    expect(matches('g', 'gpt-5.4')).toBe(true)
    expect(matches('x', 'gpt-5.4')).toBe(false)
  })

  test('a scattered run elsewhere in the text is not a match either', () => {
    expect(matches('llama', 'zen/gpt-5.4')).toBe(false)
    expect(matches('llama', 'zen/llama-3.1-free')).toBe(true)
  })

  test('the scan backs up to find the right word: the s of spark is also in muse', () => {
    const found = fuzzyScore('spark', 'zen/muse-spark-1.3')
    expect(found.indices).toEqual([9, 10, 11, 12, 13])
    expect(found.score).toBeGreaterThan(0)
  })

  test('a word start is enough when nothing is contiguous', () => {
    // 'spn': the s-p run starts the text, the n is somewhere later.
    expect(matches('spn', 'space-bunny-free')).toBe(true)
  })
})

describe('fuzzyMatches', () => {
  test('an empty query matches', () => {
    expect(fuzzyMatches('', 'anything')).toBe(true)
  })
  test('a subsequence matches', () => {
    expect(fuzzyMatches('spn', 'space-bunny-free')).toBe(true)
  })
  test('anything else does not', () => {
    expect(fuzzyMatches('bunnyx', 'space-bunny-free')).toBe(false)
  })
})

describe('fuzzyFilter', () => {
  const MODELS = [
    'zen/gpt-5.4',
    'zen/gpt-5.4-pro',
    'zen/gpt-5.4-mini',
    'go/glm-5.3',
    'go/glm-5.3-flash',
    'zen/claude-opus-4-5',
    'zen/space-bunny-free',
    'go/kimi-k3',
  ]

  test('an empty query returns everything, in the order it came', () => {
    expect(fuzzyFilter('', MODELS, m => m)).toEqual(MODELS)
  })

  test('typing a prefix narrows to the prefix', () => {
    expect(fuzzyFilter('gpt-5.4', MODELS, m => m)).toEqual([
      'zen/gpt-5.4',
      'zen/gpt-5.4-pro',
      'zen/gpt-5.4-mini',
    ])
  })

  test('typing without the punctuation finds the same models', () => {
    expect(fuzzyFilter('gpt54', MODELS, m => m).length).toBe(3)
  })

  test('and the exact id is first among them', () => {
    expect(fuzzyFilter('gpt54', MODELS, m => m)[0]).toBe('zen/gpt-5.4')
  })

  test('a query that matches nothing returns nothing', () => {
    expect(fuzzyFilter('llama', MODELS, m => m)).toEqual([])
  })

  test('the cursor is where the evidence is strongest, not where the catalog listed it', () => {
    // The gateway lists the pro and the mini before the plain one, and the
    // plain one is what "gpt54" means.
    const shuffled = ['zen/gpt-5.4-pro', 'zen/gpt-5.4-mini', 'zen/gpt-5.4']
    expect(fuzzyFilter('gpt54', shuffled, m => m)[0]).toBe('zen/gpt-5.4')
  })

  test('a display name can be searched as well as an id', () => {
    const named = [
      { id: 'zen/gpt-5.4', name: 'GPT-5.4' },
      { id: 'zen/muse-spark-1.3', name: 'Muse Spark' },
    ]
    expect(fuzzyFilter('muse', named, m => m.id).map(m => m.id)).toEqual(['zen/muse-spark-1.3'])
    expect(fuzzyFilter('gpt', named, m => m.name).map(m => m.id)).toEqual(['zen/gpt-5.4'])
  })

  test('it does not mutate the list it was given', () => {
    const models = [...MODELS]
    fuzzyFilter('gpt', models, m => m)
    expect(models).toEqual(MODELS)
  })
})

describe('bestScore', () => {
  test('the better of two fields wins', () => {
    expect(bestScore('opus', 'claude-opus-4-5', 'Claude Opus 4.5').indices.length).toBe(4)
  })
  test('a query that only one field has still matches', () => {
    expect(bestScore('spark', 'zen/muse-spark-1.3', 'Muse Spark').score).toBeGreaterThan(0)
  })
  test('a query neither field has does not', () => {
    expect(bestScore('llama', 'zen/gpt-5.4', 'GPT-5.4').indices.length).toBe(0)
  })
  test('fields are searched separately, not concatenated', () => {
    // 'glm 5' with a space must not match 'glm-5.3' by way of both fields
    // together, or every two-word query becomes a match for half the catalog.
    expect(bestScore('glm 5', 'glm-5.3', 'GLM 5.3').indices.length).toBe(5)
  })
})
