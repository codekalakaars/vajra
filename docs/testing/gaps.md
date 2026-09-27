# Coverage Gaps

## Purpose

This document records what the testing system **cannot** test, and why. It is the honest counterpart to [Testing](README.md): a list of blind spots, each with the failure mode it produces and whether it is fixable, deferred, or out of scope.

## Table of Contents

- [How to Read This](#how-to-read-this)
- [Cannot Test](#cannot-test)
- [Can Test but Cannot Trust](#can-test-but-cannot-trust)
- [Cannot Test, and Pre-Release TODOs](#cannot-test-and-pre-release-todos)
- [Fixed During This Work](#fixed-during-this-work)
- [Deliberately Out of Scope](#deliberately-out-of-scope)

## How to Read This

Each gap names the failure mode, not just the absence. A gap that produces a **false pass** is far more dangerous than one that produces a false failure: a false failure costs an escalation round trip, while a false pass means the system believes work is verified when it is not.

Gaps are marked:

| Mark | Meaning |
|------|---------|
| **Silent** | Can report success while the thing is untested or broken. Fix first. |
| **Loud** | Fails or errors visibly. Costs time, not correctness. |
| **Blind** | Not represented in the model at all, so nothing reports it. |

## Cannot Test

### 1. Side effects the response does not describe — **Silent, highest severity**

A probe asserts on the HTTP response. It cannot see whether the write reached the database, whether the email was sent, whether the message was published to the queue, or whether a file was written outside the task's declared scope.

A handler that returns `201` while the transaction rolled back passes every probe. This is the largest gap in the system, and it is structural rather than a missing feature: the response is genuinely not evidence about the side effect.

**Mitigation available today:** make the effect observable. A probe can assert on a subsequent `GET` that would only be correct if the write landed. That covers read-after-write but not email, queueing, or third-party calls.

### 2. Non-HTTP protocols — **Blind**

`grpc`, `process` and `wasi` target kinds exist in the type system, and gRPC-over-HTTP/2 is not HTTP/1.1, so nothing exercises them. Missing entirely: gRPC, GraphQL subscriptions, WebSocket and SSE, message queues (Kafka, RabbitMQ, SQS, SNS), raw TCP and UDP.

GraphQL over plain HTTP partly works as an ordinary POST probe. Streaming does not, because the expectation model is one request to one response.

### 3. Streaming and long-lived connections — **Blind**

`Expectation` is a single response snapshot. Anything whose result is a *sequence* — a SSE stream, a WebSocket dialogue, a chunked upload, a paginated crawl — has no representation. `latencyMs` bounds a single exchange and says nothing about a stream that stalls halfway.

### 4. Performance and load — **Loud but shallow**

Only `latencyMs` as a single upper bound exists. There is no concurrency, throughput, soak, or resource measurement. A service that takes 900ms under one sequential client and 40s under ten concurrent clients passes.

### 5. Browser and UI behaviour — **Blind**

No DOM, no rendering, no client-side runtime. Frontend work needs a browser driver, which is a different system.

### 6. Static analysis, types and lint — **Loud, reachable indirectly**

`tsc --noEmit`, `cargo clippy`, `ruff` and equivalents are not modelled as criteria. They are reachable today only by wrapping one in a command runner, which works but forfeits the per-criterion verdict. Worth promoting to a first-class criterion type, since a type error is the cheapest possible failure to detect.

### 7. Database migrations and schema state — **Blind**

Nothing verifies that a migration ran, is reversible, or leaves the schema in the state the code expects. A task can pass every probe against a stale schema.

### 8. Cross-task interference in shared state — **Silent**

File ownership prevents two Workers writing the same file. Nothing prevents two Workers mutating the same database rows, the same cache keys, or the same queue. Two Phase One probes that each create the same fixture can collide, and the resulting failure looks like a flaky test rather than a conflict.

## Can Test but Cannot Trust

### 9. Unmodelled dependencies — **Silent, now mitigated**

A language whose specifiers are package paths rather than relative paths (Go, JVM) cannot always be resolved to a file. An unresolved edge is indistinguishable from no edge, so a change could select nothing and look clean.

This is now tracked: `buildModuleGraph` records unresolvable in-tree imports and widens their selection to the whole suite, and `internalPrefixes` lets a caller declare module paths in-tree. Residual risk remains where a module path cannot be declared and the layout is non-standard.

### 10. Generated and dynamic dependencies — **Silent, partially mitigated**

Reflection, dependency-injection containers, `eval`, plugin registries, and code generation produce dependencies no static graph can see. In JavaScript the regex extractor misses computed imports; in JVM code, annotations and DI are invisible.

Mitigation is `unmodelled`, but it is a declaration, not a detection: a dynamic dependency that is never declared stays invisible.

### 11. TAP-sourced verdicts — **Loud, recorded**

TAP has one `not ok` for both a failed assertion and a test that could not run. A Phase One gate can therefore be *assumed* from a TAP report but not *proven*. JUnit XML carries the distinction and should be preferred.

### 12. Time, randomness and external services — **Loud**

Anything depending on the clock, a random seed, a network call to a third party, or a shared fixture is a flake source. The rerun-based detector catches instability but does not remove it, and a test that passes on rerun reports `flaky`, which never satisfies a task — correctly, but at the cost of a round trip every time.

### 13. Oracle strength for generated probes — **Silent, by design**

Contract-derived probes assert response *shape*, never semantics. A schema cannot express "a valid password is 8+ characters". Generated probes prove the endpoint answers correctly-shaped; they do not prove it is *right*. A green contract suite is weak evidence of correctness and should not be read as strong.

## Cannot Test, and Pre-Release TODOs

Items here are things the harness cannot reach *and* that are not yet verified another way. They are separated from the numbered gaps because they are owed before a release rather than merely absent.

### 14. LLM provider reachability and the credential path — **Blind**

A session cannot be verified without a model to verify it against, so the entire path from credential to first response is outside what the harness can assert. The probe system can call an HTTP endpoint; it cannot supply a real secret, cannot judge whether the key is the right one, and cannot tell a rejected key from a reachable provider that had nothing to say.

Concretely, none of this is covered end to end: `vajra auth login` writing `~/.vajra/auth.json` and the file actually being `0600`; the precedence order (`--api-key`, environment, `auth.json`) asserted as a whole rather than per function; `vajra auth logout` leaving a session that correctly refuses to start; a key written *while a session is open* being picked up by the live gate; a rejected key producing a reported failure rather than a retry loop; and the credential appearing in no transcript, session row, index file or log line.

The first and last of those are cheap and worth doing regardless of any provider: assert the mode of `auth.json` after a login, and assert the key string is absent from every file under the state directory.

**This is a pre-release TODO, not a permanent gap.** The gate and the credential resolver have unit tests; what is missing is the end-to-end path against the real gateway, which needs a real key and a real session.

**Assumption:** the credential path is the only place where a bug is both silent and total — a session that starts with the wrong key fails everywhere at once, and nothing upstream reports it. That asymmetry is why it is listed ahead of the smaller items rather than with them.

## Fixed Since the Last Revision

| Gap | Was | Fix |
|-----|-----|-----|
| **API route changes verified nothing** | Probes are selected by import graph, and a route file is not imported by anything — it *defines* the thing being tested. Changing `GET /users` selected zero probes, and selecting zero looks exactly like nothing being affected. | `src/route.ts` indexes routes the other way: files that define a route map to the probes that exercise it. Param spellings (`:id`, `<int:id>`, `{id}`) normalise so a cross-framework plan compares equal. |
| **Route method ignored during selection** | A file defining `POST /x` was treated as determining what `DELETE /x` returns, so the wrong endpoint got verified. | Overlap is method-aware; `ANY` still matches everything, since a handler registered for all methods does determine all of them. |
| **Mount points invisible** | `app.use('/api', router)` was not recognised, so changing a base path selected nothing beneath it. | A `mount` rule treats a prefix as affecting every route under it. |
| **Choosing a runner was guesswork** | Four runner factories, and the caller had to know which to reach for and hand-wire the registry. | `createSurfaceRunner` resolves a surface name to a runner; `checkPlan` refuses a plan whose prerequisites are absent, at submission rather than after a build. |
| **An unimplemented surface reported as a missing prerequisite** | Asking for the `data` surface said "you need a database", sending the reader after the wrong thing. | A surface this package cannot build is reported `unsupported` regardless of what infrastructure is available. |

## Fixed During This Work

Recorded because they were live defects in code written earlier in this project, not hypothetical gaps.

| Gap | Was | Fix |
|------|-----|-----|
| **Authenticated APIs** | Probes were independent, so no probe could use a token from an earlier one. An API with auth was untestable without hard-coding an expiring credential. | `dependsOn` plus `capture`; probes order topologically and share a variable bag. Selecting a dependent probe pulls in its prerequisites. |
| **Unmodelled dependencies** | `unmodelled()` existed with no call sites — dead code. Unresolvable imports were silently dropped. | Enforced in `buildModuleGraph`; unresolvable in-tree imports widen selection to the whole suite. |
| **`port: 0`** | Treated as a literal port, so the harness dialled port 0 and every probe reported "no response". Masked by tests that always set an explicit port. | `0` now means OS-assigned. |
| **Non-JS selection** | Only a JavaScript-shaped regex, so a Python, Rust, Go or Java change selected no tests — and selecting nothing looks exactly like nothing being affected. | Per-language specs for JavaScript, Python, Rust, Go, Java, Ruby and C#. |
| **Runner selector vs target** | A probe's selector (`login`) and the thing it exercises (`POST /login`) were conflated, so "did the runner run what I asked for?" checked the wrong field. | `ref` and `target.ref` are now separate fields. |
| **Unbounded teardown** | `stop()` awaited process exit after `SIGKILL` with no bound; an unkillable process would hang the Manager's loop forever. | Bounded at both signals. |

## Deliberately Out of Scope

Not gaps to close, but boundaries worth stating so they are not mistaken for oversights.

- **Adversarial agents.** The security model assumes fallible agents, not malicious ones. See [Security Model](../permissions/security-model.md#threat-model).
- **Proving absence.** No system can show that no test is missing. Contract derivation narrows the space; it does not close it.
- **Judging intent.** A test can show an endpoint returns the right shape. Whether that is the *right* endpoint is a Human decision.
