/**
 * The model catalog: what each model can actually do, fetched rather than
 * guessed.
 *
 * There used to be two hardcoded lists — a "free models" preset array and a
 * `200_000` context constant in the screen — and they disagreed with each other
 * and with the gateway. A model is not a string: it has a context window, a
 * price, modalities, and a *reasoning vocabulary* that differs per model. Some
 * models take `reasoning_effort`, some only take a toggle, some take a token
 * budget, and some do not reason at all. Sending `reasoning_effort: high` to a
 * model that has never heard of it is either a 400 or, worse, silently ignored.
 *
 * So the catalog has two sources, deliberately separate:
 *
 *  - **capabilities** come from models.dev, a curated dataset that publishes
 *    exactly these fields per model (`reasoning`, `reasoning_options`,
 *    `limit`, `cost`, `modalities`, `release_date`);
 *  - **availability** comes from the gateway's own `GET /models`, which is the
 *    only thing that knows whether an account can reach a model *right now* —
 *    Zen retires models, and models.dev lags.
 *
 * Both are optional at runtime. A cold, offline machine gets an empty catalog,
 * every lookup falls back to the old conservative defaults, and the UI says the
 * facts are unknown rather than inventing them. Nothing in here throws: a
 * missing capability must never take down a session.
 */

import { readJsonFile, resolveVajraHome, writeJsonFile } from '../home.js'
import { join } from 'node:path'

/** models.dev publishes every provider; these two are the ones we can reach. */
const CATALOG_URL = 'https://models.dev/api.json'
/** Gateway listings, keyed by our own provider prefix. */
const LISTING_URLS: Record<string, string> = {
  zen: 'https://opencode.ai/zen/v1/models',
  go: 'https://opencode.ai/zen/go/v1/models',
}

/**
 * A day is long enough that a session never waits on the network, and short
 * enough that a newly released model shows up tomorrow. The fetch is in the
 * background either way; this only decides whether a *new* process refetches.
 */
const CATALOG_TTL_MS = 12 * 60 * 60 * 1000
const CATALOG_TIMEOUT_MS = 15_000
const LISTING_TIMEOUT_MS = 10_000

/**
 * Reasoning effort, widened from the four levels we used to hardcode.
 *
 * The extra levels are real: the gateway serves models that accept `minimal`,
 * `xhigh` and `max`, and a UI that cannot name them cannot offer them. `off` is
 * ours and never goes on the wire — it means "send no reasoning parameter".
 */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Every level, in the order a dial should walk them: off, then ascending. */
export const REASONING_EFFORTS: ReasoningEffort[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/**
 * How a model wants reasoning controlled.
 *
 *  - `effort` — a named level (`reasoning_effort` on an OpenAI-compatible body);
 *  - `toggle` — on or off, no gradient (`reasoning: { enabled }`);
 *  - `budget` — a token budget rather than a level. We do not send one, so the
 *    UI reports it and leaves the level at `off` rather than pretending.
 *  - `none` — the model does not reason; no level may be sent.
 */
export type ReasoningMode = 'none' | 'toggle' | 'effort' | 'budget'

/** Availability as the gateway reports it, or as we failed to learn it. */
export type ModelStatus = 'available' | 'unavailable' | 'unknown'

export interface ModelInfo {
  /** The id the user types: `zen/gpt-5.4` or `go/glm-5.3`. */
  id: string
  /** The id the gateway wants, with our prefix stripped. */
  wireId: string
  /** `zen` or `go`. */
  provider: string
  name: string
  description?: string
  family?: string
  /** Whether the model reasons at all. */
  reasoning: boolean
  /** How reasoning is controlled. */
  reasoningMode: ReasoningMode
  /** The effort levels this model accepts, ascending, `off` excluded. */
  reasoningEfforts: Exclude<ReasoningEffort, 'off'>[]
  context: number
  /** Max completion tokens, as published. */
  output: number
  /** USD per million tokens. */
  cost: { input: number; output: number; cacheRead: number }
  modalities: { input: string[]; output: string[] }
  toolCall: boolean
  attachment: boolean
  structuredOutput: boolean
  temperature: boolean
  openWeights: boolean
  releaseDate?: string
  /** Live reachability, from the gateway's own listing. */
  status: ModelStatus
  /** Why `status` is what it is — shown in `/models`, never guessed at. */
  statusDetail?: string
}

export interface Catalog {
  /** Epoch ms of the fetch that produced this catalog. */
  fetchedAt: number
  /** When models.dev last published it, if it said. */
  publishedAt?: number
  models: Record<string, ModelInfo>
}

/** The conservative answer used when the catalog cannot say. */
const UNKNOWN_CONTEXT = 128_000

/** Cache file: `~/.vajra/models.json`. Overwritten only on a good fetch. */
function catalogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveVajraHome(env), 'models.json')
}

