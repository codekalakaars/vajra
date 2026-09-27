/**
 * Turn a pty byte stream back into the screen it painted: honour CUP, cursor
 * moves, erase, and plain text; drop SGR, DCS and the terminal capability
 * chatter. Enough for a full-screen TUI, and no more.
 */
const ESC = '\x1b'
const BEL = '\x07'

export function reconstruct(raw, cols = 92, rows = 30) {
  const cells = new Map()
  let row = 1
  let col = 1
  // CSI: ESC [ , private/intermediate parameter bytes, one final byte.
  const CSI = new RegExp(`^${ESC}\\[([\\x30-\\x3f]*)([\\x20-\\x2f]*)([\\x40-\\x7e])`)
  // String sequences (DCS/APC/PM/OSC) run until ST or BEL.
  const STR = new RegExp(`^${ESC}[P\\]X^_].*?(?:${ESC}\\\\|${BEL})`, 's')
  // Anything else: ESC plus at most one more byte.
  const OTHER = new RegExp(`^${ESC}[\\x20-\\x3f]{0,2}[\\x40-\\x7e]?`)

  for (let i = 0; i < raw.length; ) {
    const ch = raw[i]
    if (ch === ESC) {
      const str = STR.exec(raw.slice(i))
      if (str) {
        i += str[0].length
        continue
      }
      const csi = CSI.exec(raw.slice(i))
      if (csi) {
        const cmd = csi[3]
        const nums = csi[1].split(';').filter(p => p !== '').map(Number)
        const n = nums[0] ?? 1
        if (cmd === 'H' || cmd === 'f') {
          row = n
          col = nums[1] ?? 1
        } else if (cmd === 'A') row -= n
        else if (cmd === 'B') row += n
        else if (cmd === 'C') col += n
        else if (cmd === 'D') col -= n
        else if (cmd === 'E') {
          row += n
          col = 1
        } else if (cmd === 'F') {
          row -= n
          col = 1
        } else if (cmd === 'G' || cmd === '`') col = n
        else if (cmd === 'd') row = n
        else if (cmd === 'J') cells.clear()
        else if (cmd === 'K') {
          for (let c = col; c <= cols; c++) cells.delete(`${row}:${c}`)
        }
        i += csi[0].length
        continue
      }
      const other = OTHER.exec(raw.slice(i))
      i += other ? other[0].length : 1
      continue
    }
    if (ch === '\n') {
      row += 1
      col = 1
      i += 1
      continue
    }
    if (ch === '\r') {
      col = 1
      i += 1
      continue
    }
    cells.set(`${row}:${col}`, ch)
    col += 1
    i += 1
  }
  const out = []
  for (let r = 1; r <= rows; r++) {
    let line = ''
    for (let c = 1; c <= cols; c++) line += cells.get(`${r}:${c}`) ?? ' '
    out.push(line.replace(/\s+$/, ''))
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}
