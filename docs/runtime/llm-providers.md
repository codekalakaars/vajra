# LLM Providers

## Purpose

Vajra talks to exactly one LLM provider today: OpenCode Zen. This document says
what that means in practice — which endpoints, which model ids, which
credential — and what adding a second provider would actually involve, so the
"only one for now" is a decision with a visible cost rather than a missing
feature nobody has looked at.

**Scope:** this documents the shipped `vajra` CLI in `packages/cli`. The rest of
this directory describes the harness runtime as designed.

## Table of Contents

- [Status](#status)
- [What "OpenCode Zen" means on the wire](#what-opencode-zen-means-on-the-wire)
- [Model ids](#model-ids)
- [The credential](#the-credential)
- [How a key is resolved](#how-a-key-is-resolved)
- [What happens with no key](#what-happens-with-no-key)
- [Capability data](#capability-data)
- [Adding a second provider](#adding-a-second-provider)
- [What does not change](#what-does-not-change)
- [Not tested yet](#not-tested-yet)

## Status

**Vajra supports one LLM provider: OpenCode Zen.** Every model id the CLI will
accept begins with `zen/` or `go/`, both of which are served by OpenCode Zen.
There is no provider setting, no provider plugin, and no fallback: an
unrecognised model is refused before a session starts.

This is a scope decision, not an architectural limit. The provider surface is
thin — a base URL, a prefix check, and one credential — and it was kept thin so
that adding the next one is a contained change. `TODO` — the second provider is
planned; see [../roadmap/README.md](../roadmap/README.md).

The decision itself, and why the credential is a single provider-agnostic
string rather than a per-provider record, is recorded in
[../adr/0009-opencode-zen-is-the-only-provider.md](../adr/0009-opencode-zen-is-the-only-provider.md).

## What "OpenCode Zen" means on the wire

| | |
| --- | --- |
| Endpoints | `https://opencode.ai/zen/v1` (`zen/*`), `https://opencode.ai/zen/go/v1` (`go/*`) |
| Protocol | OpenAI-compatible chat completions |
| Client | the `openai` SDK, pointed at the endpoint with `baseURL` (`src/agent/chat.ts:106`) |
| Retries | off in the SDK; Vajra does its own, 5 attempts with exponential backoff to 30s (`chat.ts:89-92`) |
| Request timeout | 120s |
| Session header | every request carries `x-opencode-session: vajra-cli-<random>` so gateway-side logs can be correlated with a Vajra run |

Two prefixes rather than one is a gateway routing detail, not two providers:
`zen/*` and `go/*` are different endpoints on the same service and share one
key.

## Model ids

The id is the routing key, not a label. `zen/foo` and `go/foo` are two different
requests, and the prefix decides both the endpoint and which name is stripped
before the id goes on the wire. `isSupportedModel` accepts a model only if it
starts with `zen/` or `go/` (`src/env.ts`); `resolveBaseURL` throws for anything
else (`chat.ts:92`).

## The credential

One credential, named `OPENCODE_API_KEY`, stored as plain text in
`~/.vajra/auth.json` at mode `0600`. There is no OS keychain integration — see
[state.md](state.md#what-is-deliberately-not-there).

It is written and cleared by:

```
vajra auth login <key>     # writes auth.json, 0600
vajra auth status          # prints the key masked, and where it came from
vajra auth logout          # writes {} — does not delete the file
```

## How a key is resolved

In precedence order, first match wins:

1. `--api-key <key>` on the command line — for this process only, never written
2. `OPENCODE_API_KEY` in the environment
3. `OPENCODE_API_KEY` in `~/.vajra/auth.json`

The CLI refuses to put a secret in `config.json`; `vajra config -s` rejects any
key name containing `KEY`, so the non-secret file cannot become the secret one
by accident.

Inside the TUI, an explicit `--api-key` is re-applied after every `/model`
change, because changing the model re-resolves the key and a user who passed a
flag did not mean to lose it.

## What happens with no key

The screen starts anyway. With no credential, both front-ends open a gate
instead of a task prompt:

```
No API key configured — vajra cannot reach the model gateway yet.
Set one with 'vajra auth login <key>' or 'export OPENCODE_API_KEY=…'.
This screen picks it up on its own; a task typed now is held until then.

⚡ Waiting for an API key — see the transcript above
```

A task typed at that prompt is held rather than discarded, and the gate watches
for a key (once a second) so that setting one from another terminal moves the
session on by itself. `exit` or `/quit` at the gate leaves cleanly, as does a
second Ctrl-C.

The gate exists because a session with no key cannot start. Without it the user
typed a task, watched it bounce, and was told why only afterwards.

## Capability data

Two sources, both best-effort, both cached in `~/.vajra/models.json` for twelve
hours:

- `https://models.dev/api.json` — the whole provider table, so context windows,
  reasoning levels and prices are known even for a model this key cannot reach
- the gateway's own `/models` listing — which of those the credential can
  actually use, which is what `/model` offers

A session never blocks on either. Every capability has a defined answer for "not
known yet" (a conservative context window, four reasoning levels), and the
screen repaints with the real numbers when the fetch lands.

## Adding a second provider

The work is contained because the provider surface is small. In order:

1. **A base URL per provider.** `resolveBaseURL` in `src/agent/chat.ts` becomes
   a table lookup instead of two branches.
2. **A model-id namespace.** Each provider gets a prefix, and the same
   `isSupportedModel` check admits it. The prefix must not collide with `zen/`
   or `go/`, and stripping it is already a per-prefix step.
3. **A credential.** The open question. Today one string named
   `OPENCODE_API_KEY` covers both prefixes; a second provider with a different
   key name needs either per-provider fields in `auth.json` or a small
   credential record with a `provider` key. Resolving this is the first thing to
   decide — see the open question in
   [the ADR](../adr/0009-opencode-zen-is-the-only-provider.md).
4. **A listing URL per provider**, so reachability is still "what this key can
   actually use" rather than "what the vendor published".
5. **The catalog's model filter.** `models.dev` publishes every provider; the
   code already narrows to the ones it can reach, and that list grows by one
   entry.

Nothing in the agent, the tool layer, the sandbox, the session store or the
front-ends is provider-shaped. A plan, a tool call and a transcript look the
same whichever endpoint produced them.

**Assumption:** the above is the shape the change is expected to take, derived
from reading the current call sites. It has not been prototyped, and step 3 in
particular is a design decision rather than an implementation detail.

## What does not change

Worth stating explicitly, because "one provider" reads like a limitation
somewhere in the middle of the system and is not:

- The session store, the SQLite schema and resume
- The tool surface, the evidence ledger, plan validation
- The sandbox and its permission model
- The front-ends. A snapshot carries a model id and a set of capability facts,
  not a provider.

## Not tested yet

The key configuration path — `vajra auth login`, the precedence rules, the gate,
and the write mode of `auth.json` — has not been exercised end to end against
the real gateway as a test. It is verified by hand and by unit tests around the
gate, and the rest is `TODO`.

See [../testing/gaps.md](../testing/gaps.md).

## See also

- [state.md](state.md) — where the key is stored
- [../adr/0009-opencode-zen-is-the-only-provider.md](../adr/0009-opencode-zen-is-the-only-provider.md) — the decision
- [../testing/gaps.md](../testing/gaps.md) — the untested path
