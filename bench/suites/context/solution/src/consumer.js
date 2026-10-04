import { add, mul, clamp, round2, average } from './library.js'

export function pipeline(values) {
  if (values.length === 0) return 0
  return round2(average(values.map(v => clamp(mul(v, 2), -5, 5))))
}
