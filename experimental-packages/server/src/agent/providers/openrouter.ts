// OpenRouter provider — the default gateway.
//
// Everything but the base URL lives in OpenAiCompatibleProvider; the same
// class serves any OpenAI-compatible endpoint (a self-hosted gateway,
// Ollama, together.ai) via OPENROUTER_BASE_URL.

import { OpenAiCompatibleProvider } from './openai-compatible.js'

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'

export class OpenRouterProvider extends OpenAiCompatibleProvider {
  constructor(baseURL: string = OPENROUTER_BASE_URL) {
    super('openrouter', baseURL)
  }
}
