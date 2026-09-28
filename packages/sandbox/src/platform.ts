// Vajra ships on Linux only.
//
// Confinement is the entire product, and it is Landlock: a Linux LSM. Nothing
// equivalent exists on macOS any more (Apple deprecated the Seatbelt SPI), on
// Windows, or anywhere else — so an unsupported platform has nothing to enforce
// and no addon to load. Rather than degrade into a best-effort run that reads
// like a sandbox and is not one, both binaries refuse at startup.

/** The platforms Vajra is built, tested and published for. */
export const SUPPORTED_PLATFORMS = ['linux'] as const

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number]

/** True when `platform` is one of {@link SUPPORTED_PLATFORMS}. */
export function isSupportedPlatform(platform: string = process.platform): platform is SupportedPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(platform)
}

/** What to say when someone runs Vajra somewhere it cannot confine anything. */
export function unsupportedPlatformMessage(platform: string = process.platform): string {
  const lines = [
    `Vajra supports Linux only — this is ${platform} (${process.arch}).`,
    '',
    'Confinement is built on Landlock, a Linux kernel feature. It does not',
    'exist on this platform, so there is no native core to load and nothing',
    'Vajra could enforce: an agent run here could read and write every file',
    'you can.',
  ]

  // Only Windows has a documented route back to a supported platform. Telling
  // a FreeBSD or macOS user about WSL2 would be noise.
  if (platform === 'win32') {
    lines.push('', 'On Windows, run Vajra from WSL2 against a Linux filesystem.')
  }

  return lines.join('\n')
}

/**
 * Exit the process if the platform is unsupported. Call this before anything
 * loads the native addon, so the user sees this instead of a loader error.
 */
export function assertSupportedPlatform(platform: string = process.platform): void {
  if (isSupportedPlatform(platform)) return

  console.error(unsupportedPlatformMessage(platform))
  process.exit(1)
}
