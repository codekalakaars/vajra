import { readFileSync } from 'node:fs'

const FILES = [
  'src/reference/items-01.json',
  'src/reference/items-02.json',
  'src/reference/items-03.json',
  'src/reference/items-04.json',
  'src/reference/items-05.json',
  'src/reference/items-06.json',
  'src/reference/items-07.json',
  'src/reference/items-08.json',
  'src/reference/items-09.json',
  'src/reference/items-10.json',
  'src/reference/items-11.json',
  'src/reference/items-12.json',
]

export function lookup(id) {
  for (const file of FILES) {
    const items = JSON.parse(readFileSync(file, 'utf8'))
    for (const item of items) {
      if (item.id === id) return item.value
    }
  }
  return undefined
}
