/**
 * Slash commands typed at the session prompt.
 *
 * Pure so the parsing contract is testable without a renderer. The palette and
 * `/help` are both generated from SLASH_COMMANDS, so a command cannot exist in
 * one and be missing from the other.
 */
export type SlashCommand = 'model' | 'reasoning' | 'dir' | 'defaults' | 'sessions' | 'help' | 'quit'

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
    name: 'model',
    summary: 'Change the model — the live catalog, searchable, with context, price and reachability',
  },
  {
    name: 'reasoning',
    summary: 'Cycle how hard the model thinks, over the levels this model accepts',
    aliases: ['think', 'effort'],
  },
  {
    name: 'dir',
    summary: 'Change directory — ends this conversation, starts a new one there',
    aliases: ['directory'],
  },
  {
    name: 'defaults',
    summary: 'Save model and directory as persistent defaults',
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
