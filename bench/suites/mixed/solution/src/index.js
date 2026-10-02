import { formatReport } from './format.js'
import { checkReport } from './validate.js'

export * from './parse.js'
export * from './format.js'
export * from './validate.js'
export { FIELD_ORDER, MAX_FIELDS, REQUIRED } from './shared.js'

export const PIPELINE = 'parse -> check -> format'

export function renderReport(text) {
  return { fields: formatReport(text), problems: checkReport(text) }
}

export function describeReport(text) {
  const report = renderReport(text)
  if (report.problems.length > 0) return 'rejected: ' + report.problems.join(', ')
  return 'accepted: ' + report.fields.join('; ')
}
