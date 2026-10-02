export function taxOn(amount, rate) {
  return Math.round(amount * rate * 100) / 100
}
