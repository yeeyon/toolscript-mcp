// The refusal of a Workspace root, for config.mjs. It has no Node import, so a test can import it beside the core.
// It is a copy of `fold`, `partMatch`, `foldsCase`, `realParts`, `isInside`, `BUILT_IN_NAMES`, `LIMITS.roots` and
// `rootProblem` in src/core/workspace.ts. The plugin cache holds only plugin/, so it cannot import that file.
// tests/plugin-config.test.ts compares the two copies row by row. The server stays the authority.
// It also holds the text rules of a named task: `TASK_NAME`, `TASK_LIMITS.tasks` and `commandProblem` of
// src/core/task.ts, and the task keys of parseTasks in src/core/config.ts. A task that breaks one of them turns the
// whole `workspace` section off, so config.mjs refuses it before it writes.

export const ROOTS_MAX = 16

export const TASK_NAME = /^[a-z0-9_-]{1,32}$/
export const TASK_KEYS = ['command', 'args', 'cwd', 'timeoutSeconds', 'env']
export const TASKS_MAX = 32

export const commandProblem = (command, windows) => {
  if (/[\u0000-\u001f]/.test(command)) return 'must hold no control character'
  const absolute = windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(command) : command.startsWith('/')
  if (absolute) return undefined
  if (/[\\/]/.test(command) || (windows && /^[A-Za-z]:/.test(command)))
    return 'must be an absolute path, or a bare command name that PATH holds, such as "node"'
  return undefined
}

// Copies of TASK_LIMITS (args, argChars, envVars, envChars), `cwdParts` and `pathParts` (with LIMITS.parts and
// LIMITS.pathChars of workspace.ts), and the checks of parseTasks, `expand` and `stringMap` in src/core/config.ts.
// The syntax of `${NAME}` is checked here. Whether a variable is set depends on the environment of the server, so
// that check stays with the server.
export const TASK_LIMITS = { args: 64, argChars: 4096, envVars: 64, envChars: 4096 }

const PATH_PARTS = 64
const PATH_CHARS = 1024
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i
const hasControl = text => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)

const pathOk = (text, windows) => {
  if (text === '' || text.length > PATH_CHARS || hasControl(text) || text.includes('\\') || text.startsWith('/'))
    return false
  if (/^[A-Za-z]:/.test(text)) return false
  if (text === '.') return true
  const parts = text.split('/')
  if (parts.length > PATH_PARTS) return false
  return parts.every(
    part =>
      part !== '' &&
      part !== '.' &&
      part !== '..' &&
      !(windows && (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || DEVICE.test(part))),
  )
}

export const cwdProblem = (text, windows) =>
  pathOk(text, windows)
    ? undefined
    : 'must be a folder inside the root entry, relative, with / between parts, such as "." or "packages/app"'

const VAR = /\$\{([^}]*)\}/g
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const varProblem = text =>
  [...text.matchAll(VAR)].some(m => !ENV_NAME.test(m[1]))
    ? 'has a ${...} that is not a variable: write ${NAME} with letters, digits and underscores'
    : undefined

const argProblem = text =>
  text.length > TASK_LIMITS.argChars || text.includes('\u0000')
    ? `must hold at most ${TASK_LIMITS.argChars} characters and no NUL character`
    : undefined

// The first reason that the text of a task makes parseConfig turn the whole `workspace` section off, or undefined.
// `limit` is sandbox.callTimeoutSeconds. The text names a key and never a value.
export const taskProblem = (task, windows, limit) => {
  const unknown = Object.keys(task).find(key => !TASK_KEYS.includes(key))
  if (unknown !== undefined) return `has a key that is not one of ${TASK_KEYS.join(', ')}`
  if (typeof task.command !== 'string' || task.command.trim() === '') return 'command must be a non-empty string'
  const command = varProblem(task.command) ?? commandProblem(task.command, windows)
  if (command !== undefined) return `command ${command}`
  if (task.args !== undefined) {
    if (!Array.isArray(task.args) || task.args.length > TASK_LIMITS.args)
      return `args must be an array of at most ${TASK_LIMITS.args} strings`
    for (const [i, a] of task.args.entries()) {
      if (typeof a !== 'string') return `args[${i}] must be a string`
      const problem = varProblem(a) ?? argProblem(a)
      if (problem !== undefined) return `args[${i}] ${problem}`
    }
  }
  if (task.cwd !== undefined) {
    if (typeof task.cwd !== 'string') return 'cwd must be a string'
    const problem = cwdProblem(task.cwd, windows)
    if (problem !== undefined) return `cwd ${problem}`
  }
  const t = task.timeoutSeconds
  if (t !== undefined && !(Number.isInteger(t) && t >= 1 && t <= limit))
    return `timeoutSeconds must be a whole number from 1 to ${limit}, the value of sandbox.callTimeoutSeconds`
  if (task.env !== undefined) {
    if (typeof task.env !== 'object' || task.env === null || Array.isArray(task.env))
      return 'env must be an object of strings'
    const entries = Object.entries(task.env)
    if (entries.length > TASK_LIMITS.envVars) return `env must have at most ${TASK_LIMITS.envVars} variables`
    for (const [key, value] of entries) {
      if (typeof value !== 'string') return 'env must hold only string values'
      if (!ENV_NAME.test(key)) return 'env must name each variable with letters, digits and underscores'
      if (value.length > TASK_LIMITS.envChars || value.includes('\u0000'))
        return `env must hold values of at most ${TASK_LIMITS.envChars} characters and no NUL character`
      const problem = varProblem(value)
      if (problem !== undefined) return `env ${problem}`
    }
  }
  return undefined
}

export const BUILT_IN_NAMES = [
  '.git',
  '.hg',
  '.svn',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '*.tfstate',
  '*.tfstate.*',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.claude',
  '.codex',
  '.cursor',
  '.vscode',
  '.mcp.json',
  '.toolscript-mcp',
]

const fold = text => text.normalize('NFC').toLowerCase()

const partMatch = (pattern, text) => {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++
      mark = t
    } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++
      t++
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

const builtInExcluded = parts =>
  parts.some(part => {
    const name = fold(part)
    return BUILT_IN_NAMES.some(pattern => partMatch(pattern, name))
  })

export const foldsCase = platform => platform === 'win32' || platform === 'darwin'

export const realParts = (path, platform) => path.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter(p => p !== '')

const partsOf = (path, platform) => realParts(path, platform).map(p => (foldsCase(platform) ? fold(p) : p))

export const isInside = (child, parent, platform) => {
  const c = partsOf(child, platform)
  const p = partsOf(parent, platform)
  return c.length >= p.length && p.every((part, i) => part === c[i])
}

export const rootProblem = (real, home, platform) => {
  const all = realParts(real, platform)
  if (platform === 'win32' && /^[\\/]{2}/.test(real)) return 'it is a network path'
  if (all.length === 0 || (platform === 'win32' && all.length === 1 && /^[A-Za-z]:$/.test(all[0])))
    return 'it is a drive or file system root'
  if (isInside(home, real, platform)) return 'it is your home folder or holds it'
  if (builtInExcluded(all)) return 'a part of its path has a name that Workspace never opens, such as .git or .ssh'
  return undefined
}
