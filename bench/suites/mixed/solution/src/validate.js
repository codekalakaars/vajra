import { REQUIRED } from './shared.js'
import { parseAll } from './parse.js'

const KEY = /^[a-z][a-z0-9_]*$/

export function checkField(key, value) {
  if (typeof key !== 'string' || !KEY.test(key)) return key + ': bad key'
  if (typeof value !== 'string' || value.trim().length === 0) return key + ': empty value'
  return null
}

export function checkReport(text) {
  const fields = parseAll(text)
  const problems = []
  for (const [key, value] of Object.entries(fields)) {
    const problem = checkField(key, value)
    if (problem !== null) problems.push(problem)
  }
  for (const key of REQUIRED) {
    if (!(key in fields)) problems.push('missing: ' + key)
  }
  return problems
}