// ---- parsing -----------------------------------------------------------------

/** The subset of a models.dev entry we read. Everything else is ignored. */
interface RawModel {
  id?: string
  name?: string
  description?: string
  family?: string
  reasoning?: boolean
  reasoning_options?: { type?: string; values?: string[] }[]
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number }
  modalities?: { input?: string[]; output?: string[] }
  tool_call?: boolean
  attachment?: boolean
  structured_output?: boolean
  temperature?: boolean
  open_weights?: boolean
  release_date?: string
}

interface RawProvider {
  api?: string
  models?: Record<string, RawModel>
}

const asArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * Our provider prefix for a models.dev provider.
 *
 * Matched on the API base rather than the id, because models.dev calls them
 * `opencode` and `opencode-go` while we call them `zen/*` and `go/*`. Matching
 * on the name would break the day either side renames.
 */
function providerForApi(api: string | undefined): string | null {
  if (!api) return null
  const url = api.replace(/\/+$/, '')
  for (const [prefix, listing] of Object.entries(LISTING_URLS)) {
    if (url === listing.replace(/\/models$/, '')) return prefix
  }
  return null
}

/**
 * The effort levels a models.dev entry accepts, ascending.
 *
 * `none` is dropped rather than mapped to `off`: `off` is our own "send
 * nothing", and a model that lists `none` as a value has a real `none`, which
 * is not the same request. Unknown strings are dropped too — an effort the
 * gateway never documented is one it will reject.
 */
function effortsOf(raw: RawModel): { mode: ReasoningMode; efforts: Exclude<ReasoningEffort, 'off'>[] } {
  const options = Array.isArray(raw.reasoning_options) ? raw.reasoning_options : []
  const types = new Set(options.map(option => option?.type).filter((t): t is string => typeof t === 'string'))
  const values = new Set<string>()
  for (const option of options) for (const value of asArray(option?.values)) values.add(value)

  if (!raw.reasoning) return { mode: 'none', efforts: [] }
  if (types.has('effort')) {
    const efforts = [...values].filter(
      (value): value is Exclude<ReasoningEffort, 'off'> =>
        value !== 'none' && (REASONING_EFFORTS as string[]).includes(value),
    )
    if (efforts.length > 0) {
      efforts.sort((a, b) => REASONING_EFFORTS.indexOf(a) - REASONING_EFFORTS.indexOf(b))
      return { mode: 'effort', efforts }
    }
  }
  if (types.has('toggle')) return { mode: 'toggle', efforts: [] }
  if (types.has('budget_tokens')) return { mode: 'budget', efforts: [] }
  // Says it reasons but does not say how. Offering nothing is the honest
  // answer; the sidebar reports the gap instead of guessing a parameter.
  return { mode: 'none', efforts: [] }
}

/**
 * Turn a models.dev payload into a catalog keyed by our model ids.
 *
 * Total by construction: an entry missing an id, a provider we cannot reach, or
 * a half-populated `limit` produces a skipped model or a defaulted field, never
 * an exception. Upstream is a third-party JSON file that changes under us.
 */
export function parseCatalog(payload: unknown, fetchedAt = Date.now()): Catalog {
  const catalog: Catalog = { fetchedAt, models: {} }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return catalog
  const providers = payload as Record<string, RawProvider>
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== 'object') continue
    const prefix = providerForApi(provider.api)
    if (!prefix) continue
    for (const [wireId, raw] of Object.entries(provider.models ?? {})) {
      if (!raw || typeof raw !== 'object') continue
      const id = typeof raw.id === 'string' && raw.id ? raw.id : wireId
      if (!id) continue
      const { mode, efforts } = effortsOf(raw)
      catalog.models[`${prefix}/${id}`] = {
        id: `${prefix}/${id}`,
        wireId: id,
        provider: prefix,
        name: typeof raw.name === 'string' && raw.name ? raw.name : id,
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
        ...(typeof raw.family === 'string' ? { family: raw.family } : {}),
        reasoning: mode !== 'none',
        reasoningMode: mode,
        reasoningEfforts: efforts,
        context: asNumber(raw.limit?.context, UNKNOWN_CONTEXT),
        output: asNumber(raw.limit?.output),
        cost: {
          input: asNumber(raw.cost?.input),
          output: asNumber(raw.cost?.output),
          cacheRead: asNumber(raw.cost?.cache_read),
        },
        modalities: {
          input: asArray(raw.modalities?.input),
          output: asArray(raw.modalities?.output),
        },
        toolCall: raw.tool_call === true,
        attachment: raw.attachment === true,
        structuredOutput: raw.structured_output === true,
        temperature: raw.temperature === true,
        openWeights: raw.open_weights === true,
        ...(typeof raw.release_date === 'string' ? { releaseDate: raw.release_date } : {}),
        status: 'unknown',
      }
    }
  }
  return catalog
}

