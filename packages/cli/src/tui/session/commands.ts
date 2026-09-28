/**
 * Slash commands typed at the session prompt.
 *
 * Pure so the parsing contract is testable without a renderer. The palette and
 * `/help` are both generated from SLASH_COMMANDS, so a command cannot exist in
 * one and be missing from the other.
 *
 * There is one command for settings, not four. `/config` used to be joined by
 * `/model`, `/dir` and `/defaults`, and the three answered three different
 * halves of one question: `/dir` and `/config` both chose a directory, and
 * `/defaults` and `/config` both persisted. Two ways to do the same thing is
 * one too many; a user who found `/dir` never learned there was a screen with
 * the other three settings on it.
 */
export type SlashCommand = 'config' | 'model' | 'reasoning' | 'sessions' | 'help' | 'quit'

export interface SlashCommandSpec {
  /** Canonical name, typed after the slash. */
  name: SlashCommand
  /** One line, shown in the palette and in /help. */
  summary: string
  /** Other names that resolve to the same command. */
  aliases?: string[]
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    name: 'config',
    summary:
      'Everything a session runs on — each role’s model and the working directory, in one place',
    aliases: ['settings', 'setup'],
  },
  {
    name: 'model',
    summary:
      'Change the default model — the fallback every role runs on unless it has one of its own',
  },
  {
    name: 'reasoning',
    summary: 'Choose how hard the model thinks — the levels this model accepts',
    aliases: ['think', 'effort'],
  },
  {
    name: 'sessions',
    summary: 'Resume or remove a saved session',
    aliases: ['session'],
  },
  {
    name: 'help',
    summary: 'Show this help',
    aliases: ['?'],
  },
  {
    name: 'quit',
    summary: 'Exit Vajra',
    aliases: ['exit', 'q'],
  },
]

const BY_NAME = new Map<string, SlashCommandSpec>()
for (const command of SLASH_COMMANDS) {
  BY_NAME.set(command.name, command)
  for (const alias of command.aliases ?? []) BY_NAME.set(alias, command)
}

/** Look up a command by its canonical name or any alias. */
export function findSlashCommand(name: string): SlashCommandSpec | undefined {
  return BY_NAME.get(name.toLowerCase())
}

/** Palette entries for what has been typed after the slash, in listed order. */
export function matchSlashCommands(query: string): SlashCommandSpec[] {
  const q = query.toLowerCase()
  if (q === '') return [...SLASH_COMMANDS]
  return SLASH_COMMANDS.filter(
    c => c.name.startsWith(q) || (c.aliases ?? []).some(a => a.startsWith(q)),
  )
}

export type ParsedSlash =
  | { known: true; command: SlashCommand }
  | { known: false; name: string }

const COMMAND_SHAPE = /^\/([a-zA-Z][\w-]*)$/

/** Returns null when the text is not a command-shaped token at all. */
export function parseSlashCommand(text: string): ParsedSlash | null {
  const match = COMMAND_SHAPE.exec(text.trim())
  if (!match) return null
  const spec = findSlashCommand(match[1])
  if (spec) return { known: true, command: spec.name }
  return { known: false, name: `/${match[1]}` }
}

/** `/help` output, generated from the same table the palette shows. */
export const HELP_LINES = [
  'Slash commands:',
  ...SLASH_COMMANDS.map(c => `  /${c.name.padEnd(9)} ${c.summary}`),
  'Type a task to start working.',
]
