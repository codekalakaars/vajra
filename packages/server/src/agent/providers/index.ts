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

const providers = new Map<string, () => ChatProvider>([
  ['openrouter', () => new OpenRouterProvider()],
  ['anthropic', () => new AnthropicProvider()],
])

/**
 * Parse a model string and return the provider name and raw model name.
 * "openrouter/claude-3.5-sonnet" → { provider: "openrouter", model: "claude-3.5-sonnet" }
 * "claude-3.5-sonnet" → { provider: "openrouter", model: "claude-3.5-sonnet" }
 */
export function parseModelString(model: string): { provider: string; model: string } {
  const slashIdx = model.indexOf('/')
  if (slashIdx === -1) {
    return { provider: 'openrouter', model }
  }
  return {
    provider: model.slice(0, slashIdx),
    model: model.slice(slashIdx + 1),
  }
}

/**
 * Create a ChatProvider from a model string and API key.
 * The API key is routed to the correct provider based on the model prefix.
 */
export function createProvider(model: string, apiKey: string): { provider: ChatProvider; resolvedModel: string } {
  const { provider: providerName, model: resolvedModel } = parseModelString(model)
  const factory = providers.get(providerName)
  if (!factory) {
    throw new Error(
      `Unknown provider '${providerName}' in model '${model}'. ` +
      `Available providers: ${[...providers.keys()].join(', ')}`
    )
  }
  return { provider: factory(), resolvedModel }
}

/** Register a custom provider (for plugins or tests). */
export function registerProvider(name: string, factory: () => ChatProvider): void {
  providers.set(name, factory)
}