// ---- cache -------------------------------------------------------------------

interface CacheFile {
  version: 1
  fetchedAt: number
  catalog: Catalog
}

function readCache(env: NodeJS.ProcessEnv): Catalog | null {
  const file = readJsonFile<CacheFile>(catalogPath(env))
  if (!file || file.version !== 1 || !file.catalog || typeof file.catalog !== 'object') return null
  const models = (file.catalog as Catalog).models
  if (!models || typeof models !== 'object') return null
  return { ...(file.catalog as Catalog), models, fetchedAt: asNumber(file.fetchedAt) }
}

function writeCache(catalog: Catalog, env: NodeJS.ProcessEnv): void {
  try {
    writeJsonFile(catalogPath(env), { version: 1, fetchedAt: catalog.fetchedAt, catalog } satisfies CacheFile)
  } catch {
    // A read-only home is not a reason to fail a session; the next start
    // refetches.
  }
}

/** What a `fetch` has to be for this module. Tests hand in their own. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

async function fetchCatalog(now: number, fetchImpl: FetchLike): Promise<Catalog | null> {
  try {
    const response = await fetchImpl(CATALOG_URL, {
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const catalog = parseCatalog(await response.json(), now)
    // An empty parse means the shape changed under us. Better to keep serving
    // yesterday's catalog than to replace it with nothing.
    return Object.keys(catalog.models).length > 0 ? catalog : null
  } catch {
    return null
  }
}

// ---- module state ------------------------------------------------------------

/** The last catalog this process loaded. Sync lookups read this. */
let current: Catalog = { fetchedAt: 0, models: {} }
/** Live availability from the gateway listing, when we have it. */
let availability: Map<string, ModelStatus> = new Map()
let inFlight: Promise<Catalog> | null = null

/** The catalog as last loaded. Empty before the first load resolves. */
export function loadedCatalog(): Catalog {
  return current
}

/** Forget everything — used by tests, and by `/models refresh`. */
export function resetCatalog(): void {
  current = { fetchedAt: 0, models: {} }
  availability = new Map()
  inFlight = null
}

/** Record availability for tests and for the listing refresh. */
export function setAvailability(map: Map<string, ModelStatus>): void {
  availability = new Map(map)
}

/**
 * Load the catalog: cache first, network in the background.
 *
 * Never rejects. A caller that needs facts right now gets the cache (possibly
 * stale, possibly empty) synchronously-ish, and the promise resolves when the
 * refresh has been folded in — the caller can await it and re-read.
 */
