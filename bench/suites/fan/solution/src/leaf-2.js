export function lineTotal(unit, qty) {
  return Math.round(unit * qty * 100) / 100
}
