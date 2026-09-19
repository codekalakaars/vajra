// OpenCode Zen provider — OpenCode's curated model gateway.
//
// Same OpenAI-compatible API as OpenRouter, different base URL and auth key
// (OPENCODE_API_KEY), so it shares OpenAiCompatibleProvider.

import { OpenAiCompatibleProvider } from './openai-compatible.js'

export const ZEN_BASE_URL = process.env.ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1'
export const ZEN_GO_BASE_URL = process.env.ZEN_GO_BASE_URL ?? 'https://opencode.ai/zen/go/v1'

export class ZenProvider extends OpenAiCompatibleProvider {
  constructor(baseURL: string = ZEN_BASE_URL) {
    super('zen', baseURL)
  }
}
