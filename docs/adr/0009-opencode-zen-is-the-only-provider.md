# ADR-0009: OpenCode Zen Is the Only LLM Provider

## Status

Accepted

## Date

2026-09-28

## Context

The agent needs a chat completions endpoint. Two questions follow from that, and they are usually answered together even though they are separable:

1. Which provider, and how is one selected?
2. Where does the credential live, and what is it called?

The second question has a security dimension the first does not. The credential is the one piece of state that must never reach a project directory, so its storage and its naming are decisions about exposure, not plumbing.

Three shapes were available:

- **One provider, wired in.** A base URL, a model-id namespace, one credential name. A second provider later is a contained change.
- **A provider abstraction now.** A provider interface, a registry, a credential record keyed by provider, and configuration to choose between them — written before there is a second provider to choose.

The CLI already exists and already runs sessions, so this is a decision about a shipped surface rather than an empty one.

## Decision

**Vajra talks to OpenCode Zen and nothing else.** Model ids are `zen/*` and `go/*`; any other id is refused at session start. Both prefixes are served by the same service and share one credential.

The credential is a single string named `OPENCODE_API_KEY`, resolved in this order:

1. `--api-key` on the command line — this process only, never written to disk
2. `OPENCODE_API_KEY` in the environment
3. `OPENCODE_API_KEY` in `~/.vajra/auth.json`, mode `0600`

The `openai` SDK is used directly against the gateway's OpenAI-compatible endpoints rather than wrapped in a client abstraction. The provider surface is kept at its thinnest useful shape: a base URL per prefix, a prefix check, and a listing URL used to decide reachability.

`vajra config` refuses any key name containing `KEY`, so the non-secret defaults file cannot become the secret one by accident.

## Consequences

**Positive**

- One credential to store, one file to protect, one error to write.
- Reachability is a real answer rather than an assumption: the gateway's own `/models` listing says what this key can actually use, and `/model` offers only that.
- The capability table — context windows, reasoning levels, prices — is answered by one vendor's data instead of being reconciled across several.
- Nothing outside the provider surface was built for a provider that does not exist. A second provider does not require unwrapping a client.

**Negative**

- A user whose models are hosted elsewhere cannot use Vajra at all. There is no provider setting, and no fallback.
- A credential named for one vendor is a small ongoing cost: every future provider with a differently-named key forces the shape in `auth.json` to change.
- The model catalog is filtered to providers this build can reach, so the UI is honest about the restriction but also narrower than it could be.

**Neutral**

- `zen/*` and `go/*` are two endpoints on one service, not two providers. They share a key and will continue to.

## Open Questions

- **How are credentials stored once there are two providers?** `auth.json` is currently one provider-named string. With a second provider it needs either per-provider fields or a small record with a `provider` key. This is deliberately undecided: choosing now, for a provider that does not exist, would be guessing, and the choice is cheap to make later because only one file and one resolver are involved.
- **Should the credential move to an OS keychain?** A `0600` file inside a `0700` directory is a defensible answer on every platform Vajra ships on — it is the only one. A keychain integration is a dependency for one secret, and becomes more obviously worth it if the second provider lands first.
- **Is the `openai` SDK the right dependency, or should the wire types be ours?** Compatible-dialect portability is currently a side effect of someone else's client rather than a property we hold.

## See Also

- [LLM Providers](../runtime/llm-providers.md) — the surface as implemented
- [State on Disk](../runtime/state.md) — where the credential is written
- [Coverage Gaps](../testing/gaps.md) — the credential path is not yet tested end to end
- [Roadmap](../roadmap/README.md)
