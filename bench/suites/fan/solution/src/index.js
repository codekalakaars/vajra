import { net } from './leaf-1.js'
import { lineTotal } from './leaf-2.js'
import { discount } from './leaf-3.js'
import { taxOn } from './leaf-4.js'
import { toCents } from './leaf-5.js'
import { groupBy } from './leaf-6.js'
import { taxRate } from './schema.js'

export { net, lineTotal, discount, taxOn, toCents, groupBy, taxRate }

export function invoiceTotal(lines) {
  let total = 0
  for (const line of lines) {
    let sub = lineTotal(line.unit, line.qty)
    if (line.discountPct) sub = discount(sub, line.discountPct)
    total = net(total + sub + taxOn(sub, taxRate(line.kind)))
  }
  return total
}

export function reportCents(lines) {
  return toCents(invoiceTotal(lines))
}

export function groupLines(lines) {
  return groupBy(lines, 'kind')
}
