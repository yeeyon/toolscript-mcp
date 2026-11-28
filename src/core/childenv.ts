// The variables that a stdio child inherits from this process. The first SDK chose them (its `getDefaultEnvironment`); the
// second one added six Windows variables, and no child must see a new one, so the list is ours (issue #154, PR 6).
// tests/childenv.test.ts compares it with the first SDK on both platform branches.

/** The names that a child inherits on Windows. */
const WINDOWS = [
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERNAME',
  'USERPROFILE',
  'PROGRAMFILES',
] as const

/** The names that a child inherits on any other system, as sudo keeps them. */
const OTHER = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'] as const

/** The names of the environment that a child inherits on `platform`. */
export const inheritedNames = (platform: string): readonly string[] => (platform === 'win32' ? WINDOWS : OTHER)

/** The part of `env` that a child inherits on `platform`. A value that starts with `()` is a shell function and stays out. */
export const defaultEnvironment = (
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const inherited: Record<string, string> = {}
  for (const name of inheritedNames(platform)) {
    const value = env[name]
    if (value !== undefined && !value.startsWith('()')) inherited[name] = value
  }
  return inherited
}
