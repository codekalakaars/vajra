/**
 * The Worker's opening messages.
 *
 * Two shapes. The legacy one is a title, the instructions and four path lists,
 * and tells the Worker to go and read its files — byte for byte what the replay
 * fixtures pin, so it is what a run gets with `contextPack` off. The pack one
 * puts the compiled context pack (`agent/pack.ts`) in the system message after
 * the role rules: one stable prefix for the whole attempt, which the provider
 * can cache, and a first user message that only says to start.
 */

export interface PromptTask {
  title: string
  description: string | null
  instructions: string[]
  readFile: string[]
  writeFile: string[]
  deleteFile: string[]
  createDir: string[]
}

/** Today's prompt. `preloaded` is the read files, already in the first message. */
export function legacySystemPrompt(task: PromptTask, preloaded: boolean): string {
  const instructionLines = task.instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')
  const readFileList = task.readFile.length > 0 ? task.readFile.join(', ') : '(none)'
  const writeFileList = task.writeFile.length > 0 ? task.writeFile.join(', ') : '(none)'
  const deleteFileList = task.deleteFile.length > 0 ? task.deleteFile.join(', ') : '(none)'
  const createDirList = task.createDir.length > 0 ? task.createDir.join(', ') : '(none)'

  return [
    'You are a worker agent. Follow the instructions EXACTLY. Do not deviate.',
    '',
    `TASK: ${task.title}`,
    task.description ? `WHY: ${task.description}` : '',
    '',
    'INSTRUCTIONS (follow in order):',
    instructionLines,
    '',
    `FILES TO READ: ${readFileList}`,
    `FILES TO WRITE: ${writeFileList}`,
    `FILES TO DELETE: ${deleteFileList}`,
    `DIRS TO CREATE: ${createDirList}`,
    '',
    'RULES:',
    '- Execute each instruction step by step',
    // The reads are already in the first message, so a rule telling the Worker
    // to go and make them would be a contradiction only it has to notice.
    ...(preloaded ? [] : ['- Read each readFile first to understand the current code']),
    '- Make precise edits using edit_file (not write_file for existing files)',
    '- Use write_file only for new files',
    '- Use delete_file only for files listed under FILES TO DELETE',
    '- Use create_dir only for directories listed under DIRS TO CREATE',
    '- Use run_command to execute shell commands (npm install, npm test, git, etc.)',
    '- After completing all instructions, respond with a brief summary',
  ].filter(Boolean).join('\n')
}

/** Role rules for a Worker that starts from a pack. The pack follows them. */
const PACK_RULES = [
  'You are a worker agent. Your task, what "done" means, the code you will change',
  'and the context you need are below, compiled from the plan and the files as',
  'they are now. Work from it: do not re-read a file the pack already shows unless',
  'you have changed it since, or need a part it says it left out.',
  '',
  'RULES:',
  '- Make precise edits using edit_file (not write_file for existing files); copy anchors from the text shown',
  '- Use write_file only for new files',
  '- Touch only the files under SCOPE',
  '- Run the commands under DONE MEANS before you finish, and fix what fails',
  '- When finished, reply with a short summary of what you changed and anything a task building on yours must know',
].join('\n')

export function packSystemPrompt(packText: string): string {
  return `${PACK_RULES}\n\n${packText}`
}

export const START_MESSAGE = 'Execute the task now.'
