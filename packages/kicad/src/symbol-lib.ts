// Symbol library resolver for KiCad .kicad_sym files.
//
// Parses .kicad_sym files to extract pin definitions, resolves
// "Library:Symbol" references to concrete pin maps, and generates
// fallback box symbols when libraries are unavailable.

import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface ResolvedPin {
  number: string
  name: string
  electricalType: string   // input, output, bidirectional, passive, power_in, power_out, etc.
  graphicStyle: string     // line, inverted, clock, etc.
  position: { x: number; y: number }  // connection point relative to symbol origin
  angle: number            // 0, 90, 180, 270 — direction pin extends FROM connection point
  length: number           // mm
  visible: boolean
}

export interface ResolvedSymbol {
  name: string
  unitCount: number
  pins: Map<string, ResolvedPin>  // pin number → pin definition
  /** Which pin numbers belong to each unit (0 = common to all) */
  units: Map<number, string[]>
  /** Raw S-expression for embedding in .kicad_sch lib_symbols */
  rawDefinition: string
}

export interface SymbolLibrary {
  name: string
  version: number
  symbols: Map<string, ResolvedSymbol>
}

export interface SymbolLibTableEntry {
  name: string       // nickname (e.g., "Device")
  type: string       // "KiCad" or "Legacy"
  uri: string        // path template with ${KICAD_SYMBOL_DIR} etc.
  options: string
  descr: string
}

// ---------------------------------------------------------------------------
// S-expression parser — tokenize and parse nested parenthesized expressions
// ---------------------------------------------------------------------------

type Sexpr = string | Sexpr[]

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === '(' || ch === ')') {
      tokens.push(ch)
      i++
    } else if (ch === '"') {
      // Quoted string
      let j = i + 1
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') j++ // skip escaped char
        j++
      }
      tokens.push(input.slice(i + 1, j)) // strip quotes
      i = j + 1
    } else if (ch === ';' && input[i + 1] === ';') {
      // Comment — skip to end of line
      while (i < input.length && input[i] !== '\n') i++
    } else if (/\s/.test(ch)) {
      i++ // skip whitespace
    } else {
      // Bare atom
      let j = i
      while (j < input.length && input[j] !== '(' && input[j] !== ')' && !/\s/.test(input[j])) {
        j++
      }
      tokens.push(input.slice(i, j))
      i = j
    }
  }
  return tokens
}

function parseSexpr(tokens: string[], pos: { i: number }): Sexpr {
  if (tokens[pos.i] === '(') {
    pos.i++ // skip '('
    const list: Sexpr[] = []
    while (pos.i < tokens.length && tokens[pos.i] !== ')') {
      list.push(parseSexpr(tokens, pos))
    }
    pos.i++ // skip ')'
    return list
  } else {
    const atom = tokens[pos.i]
    pos.i++
    return atom
  }
}

/** Parse an S-expression string into a nested array structure */
export function parseSexpression(input: string): Sexpr {
  const tokens = tokenize(input)
  const pos = { i: 0 }
  return parseSexpr(tokens, pos)
}

// ---------------------------------------------------------------------------
// S-expression navigation helpers
// ---------------------------------------------------------------------------

/** Check if a node is an array (list) */
function isList(node: Sexpr): node is Sexpr[] {
  return Array.isArray(node)
}

/** Get the first element of a list node */
function head(node: Sexpr): string | undefined {
  return isList(node) && node.length > 0 && typeof node[0] === 'string' ? node[0] : undefined
}

/** Find a child node by keyword */
function findChild(node: Sexpr, keyword: string): Sexpr | undefined {
  if (!isList(node)) return undefined
  for (const child of node) {
    if (isList(child) && child.length > 0 && child[0] === keyword) {
      return child
    }
  }
  return undefined
}

/** Find all child nodes by keyword */
function findAllChildren(node: Sexpr, keyword: string): Sexpr[] {
  if (!isList(node)) return []
  return node.filter((child): child is Sexpr[] =>
    isList(child) && child.length > 0 && child[0] === keyword
  )
}

/** Get string value of a child node: (keyword "value") → "value" */
function getChildString(node: Sexpr, keyword: string): string | undefined {
  const child = findChild(node, keyword)
  if (!child || !isList(child) || child.length < 2) return undefined
  return typeof child[1] === 'string' ? child[1] : undefined
}

/** Get numeric value of a child node */
function getChildNumber(node: Sexpr, keyword: string): number | undefined {
  const val = getChildString(node, keyword)
  return val !== undefined ? Number(val) : undefined
}

