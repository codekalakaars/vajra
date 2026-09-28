import { isSupportedModel } from './env.js'
import { clampReasoning } from './models/catalog.js'
import type { ReasoningEffort } from './agent/chat.js'
import type { RoleName } from './config.js'

/**
 * Which model each role runs on, decided in one place.
 *
 * ADR-0010 gives Developer, Manager and Worker a model each, configured
 * independently. Two things follow, and both are easy to get subtly wrong
 * enough that they belong here rather than in the middle of a session:
 *
 * - A role with no model of its own runs on the default. Otherwise a user who
 *   has never opened `/config` gets three copies of the built-in default that
 *   they have to keep in step by hand, instead of the one model everything used
 *   to share.
 * - A role model that the gateway would reject stops the session *before* any
 *   work starts, naming the role. The alternative is a 400 on the first task,
 *   long after the config that caused it was written.
 */
export interface RoleModelInput {
  /** The fallback every role runs on unless it has a model of its own. */
  defaultModel: string
  developerModel?: string
  managerModel?: string
  workerModel?: string
  /** §4's explicit opt-in, independent of whether a model is configured. */
  useMasterLlm?: boolean
}

export interface RoleModelPlan {
  /** What each role actually runs on. */
  developer: string
  manager: string
  worker: string
  /** Only the roles that named a model, for the record and for `/config`. */
  overrides: Partial<Record<RoleName, string>>
  /** A role model that is not a model this build can run. */
  invalid: { role: RoleName; model: string }[]
  /**
   * Whether the Manager asks the model anything.
   *
   * The Manager is an agent (ADR-0010). Naming a model for it is the opt-in,
   * made in config rather than on a flag, so either one turns this on.
   */
  managerAsks: boolean
}

export function planRoleModels(input: RoleModelInput): RoleModelPlan {
  const overrides: Partial<Record<RoleName, string>> = {}
  const invalid: { role: RoleName; model: string }[] = []
  for (const role of ['developer', 'manager', 'worker'] as const) {
    const model = input[`${role}Model`]
    if (model === undefined) continue
    if (!isSupportedModel(model)) {
      invalid.push({ role, model })
      continue
    }
    overrides[role] = model
  }
  return {
    developer: overrides.developer ?? input.defaultModel,
    manager: overrides.manager ?? input.defaultModel,
    worker: overrides.worker ?? input.defaultModel,
    overrides,
    invalid,
    managerAsks: input.useMasterLlm === true || overrides.manager !== undefined,
  }
}

/**
 * The reasoning level a role should be sent.
 *
 * One dial for the session, three models that rarely share it: a level picked
 * on a model that takes `xhigh` is not a level a model that takes a toggle will
 * accept, and sending it is a request the provider rejects. Clamping per role is
 * the same thing the store does when the model changes, done at the point where
 * the request is built.
 */
export function roleReasoningEffort(model: string, level: ReasoningEffort | undefined): ReasoningEffort {
  return clampReasoning(model, level ?? 'off')
}
