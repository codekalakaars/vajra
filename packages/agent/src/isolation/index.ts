/**
 * Task permissions, the tool-executor host and the process pool. Lane L5, relocated from agent-process.
 *
 * Declared now so the package's export map is complete before any lane needs
 * it: a subpath added later would be a package.json edit, and package.json is
 * owned by exactly one lane. Add exports there only when a lane genuinely needs
 * a new seam, and say so in the PR.
 */
export {}
