// The pure parts of the task helpers (issue #149): the report grammar of the Windows job helper and of the POSIX
// reap helper, the one decision that reads the reports, the error tables, the frames and the environment block. No
// Node module and no host type: `src/host/taskjob.ts` runs the processes.

/**
 * One line that a helper reports. `ready` comes from the Windows helper once. `begin` means the task may run code
 * from here on. `started` carries the pid of the task when the helper knows it. `error` is the code of the OS for a
 * program that did not start. `failed` is sent before `begin` only: the helper never started the task.
 */
export type Report =
  | { readonly kind: 'ready' }
  | { readonly kind: 'begin' }
  | { readonly kind: 'started'; readonly pid: number | undefined }
  | { readonly kind: 'error'; readonly code: number }
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'signal'; readonly signal: number }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'left'; readonly count: number }
  | { readonly kind: 'failed'; readonly step: string }

const digits = (text: string | undefined): number | undefined =>
  text !== undefined && /^\d{1,10}$/.test(text) ? Number(text) : undefined

/** One line of a helper as a report. Any other text is no report. */
export const parseReport = (line: string): Report | undefined => {
  if (line === 'ready') return { kind: 'ready' }
  if (line === 'begin') return { kind: 'begin' }
  if (line === 'stopped') return { kind: 'stopped' }
  if (line === 'started') return { kind: 'started', pid: undefined }
  const [head, rest] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]
  if (!line.includes(':')) return undefined
  const n = digits(rest)
  switch (head) {
    case 'started':
      return n === undefined ? undefined : { kind: 'started', pid: n }
    case 'error':
      return n === undefined ? undefined : { kind: 'error', code: n }
    case 'exit':
      return n === undefined ? undefined : { kind: 'exit', code: n }
    case 'signal':
      return n === undefined ? undefined : { kind: 'signal', signal: n }
    case 'left':
      return n === undefined ? undefined : { kind: 'left', count: n }
    case 'failed':
      return /^[a-z]{1,12}$/.test(rest) ? { kind: 'failed', step: rest } : undefined
    default:
      return undefined
  }
}

/** What the reports of one task say, read after the report channel closed. The exit code of a helper process is no input. */
export type Outcome =
  /** The helper never started the task: the direct spawn may take the call. */
  | { readonly kind: 'fallback'; readonly step: string }
  | { readonly kind: 'start-error'; readonly code: number }
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'signal'; readonly signal: number }
  | { readonly kind: 'stopped' }
  /** The task began and the helper ended with no result: an error, and nothing starts again. */
  | { readonly kind: 'lost' }

export const decide = (seen: readonly Report[]): Outcome => {
  const error = seen.find(r => r.kind === 'error')
  if (error?.kind === 'error') return { kind: 'start-error', code: error.code }
  if (!seen.some(r => r.kind === 'begin')) {
    const failed = seen.find(r => r.kind === 'failed')
    return { kind: 'fallback', step: failed?.kind === 'failed' ? failed.step : 'ended' }
  }
  for (const r of seen) {
    if (r.kind === 'exit') return { kind: 'exit', code: r.code }
    if (r.kind === 'signal') return { kind: 'signal', signal: r.signal }
    if (r.kind === 'stopped') return { kind: 'stopped' }
  }
  return { kind: 'lost' }
}

/** The Node code of a start error number: the Win32 code on Windows, errno elsewhere. The rest is `error`. */
export const startCode = (windows: boolean, n: number): string => {
  const table: Readonly<Record<number, string>> = windows
    ? { 2: 'ENOENT', 3: 'ENOENT', 5: 'EPERM', 87: 'EINVAL', 206: 'ENAMETOOLONG' }
    : { 2: 'ENOENT', 13: 'EACCES', 8: 'ENOEXEC', 7: 'E2BIG', 20: 'ENOTDIR' }
  return table[n] ?? 'error'
}

/** The number of `prctl` for this machine, as the perl helper cannot name it. 0 is sent where it is not used. */
export const prctlNumber = (platform: string, arch: string): number | undefined => {
  if (platform === 'darwin') return 0
  if (platform !== 'linux') return undefined
  return arch === 'x64' ? 157 : arch === 'arm64' ? 167 : undefined
}

/** The longest command line of a Windows process, in characters. */
export const COMMAND_LINE_MAX = 32767

/** A value of a task that no helper gets: a NUL, or a Windows command line that is too long. Nothing is cut. */
export const taskRefusal = (
  task: {
    readonly file: string
    readonly line: string
    readonly args: readonly string[]
    readonly env: Readonly<Record<string, string>>
  },
  windows: boolean,
): 'EINVAL' | 'ENAMETOOLONG' | undefined => {
  const values = [task.file, ...task.args, ...Object.keys(task.env), ...Object.values(task.env)]
  if (values.some(v => v.includes('\0'))) return 'EINVAL'
  if (windows && task.file.length + task.line.length + 3 > COMMAND_LINE_MAX) return 'ENAMETOOLONG'
  return undefined
}

const REQUIRED_WINDOWS = [
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]

/**
 * The environment block of a Windows child as a direct spawn gives it (`make_program_env` of libuv): the task
 * environment, plus each required name that it lacks (names ignore case) and the server has, sorted by name with
 * letter case ignored. The helper uses it as it is.
 */
export const windowsEnv = (
  task: Readonly<Record<string, string>>,
  server: Readonly<Record<string, string | undefined>>,
): [string, string][] => {
  const out = new Map<string, [string, string]>()
  for (const [name, value] of Object.entries(task)) out.set(name.toUpperCase(), [name, value])
  for (const name of REQUIRED_WINDOWS) {
    if (out.has(name)) continue
    const key = Object.keys(server).find(k => k.toUpperCase() === name)
    const value = key === undefined ? undefined : server[key]
    if (value !== undefined) out.set(name, [key!, value])
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, pair]) => pair)
}

/** The UTF-8 bytes of a text. A lone surrogate becomes U+FFFD, as a direct spawn would give it. */
const utf8 = (text: string): Uint8Array => {
  const bytes: number[] = []
  for (const ch of text) {
    let c = ch.codePointAt(0)!
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(bytes)
}

const withLength = (body: Uint8Array, littleEndian: boolean): Uint8Array => {
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, littleEndian)
  out.set(body, 4)
  return out
}

/**
 * The stop frame for the Windows helper: a length of 0. The helper ends every process of the job of the running task, waits
 * until none is alive (at most 2 s), then reports `exit`. It stays ready for the next task.
 */
export const WINDOWS_STOP_FRAME: Uint8Array = new Uint8Array(4)

/** The frame for the Windows helper: 4-byte length, then these fields with a NUL between them, then the environment pairs. */
export const windowsFrame = (
  fields: {
    readonly file: string
    readonly line: string
    readonly cwd: string
    readonly out: string
    readonly err: string
  },
  env: readonly (readonly [string, string])[],
): Uint8Array =>
  withLength(utf8([fields.file, fields.line, fields.cwd, fields.out, fields.err, ...env.flat()].join('\0')), true)

/** The frame for the POSIX helper: 4-byte length (big endian), then `NAME=VALUE` entries with a NUL between them. */
export const posixFrame = (env: Readonly<Record<string, string>>): Uint8Array =>
  withLength(
    utf8(
      Object.entries(env)
        .map(([name, value]) => `${name}=${value}`)
        .join('\0'),
    ),
    false,
  )
