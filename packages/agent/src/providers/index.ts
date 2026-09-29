/**
 * The model-client interface's adapters.
 *
 * Declared now so the package's export map is complete before any lane needs
 * it: a subpath added later would be a package.json edit, and package.json is
 * owned by exactly one lane. Add exports there only when a lane genuinely needs
 * a new seam, and say so in the PR.
 *
 * The `ModelClient` interface itself lives in `../contracts` rather than here,
 * because the engine depends on the interface and must not depend on an
 * adapter. Which adapter is live is the host's choice: the shipped one wraps
 * `streamChatCompletion` in the CLI, and it stays there for now because the
 * reasoning-parameter shape it needs comes from the model catalog, which is host
 * state — it reads `~/.vajra/models.json` and fetches models.dev. Moving the
 * client into this package is a relocation that has to move the catalog with it
 * or take the catalog lookup as an injected resolver; doing it halfway would
 * put a cache read inside the runtime, which plan boundary 6 forbids.
 */
export {}
