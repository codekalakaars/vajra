import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import type { LaunchHandle } from '@codekalakaars/vajra-sandbox'
import type { ChatMessage, ReasoningEffort } from '../model/chat.js'
import type { AgentEvent } from '../manager/ui.js'
import { createEvidenceLedger, resetEvidenceLedger } from './evidence.js'
import { developerConversationTurn } from './developer.js'

/**
 * How a person takes part in planning. Two moments need them: the Developer
 * replied with words instead of a plan (a question, usually), and a plan is
 * proposed. Everything else the Developer does without them.
 */
export interface PlanningPerson {
  /**
   * The Developer said something rather than proposing a plan. Return the
   * person's answer, or `null` when they would rather stop.
   */
  answer(response: string): Promise<string | null>
  /**
   * A plan was proposed. Return `true` to accept it, a string to send back as
   * feedback for a new plan, or `null` to stop.
   */
  review(plan: DeveloperPlan): Promise<true | string | null>
}

export interface PlanWithDeveloperInput {
  projectDir: string
  apiKey: string
  model: string
  reasoningEffort?: ReasoningEffort
  /** What the person wants done. */
  task: string
  /** How the Developer reads the project: the sandbox's handle, so its reads are confined too. */
  handle: LaunchHandle
  person: PlanningPerson
  /** A conversation is bounded: a Developer that never settles on a plan is stopped. */
  maxTurns?: number
  signal?: AbortSignal
  onTextDelta?: (text: string) => void
  onAgentEvent?: (event: AgentEvent) => void
}

export type PlanOutcome =
  | { type: 'plan'; plan: DeveloperPlan }
  | { type: 'stopped'; reason: 'person' | 'interrupted' | 'turns' }

const DEFAULT_MAX_TURNS = 20

/**
 * Run a planning conversation to an accepted plan.
 *
 * The Developer explores the project and calls `propose_plan`; a plan it
 * proposes is reviewed by the person, and one they reject goes back to the
 * Developer as feedback, with the evidence it already collected kept so it need
 * not read everything again. Returns the accepted plan, which is what
 * `executePlan` runs; nothing here executes anything.
 */
export async function planWithDeveloper(input: PlanWithDeveloperInput): Promise<PlanOutcome> {
  const { person, signal } = input
  const messages: ChatMessage[] = []
  // Owned here, not by a turn: a plan rejected in one turn is re-proposed in the
  // next, and the validator checks it against the evidence from both.
  const evidence = createEvidenceLedger()
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS
  let userMessage = input.task

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) return { type: 'stopped', reason: 'interrupted' }

    const result = await developerConversationTurn({
      sessionId: 'plan',
      projectDir: input.projectDir,
      userMessage,
      model: input.model,
      apiKey: input.apiKey,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      handle: input.handle,
      messages,
      summaryIndex: [],
      evidence,
      ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
      ...(signal ? { signal, isInterrupted: () => signal.aborted } : {}),
      ...(input.onAgentEvent ? { onAgentEvent: input.onAgentEvent } : {}),
    })

    if (result.type === 'plan') {
      const verdict = await person.review(result.plan)
      if (verdict === null) return { type: 'stopped', reason: 'person' }
      if (verdict === true) {
        // The Workers are about to change the files this evidence describes, so
        // it is stale the moment the first write lands.
        resetEvidenceLedger(evidence)
        return { type: 'plan', plan: result.plan }
      }
      userMessage = verdict
      continue
    }

    const answer = await person.answer(result.response)
    if (answer === null) return { type: 'stopped', reason: 'person' }
    userMessage = answer
  }

  return { type: 'stopped', reason: 'turns' }
}
