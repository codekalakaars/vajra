/**
 * The most of one tool result a Worker keeps in its conversation.
 *
 * Nothing upstream bounds a tool result: `read_file` returns the whole file and
 * a command's stdout and stderr are read to the end. One test run that prints a
 * few hundred kilobytes would fill a Worker's window, and a Worker whose window
 * overflows fails its attempt and starts over. So a result over the cap is cut
 * here, before it enters the conversation, and says that it was cut and how to
 * get the rest.
 *
 * Which end is kept depends on the tool. A command's last lines are the ones
 * that matter — a failing test, a compiler's error, the summary — so command
 * output keeps its tail. Anything else keeps its head, the way a person reads a
 * file, with the way to page through the rest named.
 */

const COMMAND_TOOLS = new Set(['run_command', 'run_baseline'])

function tail(text: string, keep: number): string {
  if (text.length <= keep) return text
  const cut = text.length - keep
  return `[… ${cut.toLocaleString('en-US')} earlier characters cut; this is the end of the output]\n${text.slice(cut)}`
}

/** stdout and stderr share the budget; one that needs less gives the rest to the other. */
function capCommandResult(content: string, max: number): string | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const stdout = typeof parsed.stdout === 'string' ? parsed.stdout : ''
  const stderr = typeof parsed.stderr === 'string' ? parsed.stderr : ''
  // Room for the JSON around them and the two notes.
  const budget = Math.max(200, max - 400)
  const half = Math.floor(budget / 2)
  const stderrKeep = stderr.length <= half ? stderr.length : Math.max(half, budget - Math.min(stdout.length, half))
  const stdoutKeep = Math.max(0, budget - Math.min(stderr.length, stderrKeep))
  return JSON.stringify({ ...parsed, stdout: tail(stdout, stdoutKeep), stderr: tail(stderr, stderrKeep) })
}

export function capToolOutput(tool: string, content: string, max: number): string {
  if (content.length <= max) return content
  if (COMMAND_TOOLS.has(tool)) {
    const capped = capCommandResult(content, max)
    if (capped !== null) return capped
    return tail(content, max)
  }
  const how =
    tool === 'read_file'
      ? 'Call read_file with offset and limit (line numbers) to read the rest.'
      : 'Narrow the request to see the rest.'
  return `${content.slice(0, max)}\n[… cut: showing the first ${max.toLocaleString('en-US')} of ${content.length.toLocaleString('en-US')} characters. ${how}]`
}
