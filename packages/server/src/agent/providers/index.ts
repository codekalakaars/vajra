// Provider factory — instantiate the right ChatProvider from a model string.
//
// Model strings follow the pattern "provider/model-name":
//   - "openrouter/claude-3.5-sonnet" → OpenRouterProvider
//   - "anthropic/claude-sonnet-4-20250514" → AnthropicProvider
//
// A bare model name (no slash) defaults to OpenRouter for backwards compat.

import type { ChatProvider } from './types.js'
import { OpenRouterProvider } from './openrouter.js'
import { AnthropicProvider } from './anthropic.js'
import { ZenProvider } from './zen.js'
import { componentLogger } from '../../logger.js'

const log = componentLogger('providers')

const ZEN_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

const providers = new Map<string, () => ChatProvider>([
  ['openrouter', () => new OpenRouterProvider()],
  ['anthropic', () => new AnthropicProvider()],
  ['zen', () => new ZenProvider()],
  ['go', () => new ZenProvider(ZEN_GO_BASE_URL)],
])

// Known models per provider (lowercase). Used for validation.
const knownModels = new Map<string, Set<string>>([
  ['anthropic', new Set([
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
    'claude-3-haiku-20240307',
  ])],
  ['openrouter', new Set()], // OpenRouter proxies many models; skip validation
  ['zen', new Set([
    // Free models
    'deepseek-v4-flash-free', 'mimo-v2.5-free', 'nemotron-3-ultra-free',
    'nemotron-3.5-lightning-free', 'nemotron-3-super-free', 'ling-3.0-flash-fin-free',
    'muse-spark-1.3-contributor-free',
    // Paid models
    'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
    'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2', 'gpt-5.2-codex',
    'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
    'gpt-5', 'gpt-5-codex', 'gpt-5-nano',
    'claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', 'claude-opus-4.5',
    'claude-sonnet-5', 'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-haiku-4.5',
    'deepseek-v4-pro', 'deepseek-v4-flash',
    'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3',
    'big-pickle', 'glm-5.2', 'glm-5.1', 'glm-5',
    'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
    'mimo-v2.5',
  ])],
  ['go', new Set([
    'mimo-v2.5', 'mimo-v2.5-pro',
    'deepseek-v4-pro', 'deepseek-v4-flash',
    'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6',
    'minimax-m3', 'minimax-m2.7',
    'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1',
    'gpt-5.6-luna', 'grok-4.5', 'grok-4.6',
  ])],
])

/**
 * Parse a model string and return the provider name and raw model name.
 * "openrouter/claude-3.5-sonnet" → { provider: "openrouter", model: "claude-3.5-sonnet" }
 * "openrouter/free" → { provider: "openrouter", model: "openrouter/free" }
 * "nvidia/nemotron-3-ultra-550b-a55b:free" → { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" }
 * "claude-3.5-sonnet" → { provider: "openrouter", model: "claude-3.5-sonnet" }
 */
export function parseModelString(model: string): { provider: string; model: string } {
  // Check if it starts with a known provider prefix
  if (model.startsWith('openrouter/')) {
    const afterPrefix = model.slice('openrouter/'.length)
    // Special OpenRouter meta-models (free, auto, auto-beta) need the full slug
    if (afterPrefix === 'free' || afterPrefix === 'auto' || afterPrefix === 'auto-beta') {
      return { provider: 'openrouter', model }
    }
    return { provider: 'openrouter', model: afterPrefix }
  }
  if (model.startsWith('anthropic/')) {
    return { provider: 'anthropic', model: model.slice('anthropic/'.length) }
  }
  if (model.startsWith('zen/')) {
    return { provider: 'zen', model: model.slice('zen/'.length) }
  }
  if (model.startsWith('go/')) {
    return { provider: 'go', model: model.slice('go/'.length) }
  }
  // No known prefix — default to openrouter (handles bare model names and
  // OpenRouter-style model IDs like "nvidia/nemotron-3-ultra-550b-a55b:free")
  return { provider: 'openrouter', model }
}

/**
 * Validate that a model is known for the given provider.
 * Returns an error message if invalid, or null if valid / validation skipped.
 */
export function validateModel(providerName: string, modelName: string): string | null {
  const models = knownModels.get(providerName)
  if (!models || models.size === 0) return null // No validation list = accept anything
  if (models.has(modelName.toLowerCase())) return null
  return `Unknown model '${modelName}' for provider '${providerName}'. Known models: ${[...models].join(', ')}`
}

/**
 * Create a ChatProvider from a model string and a map of API keys.
 * The API key for the correct provider is selected based on the model prefix.
 * Falls back to "openrouter" key if provider-specific key is not found.
 */
export function createProvider(
  model: string,
  apiKeys: Record<string, string>,
): { provider: ChatProvider; resolvedModel: string; apiKey: string } {
  const { provider: providerName, model: resolvedModel } = parseModelString(model)
  const factory = providers.get(providerName)
  if (!factory) {
    throw new Error(
      `Unknown provider '${providerName}' in model '${model}'. ` +
      `Available providers: ${[...providers.keys()].join(', ')}`
    )
  }
  // Route API key: try provider-specific key first, fall back to "openrouter"
  const apiKey = apiKeys[providerName] ?? apiKeys['openrouter'] ?? ''
  if (!apiKey) {
    throw new Error(
      `No API key found for provider '${providerName}'. ` +
      `Set ${providerName.toUpperCase()}_API_KEY environment variable.`
    )
  }
  // Validate model (warn but don't fail — OpenRouter proxies many models)
  const validationError = validateModel(providerName, resolvedModel)
  if (validationError) {
    log.warn({ provider: providerName, model: resolvedModel }, validationError)
  }
  // The key travels with the provider: picking one from the map separately —
  // as the RPC handlers used to — sends whichever key enumerated first to
  // whichever provider the project actually uses.
  return { provider: factory(), resolvedModel, apiKey }
}

/** Register a custom provider (for plugins or tests). */
export function registerProvider(name: string, factory: () => ChatProvider): void {
  providers.set(name, factory)
}

/** Register a known model for validation. */
export function registerModel(providerName: string, modelName: string): void {
  let models = knownModels.get(providerName)
  if (!models) {
    models = new Set()
    knownModels.set(providerName, models)
  }
  models.add(modelName.toLowerCase())
}