/** Extract text content from a property node: (property "Reference" "R" ...) → "R" */
function getPropertyvalue(node: Sexpr): string | undefined {
  if (!isList(node) || node.length < 3) return undefined
  return typeof node[2] === 'string' ? node[2] : undefined
}

// ---------------------------------------------------------------------------
// .kicad_sym parser
// ---------------------------------------------------------------------------

function parsePin(node: Sexpr): ResolvedPin | null {
  if (!isList(node) || node.length < 2) return null

  // Format: (pin ELECTRICAL_TYPE GRAPHIC_STYLE (at X Y ANGLE) (length L) (name ...) (number ...))
  const electricalType = typeof node[1] === 'string' ? node[1] : 'passive'
  const graphicStyle = typeof node[2] === 'string' ? node[2] : 'line'

  // Parse (at X Y ANGLE)
  const atNode = findChild(node, 'at')
  let x = 0, y = 0, angle = 0
  if (atNode && isList(atNode)) {
    x = typeof atNode[1] === 'string' ? Number(atNode[1]) : 0
    y = typeof atNode[2] === 'string' ? Number(atNode[2]) : 0
    angle = typeof atNode[3] === 'string' ? Number(atNode[3]) : 0
  }

  // Parse (length L)
  const length = getChildNumber(node, 'length') ?? 2.54

  // Parse (name "NAME" ...)
  const nameNode = findChild(node, 'name')
  let name = ''
  let visible = true
  if (nameNode && isList(nameNode)) {
    name = typeof nameNode[1] === 'string' ? nameNode[1] : ''
    // Check for (hide) in effects
    const effects = findChild(nameNode, 'effects')
    if (effects) {
      const hideNode = findChild(effects, 'hide')
      if (hideNode) visible = false
    }
  }

  // Parse (number "NUM" ...)
  const numberNode = findChild(node, 'number')
  let number = '1'
  if (numberNode && isList(numberNode)) {
    number = typeof numberNode[1] === 'string' ? numberNode[1] : '1'
  }

  return {
    number,
    name,
    electricalType,
    graphicStyle,
    position: { x, y },
    angle,
    length,
    visible,
  }
}

function parseSymbolDefinition(node: Sexpr, symbolName: string): ResolvedSymbol | null {
  if (!isList(node)) return null

  const pins = new Map<string, ResolvedPin>()
  const units = new Map<number, string[]>()
  let unitCount = 1

  // Find all sub-symbols (unit-specific definitions)
  const subSymbols = findAllChildren(node, 'symbol')

  for (const sub of subSymbols) {
    if (!isList(sub) || sub.length < 2) continue
    const subName = typeof sub[1] === 'string' ? sub[1] : ''

    // Parse unit number from sub-symbol name: "SYMBOLNAME_UNIT_STYLE"
    // e.g., "Device:R_1_1" → unit 1, style 1
    //        "Device:R_0_1" → unit 0 (common), style 1
    const match = subName.match(/_(\d+)_(\d+)$/)
    const unitNum = match ? parseInt(match[1], 10) : 0

    if (unitNum > unitCount) unitCount = unitNum

    // Parse pins in this sub-symbol
    const pinNodes = findAllChildren(sub, 'pin')
    for (const pinNode of pinNodes) {
      const pin = parsePin(pinNode)
      if (pin) {
        pins.set(pin.number, pin)

        // Track which unit this pin belongs to
        if (!units.has(unitNum)) units.set(unitNum, [])
        units.get(unitNum)!.push(pin.number)
      }
    }
  }

  // Also check for pins directly in the top-level symbol (not in sub-symbols)
  const directPins = findAllChildren(node, 'pin')
  for (const pinNode of directPins) {
    const pin = parsePin(pinNode)
    if (pin && !pins.has(pin.number)) {
      pins.set(pin.number, pin)
      // Direct pins are common to all units
      if (!units.has(0)) units.set(0, [])
      units.get(0)!.push(pin.number)
    }
  }

  return {
    name: symbolName,
    unitCount,
    pins,
    units,
    rawDefinition: '', // filled in by the caller
  }
}