export async function loadModelCatalog(
  options: { force?: boolean; now?: number; env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<Catalog> {
  if (inFlight && !options.force) return inFlight
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const run = (async (): Promise<Catalog> => {
    const cached = readCache(env)
    if (cached) current = withAvailability(cached)
    const fresh = cached !== null && now - cached.fetchedAt < CATALOG_TTL_MS
    if (options.force || !fresh) {
      const fetched = await fetchCatalog(now, options.fetchImpl ?? fetch)
      if (fetched) {
        current = withAvailability(fetched)
        writeCache(current, env)
      }
    }
    return current
  })()
  inFlight = run
  try {
    return await run
  } finally {
    if (inFlight === run) inFlight = null
  }
}

function withAvailability(catalog: Catalog): Catalog {
  if (availability.size === 0) return catalog
  const models: Record<string, ModelInfo> = {}
  for (const [id, info] of Object.entries(catalog.models)) {
    const status = availability.get(id)
    models[id] = status ? { ...info, status } : info
  }
  return { ...catalog, models }
}

// ---- lookups -----------------------------------------------------------------

/** The model behind an id, or undefined when the catalog has never heard of it. */
export function modelInfo(id: string): ModelInfo | undefined {
  return current.models[id]
}

/**
 * The reasoning levels a model accepts, as a dial should walk them.
 *
 * Always starts at `off`, because `off` is the only level we can honour for
 * every model: it sends nothing. A model we know nothing about gets the
 * conservative default set, so a session started offline still has a working
 * dial; it is a guess, and `modelInfo()` being undefined is how callers can tell.
 */
export function reasoningLevelsFor(id: string): ReasoningEffort[] {
  const info = modelInfo(id)
  if (!info) return ['off', 'low', 'medium', 'high']
  if (info.reasoningMode === 'effort') return ['off', ...info.reasoningEfforts]
  if (info.reasoningMode === 'toggle') return ['off', 'high']
  return ['off']
}

/**
 * Clamp a level to what a model accepts.
 *
 * A level that is not in the model's vocabulary is dropped to `off` rather than
 * sent and rejected: the alternative is a 400 on the first round of a session
 * the user did nothing wrong in.
 */
export function clampReasoning(id: string, level: ReasoningEffort): ReasoningEffort {
  const levels = reasoningLevelsFor(id)
  return levels.includes(level) ? level : 'off'
}

/** The context window, or the conservative default when the catalog is silent. */
export function contextLimitFor(id: string): number {
  const info = modelInfo(id)
  if (info && info.context > 0) return info.context
  return UNKNOWN_CONTEXT
}

/**
 * A short hint for a picker row: the three facts that decide a choice.
 *
 * Separate from `describeModel` because the two live in different widths — this
 * goes beside a model id in a list, that one is a full line in `/model`.
 */
export function modelHint(info: ModelInfo): string {
  const reasoning =
    info.reasoningMode === 'effort'
      ? `reasoning ${info.reasoningEfforts.join('/')}`
      : info.reasoningMode === 'none'
        ? 'no reasoning'
        : `reasoning ${info.reasoningMode}`
  const price = info.cost.input === 0 && info.cost.output === 0 ? 'free' : `$${info.cost.input}/$${info.cost.output}`
  return `${formatTokens(info.context)} ctx · ${reasoning} · ${price}`
}

/** One line for a picker: id, then the facts that decide a choice. */
export function describeModel(info: ModelInfo): string {
  const parts = [info.id]
  parts.push(info.reasoningMode === 'effort' ? `reasoning ${info.reasoningEfforts.join('/')}` : info.reasoningMode === 'none' ? 'no reasoning' : `reasoning ${info.reasoningMode}`)
  parts.push(`${formatTokens(info.context)} ctx`)
  parts.push(info.cost.input === 0 && info.cost.output === 0 ? 'free' : `$${info.cost.input}/$${info.cost.output} per Mtok`)
  if (info.status === 'unavailable') parts.push('unavailable')
  if (!info.toolCall) parts.push('no tools')
  return parts.join('  ·  ')
}

/** A block of lines for `/models <id>`: everything the catalog knows. */
export function detailModel(info: ModelInfo): string[] {
  const lines = [
    `${info.name} (${info.id})`,
    ...(info.description ? [info.description] : []),
    `status      ${info.status}${info.statusDetail ? ` — ${info.statusDetail}` : ''}`,
    `context     ${formatTokens(info.context)} in, ${formatTokens(info.output)} out`,
    `reasoning   ${
      info.reasoningMode === 'none'
        ? 'not supported'
        : info.reasoningMode === 'effort'
          ? `effort: ${info.reasoningEfforts.join(', ')}`
          : info.reasoningMode
    }`,
    `price       $${info.cost.input}/$${info.cost.output}/$${info.cost.cacheRead} per Mtok (in/out/cache read)`,
    `modalities  in: ${info.modalities.input.join(', ') || 'unknown'} · out: ${info.modalities.output.join(', ') || 'unknown'}`,
    `tools       ${info.toolCall ? 'yes' : 'no'}${info.structuredOutput ? ' · structured output' : ''}${info.attachment ? ' · attachments' : ''}${info.temperature ? ' · temperature' : ''}`,
    ...(info.releaseDate ? [`released    ${info.releaseDate}`] : []),
  ]
  return lines
}

/** `1_048_576` → `1.0M`. Compact, because these go in a 42-cell sidebar. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return String(n)
}

/**
 * Every model in the catalog, for a picker.
 *
 * Models this key cannot reach are left out unless the caller asks for them: a
 * choice that fails on the first request is worse than no choice. Status is
 * `unknown` for a machine with no key or a failed listing, and `unknown` is
 * kept — "we could not check" is not "no".
 *
 * Priced models before free ones, then alphabetically inside each band: the
 * common case is "pick something good", and sorting a mixed list by id puts the
 * free models in the middle of it.
 */
export function listModels(options: { includeUnavailable?: boolean } = {}): ModelInfo[] {
  return Object.values(current.models)
    .filter(info => options.includeUnavailable === true || info.status !== 'unavailable')
    .sort((a, b) => {
      const freeA = a.cost.input === 0 && a.cost.output === 0 ? 0 : 1
      const freeB = b.cost.input === 0 && b.cost.output === 0 ? 0 : 1
      if (freeA !== freeB) return freeA - freeB
      return a.id.localeCompare(b.id)
    })
}

/** The catalog's own idea of which models are reachable at all. */
export function hasCatalog(): boolean {
  return Object.keys(current.models).length > 0
}

/**
 * The subset of a model that crosses to the screen.
 *
 * Not `ModelInfo`: this object is JSON-serialised into every snapshot the store
 * publishes, several times a second during a stream, and a snapshot carrying a
 * description and a modalities list nobody draws is bytes on a pipe for
 * nothing. What the screen actually reads is the dial, the window, the price
 * and the status.
 */
export interface ModelView {
  id: string
  name: string
  /** Context window in tokens; the meter measures against this. */
  context: number
  reasoning: boolean
  reasoningMode: ReasoningMode
  /** Effort levels to offer, `off` first. */
  levels: ReasoningEffort[]
  cost: { input: number; output: number; cacheRead: number }
  status: ModelStatus
  statusDetail?: string
  toolCall: boolean
  description?: string
}

/** A screen-shaped view of a model, or null when the catalog has no facts. */
export function modelView(id: string): ModelView | null {
  const info = modelInfo(id)
  if (!info) return null
  return {
    id: info.id,
    name: info.name,
    context: info.context,
    reasoning: info.reasoning,
    reasoningMode: info.reasoningMode,
    levels: reasoningLevelsFor(id),
    cost: info.cost,
    status: info.status,
    ...(info.statusDetail ? { statusDetail: info.statusDetail } : {}),
    toolCall: info.toolCall,
    ...(info.description ? { description: info.description } : {}),
  }
}

// ---- live status -------------------------------------------------------------

/**
 * Ask the gateway which models this key can reach, right now.
 *
 * The listing is the only source that knows about a model retired an hour ago,
 * a model disabled for this workspace, or a key without access to the paid tier.
 * Models.dev cannot know any of that, so a capability with no listing behind it
 * is marked `unavailable` rather than shown as a choice.
 *
 * A failed listing marks everything `unknown` and says why: a network blip must
 * not empty the picker.
 */
export async function refreshModelStatus(
  apiKey: string | undefined,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<Map<string, ModelStatus>> {
  const next = new Map<string, ModelStatus>()
  const reasons: string[] = []
  if (!apiKey?.trim()) {
    // No key: the gateway would answer, but a 401 for every provider tells us
    // nothing except that the key is missing, which the UI already knows.
    for (const info of Object.values(current.models)) {
      next.set(info.id, 'unknown')
    }
    applyStatus(next, 'no OPENCODE_API_KEY — availability unchecked')
    return next
  }
  for (const [prefix, url] of Object.entries(LISTING_URLS)) {
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      })
      if (!response.ok) {
        reasons.push(`${prefix}: HTTP ${response.status}`)
        for (const id of Object.keys(current.models)) {
          if (id.startsWith(`${prefix}/`)) next.set(id, 'unknown')
        }
        continue
      }
      const payload = (await response.json()) as { data?: { id?: string }[] }
      const listed = new Set(asArray((payload.data ?? []).map(entry => entry?.id)))
      for (const id of Object.keys(current.models)) {
        if (!id.startsWith(`${prefix}/`)) continue
        next.set(id, listed.has(id.slice(prefix.length + 1)) ? 'available' : 'unavailable')
      }
    } catch (error) {
      reasons.push(`${prefix}: ${error instanceof Error ? error.message : String(error)}`)
      for (const id of Object.keys(current.models)) {
        if (id.startsWith(`${prefix}/`)) next.set(id, 'unknown')
      }
    }
  }
  applyStatus(next, reasons.length > 0 ? `listing failed — ${reasons.join('; ')}` : 'checked against the gateway just now')
  return next
}

function applyStatus(next: Map<string, ModelStatus>, detail: string): void {
  availability = next
  const models: Record<string, ModelInfo> = {}
  for (const [id, info] of Object.entries(current.models)) {
    const status = next.get(id)
    models[id] = {
      ...info,
      status: status ?? info.status,
      statusDetail: status === 'unknown' || status === 'unavailable' ? detail : undefined,
    }
  }
  current = { ...current, models }
}
