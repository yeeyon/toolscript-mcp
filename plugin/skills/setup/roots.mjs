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