/** Parse a .kicad_sym file and extract all symbols */
export function parseSymbolLibrary(content: string): SymbolLibrary {
  const tree = parseSexpression(content)

  if (!isList(tree) || tree[0] !== 'kicad_symbol_lib') {
    throw new Error('Not a valid .kicad_sym file')
  }

  const version = Number(getChildString(tree, 'version') ?? '0')
  const symbols = new Map<string, ResolvedSymbol>()

  // Find all (symbol "NAME" ...) nodes
  const symbolNodes = findAllChildren(tree, 'symbol')

  for (const symNode of symbolNodes) {
    if (!isList(symNode) || symNode.length < 2) continue
    const symName = typeof symNode[1] === 'string' ? symNode[1] : ''
    if (!symName) continue

    const parsed = parseSymbolDefinition(symNode, symName)
    if (parsed) {
      // Store the raw S-expression for embedding
      // We'll reconstruct it from the tree since we need the full definition
      parsed.rawDefinition = reconstructSymbolSexpr(symNode)
      symbols.set(symName, parsed)
    }
  }

  return {
    name: '',
    version,
    symbols,
  }
}

/** Reconstruct an S-expression from a parsed tree */
function reconstructSymbolSexpr(node: Sexpr): string {
  if (!isList(node)) {
    return typeof node === 'string' ? `"${node}"` : String(node)
  }
  const parts = node.map(reconstructSymbolSexpr)
  return `(${parts.join(' ')})`
}

// ---------------------------------------------------------------------------
// sym-lib-table parser
// ---------------------------------------------------------------------------

/** Parse a sym-lib-table file */
export function parseSymLibTable(content: string): SymbolLibTableEntry[] {
  const tree = parseSexpression(content)

  if (!isList(tree) || tree[0] !== 'sym_lib_table') {
    return []
  }

  const entries: SymbolLibTableEntry[] = []
  const libNodes = findAllChildren(tree, 'lib')

  for (const libNode of libNodes) {
    if (!isList(libNode)) continue
    const name = getChildString(libNode, 'name') ?? ''
    const type = getChildString(libNode, 'type') ?? 'KiCad'
    const uri = getChildString(libNode, 'uri') ?? ''
    const options = getChildString(libNode, 'options') ?? ''
    const descr = getChildString(libNode, 'descr') ?? ''

    if (name && uri) {
      entries.push({ name, type, uri, options, descr })
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// Symbol library resolver
// ---------------------------------------------------------------------------

/** Resolve environment variables like ${KICAD_SYMBOL_DIR} */
function resolveEnvVars(uri: string): string {
  return uri.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] ?? ''
  })
}

/** Find the symbol library file for a given nickname */
async function findLibraryFile(
  nickname: string,
  libTable: SymbolLibTableEntry[],
  searchPaths: string[],
): Promise<string | null> {
  // 1. Check sym-lib-table
  const entry = libTable.find((e) => e.name === nickname)
  if (entry) {
    const resolvedUri = resolveEnvVars(entry.uri)
    // Handle .kicad_symdir (directory of symbols) vs .kicad_sym (single file)
    if (resolvedUri.endsWith('.kicad_symdir')) {
      const dir = resolvedUri.replace('.kicad_symdir', '')
      const symFile = resolve(dir, `${nickname}.kicad_sym`)
      if (existsSync(symFile)) return symFile
      // Also check for the file directly in the directory
      if (existsSync(dir)) {
        const files = await readFile(dir, 'utf-8').then(() => true).catch(() => false)
        if (files) return dir // It's a directory, need to list contents
      }
    } else if (resolvedUri.endsWith('.kicad_sym')) {
      if (existsSync(resolvedUri)) return resolvedUri
    } else {
      // Try appending .kicad_sym
      if (existsSync(resolvedUri)) return resolvedUri
      if (existsSync(`${resolvedUri}.kicad_sym`)) return `${resolvedUri}.kicad_sym`
    }
  }

  // 2. Check search paths
  for (const sp of searchPaths) {
    const candidate = resolve(sp, `${nickname}.kicad_sym`)
    if (existsSync(candidate)) return candidate
  }

  return null
}

