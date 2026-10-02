import { FIELD_ORDER, MAX_FIELDS, REQUIRED } from './shared.js'
import { parseAll } from './parse.js'

export function formatLine(key, value) {
  if (typeof key !== 'string' || typeof value !== 'string') {
    throw new TypeError('formatLine needs a key and a value')
  }
  return key.trim() + '=' + value.trim()
}

export function formatReport(text) {
  const fields = parseAll(text)
  const keys = Object.keys(fields).slice(0, MAX_FIELDS)
  const head = FIELD_ORDER.filter(key => REQUIRED.includes(key) && keys.includes(key))
  const tail = keys.filter(key => !head.includes(key)).sort()
  return [...head, ...tail].map(key => formatLine(key, fields[key]))
}
