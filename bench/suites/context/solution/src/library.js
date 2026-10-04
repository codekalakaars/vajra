export function add(a, b) { return a + b }
export function sub(a, b) { return a - b }
export function mul(a, b) { return a * b }
export function div(a, b) { return a / b }
export function clamp(n, min, max) { return n < min ? min : n > max ? max : n }
export function round2(n) { return Math.round(n * 100) / 100 }
export function sum(values) { return values.reduce((a, b) => a + b, 0) }
export function average(values) { return values.length === 0 ? 0 : sum(values) / values.length }