/** Resolve a LIBRARY_ID (e.g., "Device:R") to a ResolvedSymbol */
export async function resolveSymbol(
  libId: string,
  libTable: SymbolLibTableEntry[],
  searchPaths: string[],
  cache: Map<string, SymbolLibrary>,
): Promise<ResolvedSymbol | null> {
  // Parse "Library:Symbol" format
  const colonIdx = libId.indexOf(':')
  if (colonIdx === -1) return null

  const nickname = libId.slice(0, colonIdx)
  const symbolName = libId.slice(colonIdx + 1)

  // Check cache first
  if (cache.has(nickname)) {
    const lib = cache.get(nickname)!
    return lib.symbols.get(symbolName) ?? null
  }

  // Find and parse the library file
  const libFile = await findLibraryFile(nickname, libTable, searchPaths)
  if (!libFile) return null

  try {
    const content = await readFile(libFile, 'utf-8')
    const lib = parseSymbolLibrary(content)
    lib.name = nickname
    cache.set(nickname, lib)
    return lib.symbols.get(symbolName) ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Fallback: generate box symbols for unknown components
// ---------------------------------------------------------------------------

/** Generate a fallback box symbol with N pins */
export function generateBoxSymbol(
  name: string,
  pinCount: number,
  _pinsPerSide?: number,
): ResolvedSymbol {
  const pins = new Map<string, ResolvedPin>()
  const units = new Map<number, string[]>()

  // Split pins evenly: left side gets ceil(n/2), right side gets floor(n/2)
  const leftCount = Math.ceil(pinCount / 2)
  const rightCount = pinCount - leftCount
  let pinNum = 1
  const allPinNums: string[] = []

  // Left side pins (input-like)
  for (let i = 0; i < leftCount; i++, pinNum++) {
    const y = (i - (leftCount - 1) / 2) * 2.54
    pins.set(String(pinNum), {
      number: String(pinNum),
      name: `P${pinNum}`,
      electricalType: 'passive',
      graphicStyle: 'line',
      position: { x: -5.08, y },
      angle: 0,
      length: 2.54,
      visible: true,
    })
    allPinNums.push(String(pinNum))
  }

  // Right side pins (output-like)
  for (let i = 0; i < rightCount; i++, pinNum++) {
    const y = (i - (rightCount - 1) / 2) * 2.54
    pins.set(String(pinNum), {
      number: String(pinNum),
      name: `P${pinNum}`,
      electricalType: 'passive',
      graphicStyle: 'line',
      position: { x: 5.08, y },
      angle: 180,
      length: 2.54,
      visible: true,
    })
    allPinNums.push(String(pinNum))
  }

  units.set(0, allPinNums) // all pins common to all units

  return {
    name,
    unitCount: 1,
    pins,
    units,
    rawDefinition: '', // box symbols don't need raw definitions
  }
}

// ---------------------------------------------------------------------------
// Symbol cache class for managing multiple libraries
// ---------------------------------------------------------------------------

export class SymbolResolver {
  private libTable: SymbolLibTableEntry[] = []
  private searchPaths: string[]
  private cache = new Map<string, SymbolLibrary>()

  constructor(searchPaths: string[] = []) {
    this.searchPaths = searchPaths
  }

  /** Load a sym-lib-table file */
  async loadLibTable(path: string): Promise<void> {
    try {
      const content = await readFile(path, 'utf-8')
      this.libTable = parseSymLibTable(content)
    } catch {
      // Ignore errors — we'll use search paths as fallback
    }
  }

  /** Add a library table entry manually */
  addLibEntry(entry: SymbolLibTableEntry): void {
    this.libTable.push(entry)
  }

  /** Add a search path for library files */
  addSearchPath(path: string): void {
    this.searchPaths.push(path)
  }

  /** Resolve a LIBRARY_ID to a ResolvedSymbol, with box symbol fallback */
  async resolve(libId: string): Promise<ResolvedSymbol> {
    const result = await resolveSymbol(libId, this.libTable, this.searchPaths, this.cache)
    if (result) return result

    // Fallback: generate box symbol
    const colonIdx = libId.indexOf(':')
    const symbolName = colonIdx !== -1 ? libId.slice(colonIdx + 1) : libId
    return generateBoxSymbol(symbolName, 8) // default 8-pin box
  }

  /** Get a symbol from the embedded library (for .kicad_sch embedding) */
  getEmbeddedSymbol(libId: string): ResolvedSymbol | undefined {
    const colonIdx = libId.indexOf(':')
    if (colonIdx === -1) return undefined
    const nickname = libId.slice(0, colonIdx)
    const symbolName = libId.slice(colonIdx + 1)
    const lib = this.cache.get(nickname)
    return lib?.symbols.get(symbolName)
  }

  /** Check if a symbol is available */
  hasSymbol(libId: string): boolean {
    const colonIdx = libId.indexOf(':')
    if (colonIdx === -1) return false
    const nickname = libId.slice(0, colonIdx)
    const symbolName = libId.slice(colonIdx + 1)
    const lib = this.cache.get(nickname)
    return lib?.symbols.has(symbolName) ?? false
  }
}
