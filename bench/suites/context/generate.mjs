#!/usr/bin/env node
// Generator for the context-management bench fixture.
//
// The reference files are deliberately large: they are included in the context
// pack of the lookup task, so their size pushes the pack toward the model's
// window and makes context-pack sizing and the compaction ladder measurable.
//
// Run this script to regenerate the files after changing the parameters below:
//   node bench/suites/context/generate.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REF = join(HERE, 'fixture', 'src', 'reference')

const FILE_COUNT = 12
const ITEMS_PER_FILE = 600

function pad(n, width) {
  return String(n).padStart(width, '0')
}

function valueFor(index) {
  // A value long enough to keep the file size up, but simple enough that the
  // model never has to reason about its content.
  return `value-${index}-`.repeat(8).slice(0, -1)
}

function tagsFor(fileIndex, itemIndex) {
  const global = fileIndex * ITEMS_PER_FILE + itemIndex
  const t1 = `tag-${(global % 7) + 1}`
  const t2 = `tag-${((global + 3) % 5) + 8}`
  return [t1, t2]
}

mkdirSync(REF, { recursive: true })

for (let f = 0; f < FILE_COUNT; f++) {
  const items = []
  for (let i = 0; i < ITEMS_PER_FILE; i++) {
    const global = f * ITEMS_PER_FILE + i
    items.push({
      id: `item-${pad(global + 1, 5)}`,
      value: valueFor(global + 1),
      tags: tagsFor(f, i),
    })
  }
  // Shuffle deterministically so a lookup must scan more than one file.
  const shuffled = items
    .map((item, index) => ({ item, key: Math.sin(index + f * 1000) * 10000 }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item)
  const path = join(REF, `items-${pad(f + 1, 2)}.json`)
  writeFileSync(path, `${JSON.stringify(shuffled, null, 2)}\n`)
}

console.log(`wrote ${FILE_COUNT} reference files to ${REF}`)
