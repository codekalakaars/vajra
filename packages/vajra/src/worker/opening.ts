import type { LaunchHandle } from '@codekalakaars/vajra-sandbox'
import type { AgentEvent, AgentLabel, SessionStreamer } from '../manager/ui.js'
import { renderPreviousAttempts } from '../manager/handoff.js'
import type { ChatMessage } from '../model/chat.js'
import type { WorkerParams } from '../bench/params.js'
import { buildContextPack } from './pack.js'
import { preloadReadFiles } from './preload.js'
import { legacySystemPrompt, packSystemPrompt, START_MESSAGE } from './prompt.js'
import type { WorkerContext } from './context-types.js'
import type { ExecuteTaskInput } from './execute.js'

function asText(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result ?? '')
}

/** What a Worker starts from: its first two messages, and the parts of them other code needs. */
export interface Opening {
  /** The task's read files, when `preloadReads` put them in the first message. */
  preloaded: string | null
  /** The compiled context, or `null` when the run has `contextPack` off or it could not be built. */
  pack: Awaited<ReturnType<typeof buildContextPack>> | null
  /** The retry's account of what it is replacing, when `respawnContext` is on and there was an earlier attempt. */
  previousAttempt: string | undefined
  /** The system message and the first user message. */
  messages: ChatMessage[]
}

export async function buildOpening(input: {
  task: ExecuteTaskInput['task']
  params: WorkerParams
  model: string
  handle: LaunchHandle
  context: WorkerContext | undefined
  streamer: SessionStreamer
  emit: (event: AgentEvent) => void
  agent: AgentLabel
}): Promise<Opening> {
  const { task, params, model, handle, context, streamer, emit, agent } = input

  const preloaded = params.preloadReads
    ? await preloadReadFiles(task.readFile, handle, params.toolOutputMaxChars, (path, why) =>
        streamer.warning(`Could not preload ${path}: ${why}`))
    : null

  /**
   * The retry's account of what it is replacing, rendered here rather than by
   * the pack so it is byte-for-byte the same block whether the pack is on (where
   * it is section 3) or off (where it is appended to the first user message).
   */
  const previousAttempt =
    params.respawnContext && context?.previousAttempts && context.previousAttempts.length > 0
      ? renderPreviousAttempts(context.previousAttempts, params.respawnDiffChars)
      : undefined

  /**
   * The compiled context, or `null` when the run has `contextPack` off.
   *
   * Built here, at dispatch, through the task's own handle — the same call path,
   * permission gate and masked-file stub a Worker's own `read_file` goes through,
   * so the pack can never show more than the Worker would have been allowed to
   * read. A pack that cannot be built falls back to the legacy prompt with a
   * warning rather than failing the attempt: an unreadable file is not a reason
   * to refuse to do the work.
   */
  let pack: Awaited<ReturnType<typeof buildContextPack>> | null = null
  if (params.contextPack) {
    try {
      pack = await buildContextPack({
        task,
        params,
        model,
        read: async (path, symbols) =>
          asText(
            await handle.callTool(
              'read_file',
              symbols && symbols.length > 0 ? { path, symbols } : { path },
            ),
          ),
        list: async path => asText(await handle.callTool('list_files', { path })),
        ...(context?.contracts ? { contracts: context.contracts } : {}),
        ...(context?.projectCard !== undefined ? { projectCard: context.projectCard } : {}),
        ...(context?.upstream ? { upstream: context.upstream } : {}),
        ...(previousAttempt !== undefined ? { previousAttempt } : {}),
      })
      emit({
        type: 'context',
        agent,
        kind: 'pack',
        pack: {
          tokens: pack.tokens,
          hash: pack.hash,
          paths: pack.paths,
          omitted: pack.omitted.length,
          stale: pack.staleAnchors.length,
          relocated: pack.relocatedAnchors.length,
        },
      })
    } catch (e) {
      streamer.warning(
        `Could not build the context pack (${e instanceof Error ? e.message : String(e)}); starting from the task prompt instead.`,
      )
      pack = null
    }
  }

  const systemPrompt = pack ? packSystemPrompt(pack.text) : legacySystemPrompt(task, preloaded !== null)

  /**
   * The first user message.
   *
   * With a pack it says only "start": the pack is the whole brief, and a second
   * paragraph in front of it is a paragraph the model reads before it knows what
   * it is starting. Without a pack it carries the preloaded reads, and either way
   * the retry's account of what it is replacing goes last, where it is read as
   * context for the task rather than as the task.
   */
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: pack
        ? [START_MESSAGE, ...(previousAttempt === undefined ? [] : ['', previousAttempt])].join('\n')
        : [
            preloaded ? `${START_MESSAGE}\n\n${preloaded}` : START_MESSAGE,
            ...(previousAttempt === undefined ? [] : ['', previousAttempt]),
          ].join('\n'),
    },
  ]

  return { preloaded, pack, previousAttempt, messages }
}
