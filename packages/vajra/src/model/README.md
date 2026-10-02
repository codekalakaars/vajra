# model

Talking to the model, and what it costs.

| File | What |
|------|------|
| `chat.ts` | Streaming chat completions against OpenCode Zen, with abort and timeout |
| `catalog.ts` | The model list and each model's window and reasoning levels (cached in `~/.vajra/models.json`) |
| `budget.ts` | How full a model's window is; chars-per-token calibrated from the provider's counts |
| `compress.ts` | Trims a conversation to the window, oldest exchanges first, keeping the task message |
| `context-window.ts` | A model's window size |
| `tool-dispatch.ts` | Runs one tool call and reports it; budget and heartbeat helpers |
| `auth.ts`, `home.ts` | The API key (`~/.vajra/auth.json`, mode 0600) and the `~/.vajra` home |
