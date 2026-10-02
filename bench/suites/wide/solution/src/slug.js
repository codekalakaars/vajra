export function slugify(text) {
  if (typeof text !== 'string') throw new TypeError('slugify needs a string')
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
