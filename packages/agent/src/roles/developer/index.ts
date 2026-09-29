/**
 * The Developer profile: prompt, context, tool catalog, budget.
 *
 * The loop that consumes it is still the CLI's `developerConversationTurn`.
 * Moving that body here is the next step and it is protected by the replay
 * fixtures in `packages/cli/test/replay-developer.test.mjs`; this step is the
 * part that can be landed without taking a dependency on a package the migration
 * deletes.
 */
export { createDeveloperProfile, DEVELOPER_BUDGET, DEVELOPER_TOOLS } from './profile.js'
export type { DeveloperContext, DeveloperProfileDeps } from './profile.js'
