// The built-in Workspace (issue #144): the tools that read one approved folder, as the model sees them, and the pure
// rules behind them: the tool table, the limits, the check of a path text, the globs, the exclusions, the refusal of a
// root and the binding of a session to its root. The code that touches files is in src/host/workspace/.
// The table holds a class for each tool, so a later tool is one more entry (decision 144).

import type { TaskConfig } from './task.ts'

/** The server key of the built-in Workspace. With a `workspace` section, `mcpServers` cannot use it. */
export const WORKSPACE_KEY = 'workspace'

/** The version of the provider. A change that breaks a schema raises the major version. */
export const WORKSPACE_VERSION = '1.0.0'

export const LIMITS = {
  /** `read` refuses a larger file. */
  readBytes: 4 * 1024 * 1024,
  /** `search` skips a larger file. */
  searchFileBytes: 1024 * 1024,
  searchFiles: 20_000,
  searchMs: 10_000,
  listEntries: 5_000,
  /** Walks of `list` and `search` that run at one time in a provider (issue #160). */
  walkSlots: 1,
  /** `search` cuts the text of a line at this length. */
  lineChars: 400,
  parts: 64,
  pathChars: 1024,
  maxDepth: 8,
  maxMatches: 2_000,
  defaultMatches: 200,
  includes: 16,
  globChars: 200,
  globWildcards: 6,
  queryChars: 1_000,
  roots: 16,
  configGlobs: 64,
  /** `edits` of one call. */
  edits: 50,
  /** Matches of one `old` with `all: true`. */
  replacements: 10_000,
  /** The unified diff is cut at this many characters. */
  diffChars: 64 * 1024,
  /** Lines of context around each change in a diff. */
  context: 3,
  /** A change waits this long for the lock of its file, then fails with `busy`. */
  lockWaitMs: 2_000,
  /** A lock file older than this, or of a dead process, is taken over. */
  lockStaleMs: 30_000,
  /** The `.gitignore` of the root: a larger file gives no rules. */
  ignoreBytes: 64 * 1024,
  /** Rules that count. The rest of the file is skipped. */
  ignoreRules: 500,
  /** A line of the `.gitignore` with more characters, or more wildcards, is skipped. */
  ignoreLineChars: 200,
  ignoreWildcards: 6,
} as const

/** The folders that `list` and `search` do not enter. It is not access control: `path` can name one. */
export const DEFAULT_SKIP: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
]

/** The codes at the start of each error message of a tool. */
export type WorkspaceCode =
  | 'bad-input'
  | 'bad-path'
  | 'excluded'
  | 'link'
  | 'hard-link'
  | 'not-found'
  | 'not-file'
  | 'not-folder'
  | 'too-large'
  | 'binary'
  | 'encoding'
  | 'root-changed'
  | 'unavailable'
  | 'cancelled'
  | 'io'
  // Pull request B: the editing tools.
  | 'read-only'
  | 'stale'
  | 'busy'
  | 'exists'
  | 'no-match'
  | 'many-matches'

/** A failed call. The message starts with the code and holds no byte or name from outside the root. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceCode
  constructor(code: WorkspaceCode, text: string) {
    super(`${code}: ${text}`)
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Folding and globs

/** The form in which names compare: Unicode NFC, then lower case. So `.ENV`, and an NFD spelling, match `.env`. */
export const fold = (text: string): string => text.normalize('NFC').toLowerCase()

/** True when `text` has a control character. */
const hasControl = (text: string): boolean => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)

// `*` and `?` inside one part: the two-pointer match with one place to go back to. The wildcards of a pattern are
// capped (`LIMITS.globWildcards`), so the time is bounded.
const partMatch = (pattern: string, text: string): boolean => {
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

/** A compiled glob: its parts, with `**` as `undefined`. */
export type Glob = readonly (string | undefined)[]

/** Why `pattern` is no glob that Workspace takes, or undefined. The text names no part of the pattern. */
export const globProblem = (pattern: unknown): string | undefined => {
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > LIMITS.globChars)
    return `must be a glob of 1 to ${LIMITS.globChars} characters`
  if (pattern.includes('\\') || hasControl(pattern) || pattern.startsWith('/'))
    return 'must use / between parts, start with no /, and hold no control character'
  const parts = pattern.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) return 'must have no empty, . or .. part'
  if (parts.some(part => part.includes('**') && part !== '**')) return 'can hold ** only as a whole part'
  const wildcards = (pattern.match(/\*+|\?/g) ?? []).length
  return wildcards > LIMITS.globWildcards ? `must have at most ${LIMITS.globWildcards} wildcards` : undefined
}

/** The glob, folded when `folded`. The caller checks `globProblem` first. */
export const compileGlob = (pattern: string, folded = false): Glob => {
  const parts = (folded ? fold(pattern) : pattern).split('/')
  // `**/**` is `**`.
  return parts.flatMap((part, i): (string | undefined)[] =>
    part === '**' ? (parts[i - 1] === '**' ? [] : [undefined]) : [part],
  )
}

/** True when the glob matches the whole list of parts. `*` and `?` stay inside a part, `**` spans zero or more parts. */
export const globMatches = (glob: Glob, parts: readonly string[]): boolean => {
  let below: boolean[] = Array.from({ length: parts.length + 1 }, (_, j) => j === parts.length)
  for (let i = glob.length - 1; i >= 0; i--) {
    const seg = glob[i]
    const row: boolean[] = new Array(parts.length + 1).fill(false)
    for (let j = parts.length; j >= 0; j--)
      row[j] =
        seg === undefined
          ? below[j]! || (j < parts.length && row[j + 1]!)
          : j < parts.length && below[j + 1]! && partMatch(seg, parts[j]!)
    below = row
  }
  return below[0]!
}

/** A test for `include`: true for a path that matches one glob, and for each path when the list is empty. */
export const includeTest = (globs: readonly string[]): ((parts: readonly string[]) => boolean) => {
  const compiled = globs.map(g => compileGlob(g))
  return parts => compiled.length === 0 || compiled.some(g => globMatches(g, parts))
}

/**
 * A test of a folder (its parts from the root): true when a glob can match a path strictly below it, and for each
 * folder when the list is empty. The same part match as `includeTest`.
 */
export const includeReach = (globs: readonly string[]): ((folder: readonly string[]) => boolean) => {
  const compiled = globs.map(g => compileGlob(g))
  // The glob positions that hold after `parts`: `**` stays, or is skipped.
  const after = (glob: Glob, parts: readonly string[]): boolean => {
    let at = new Set<number>([0])
    const close = (set: Set<number>): Set<number> => {
      for (const i of set) if (glob[i] === undefined && i < glob.length) set.add(i + 1)
      return set
    }
    close(at)
    for (const part of parts) {
      const next = new Set<number>()
      for (const i of at) {
        const seg = glob[i]
        if (i >= glob.length) continue
        if (seg === undefined) next.add(i)
        else if (partMatch(seg, part)) next.add(i + 1)
      }
      if (next.size === 0) return false
      at = close(next)
    }
    return [...at].some(i => i < glob.length)
  }
  return folder => compiled.length === 0 || compiled.some(g => after(g, folder))
}

// ---------------------------------------------------------------------------------------------------------------
// Path text

const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i

/**
 * The parts of a path text, or a `bad-path` error. The text is checked before any file system call. No part is ever
 * resolved away. `.` is the root and has no part. `windows`: the rules of a Windows volume also hold.
 */
export const pathParts = (text: string, windows: boolean): string[] => {
  const bad = (why: string): never => {
    throw new WorkspaceError('bad-path', `${why}. Use a path relative to the workspace root, with / between parts`)
  }
  if (text === '') return bad('the path is empty')
  if (text.length > LIMITS.pathChars) return bad(`the path has more than ${LIMITS.pathChars} characters`)
  if (hasControl(text)) return bad('the path has a control character')
  if (text.includes('\\')) return bad('the path has a backslash')
  if (text.startsWith('/')) return bad('the path is absolute')
  if (/^[A-Za-z]:/.test(text)) return bad('the path names a drive')
  if (text === '.') return []
  const parts = text.split('/')
  if (parts.length > LIMITS.parts) return bad(`the path has more than ${LIMITS.parts} parts`)
  for (const part of parts) {
    if (part === '') return bad('the path has an empty part')
    if (part === '.' || part === '..') return bad('the path has a . or .. part')
    if (windows) {
      if (/[<>:"|?*]/.test(part)) return bad('the path has a character that Windows does not allow in a name')
      if (/[. ]$/.test(part)) return bad('a part of the path ends in a dot or a space')
      if (DEVICE.test(part)) return bad('a part of the path is a device name')
    }
  }
  return parts
}

/** `pathParts` of a folder path: one final `/` is cut first, unless the text is `/`. All other rules hold. */
export const folderParts = (text: string, windows: boolean): string[] =>
  pathParts(text.length > 1 && text.endsWith('/') ? text.slice(0, -1) : text, windows)

/** The path as the tools show it: the parts with `/`, and `.` for the root. */
export const showPath = (parts: readonly string[]): string => (parts.length === 0 ? '.' : parts.join('/'))

// ---------------------------------------------------------------------------------------------------------------
// Exclusions

// The names that no tool reads, lists or writes, whatever their folder. Version control data, secrets, and the
// settings and hooks of clients.
export const BUILT_IN_NAMES: readonly string[] = [
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

/** True when a part of `parts` is a built-in excluded name, with no regard to case, after NFC. */
export const builtInExcluded = (parts: readonly string[]): boolean =>
  parts.some(part => {
    const name = fold(part)
    return BUILT_IN_NAMES.some(pattern => partMatch(pattern, name))
  })

/** A path as a list of folded parts. Both `/` and `\` separate parts. */
const foldedParts = (path: string): string[] =>
  fold(path)
    .split(/[\\/]+/)
    .filter(part => part !== '')

/** True when the parts of `path` start with the parts of `dir`. */
const under = (path: string, dir: string): boolean => {
  const a = foldedParts(path)
  const b = foldedParts(dir)
  return a.length >= b.length && b.every((part, i) => part === a[i])
}

export type Excluder = (parts: readonly string[]) => boolean

/**
 * The test for the paths that no tool touches: the built-in names, the `exclude` globs of the config, and the real
 * paths in `forbidden` (the config file, the folder `.toolscript-mcp` of the home folder). `root` is the real path of
 * the session root. A glob without `/` matches the name of any part. A glob with `/` matches the path from the root,
 * and a folder that it names takes each path below it. All of it with no regard to case, after NFC.
 */
export const makeExcluder = (root: string, exclude: readonly string[], forbidden: readonly string[]): Excluder => {
  const named = exclude.filter(g => !g.includes('/')).map(g => fold(g))
  const pathed = exclude.filter(g => g.includes('/')).map(g => compileGlob(g, true))
  return parts => {
    if (builtInExcluded(parts)) return true
    const names = parts.map(fold)
    if (names.some(name => named.some(pattern => partMatch(pattern, name)))) return true
    for (let k = 1; k <= names.length; k++) if (pathed.some(g => globMatches(g, names.slice(0, k)))) return true
    const absolute = `${root}/${parts.join('/')}`
    return forbidden.some(dir => under(absolute, dir))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Roots

/** The platforms whose volumes ignore case by default. */
export const foldsCase = (platform: string): boolean => platform === 'win32' || platform === 'darwin'

/** What the probe of a macOS volume saw: the path and its case-flipped spelling name one file, two, none, or it failed. */
export type CaseProbe = 'same' | 'other' | 'missing' | 'error' | 'noletter'

/** Whether a macOS volume folds case. Only the same file under both spellings proves it: any other outcome is strict. */
export const probeFolds = (probe: CaseProbe): boolean => probe === 'same'

/**
 * `path` with the case of the last ASCII letter of its last part flipped, or undefined when that part has none. Only
 * ASCII flips one letter to one letter, so `ß` or `İ` cannot make a folding volume look strict.
 */
export const flipCase = (path: string): string | undefined => {
  const base = path.lastIndexOf('/') + 1
  const at = path.slice(base).search(/[A-Za-z](?=[^A-Za-z]*$)/)
  if (at < 0) return undefined
  const i = base + at
  const c = path[i]!
  return path.slice(0, i) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + path.slice(i + 1)
}

/**
 * The parts of a real path. `\` separates parts only on Windows: on Linux and macOS it is a legal character of a name,
 * so `/home/me/projects\app` is one folder `projects\app` and never the folder `/home/me/projects/app`.
 */
export const realParts = (path: string, platform: string): string[] =>
  path.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter(p => p !== '')

/** The real path as a list of parts. On Windows and macOS with no regard to case. */
const partsOf = (path: string, platform: string, folds: boolean): string[] =>
  realParts(path, platform).map(p => (folds ? fold(p) : p))

/** True when `child` is `parent` or inside it. Both are real paths. `folds`: the volume ignores case. */
export const isInside = (child: string, parent: string, platform: string, folds = foldsCase(platform)): boolean => {
  const c = partsOf(child, platform, folds)
  const p = partsOf(parent, platform, folds)
  return c.length >= p.length && p.every((part, i) => part === c[i])
}

/**
 * Why a real path cannot be a root, or undefined. The text is ours and names no path. A root is never a drive or
 * file system root, the home folder or a folder that holds it, a folder with a built-in excluded name in its path,
 * or, on Windows, a network path.
 */
export const rootProblem = (real: string, home: string, platform: string): string | undefined => {
  const all = realParts(real, platform)
  if (platform === 'win32' && /^[\\/]{2}/.test(real)) return 'it is a network path'
  if (all.length === 0 || (platform === 'win32' && all.length === 1 && /^[A-Za-z]:$/.test(all[0]!)))
    return 'it is a drive or file system root'
  if (isInside(home, real, platform)) return 'it is your home folder or holds it'
  if (builtInExcluded(all)) return 'a part of its path has a name that Workspace never opens, such as .git or .ssh'
  return undefined
}

/** One entry of `workspace.roots`, its path as a real path. `write` has no effect before the editing tools. */
export type RealRoot = { readonly path: string; readonly write: boolean; readonly folds?: boolean }

export type Binding =
  | { readonly ok: true; readonly index: number; readonly root: string }
  | { readonly ok: false; readonly reason: string }

/**
 * The root of a session, from the real path of each entry and of the folder where the client started the server.
 * 1. The start folder is inside entries: the deepest entry gives the grants, and the session root is the start folder.
 * 2. Else exactly one entry: the session root is its path.
 * 3. Else Workspace is unavailable. A start folder alone never grants access.
 */
export const bindRoot = (roots: readonly RealRoot[], start: string, platform: string): Binding => {
  const inside = roots
    .map((root, index) => ({ root, index, depth: realParts(root.path, platform).length }))
    .filter(({ root }) => isInside(start, root.path, platform, root.folds))
    .sort((a, b) => b.depth - a.depth)
  if (inside.length > 0) return { ok: true, index: inside[0]!.index, root: start }
  if (roots.length === 1) return { ok: true, index: 0, root: roots[0]!.path }
  return {
    ok: false,
    reason: `the client started toolscript-mcp in a folder that is in none of the ${roots.length} entries of workspace.roots. Start the client in one of them. ${RESTART_SENTENCE}`,
  }
}

/** The end of each reason that comes from the config: Workspace reads the config one time, so a change needs a restart. */
export const RESTART_SENTENCE =
  'Workspace reads workspace.roots only at its start: after a change, reconnect toolscript-mcp or restart the client.'

// ---------------------------------------------------------------------------------------------------------------
// The config section

/** The `workspace` section of the config, checked by `parseConfig`. */
export type WorkspaceConfig = {
  /** `tasks`: the named tasks of the entry, present only when the entry has some (`run_task`). */
  readonly roots: readonly {
    readonly path: string
    readonly write: boolean
    readonly tasks?: readonly TaskConfig[]
  }[]
  /** Added to the built-in exclusions. */
  readonly exclude: readonly string[]
  /** The folder names that `list` and `search` do not enter. */
  readonly skip: readonly string[]
  /** `false`: `list` and `search` never read the `.gitignore` of the root. Absent: they do. */
  readonly gitignore?: boolean
}

// ---------------------------------------------------------------------------------------------------------------
// The tools

/**
 * What a tool may do. The policy gives each class its default (policy.ts). `read`: runs with no rule. `write`: changes
 * files under the root, so it asks, and an allow rule must name the server or the tool. `exec`: runs project code, so
 * it asks, and only the exact allow rule for its name allows it.
 */
export type ToolClass = 'read' | 'write' | 'exec'

const entryType = { type: 'string', enum: ['file', 'folder', 'link', 'other'] } as const

const pathArg = (description: string) => ({ type: 'string', description }) as const

const hashArg = (description: string) => ({ type: 'string', pattern: '^sha256:[0-9a-f]{64}$', description }) as const

const editsArg = {
  type: 'array',
  minItems: 1,
  maxItems: LIMITS.edits,
  description: 'The replacements. Each old is matched against the file as it was read, so no edit sees another.',
  items: {
    type: 'object',
    properties: {
      old: { type: 'string', description: 'The exact text to replace, with its line ends and spaces.' },
      new: { type: 'string', description: 'The text that replaces it.' },
      all: { type: 'boolean', description: 'Replace each match, not only a single one. Default false.' },
    },
    required: ['old', 'new'],
    additionalProperties: false,
  },
} as const

/** What diff, edit and write return. `applied` is false for diff, and for a call that changed no byte. */
const changeSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    applied: { type: 'boolean' },
    created: { type: 'boolean' },
    changed: { type: 'boolean' },
    oldHash: { type: ['string', 'null'] },
    newHash: { type: 'string' },
    diff: { type: 'string' },
    diffTruncated: { type: 'boolean' },
    added: { type: 'integer' },
    removed: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'path',
    'applied',
    'created',
    'changed',
    'oldHash',
    'newHash',
    'diff',
    'diffTruncated',
    'added',
    'removed',
    'warnings',
  ],
} as const

/** One tool of the provider as tools/list shows it. */
export const WORKSPACE_TOOLS = {
  list: {
    class: 'read',
    description:
      'List files and folders under a folder of the workspace, sorted by path. A link is listed and never entered. Excluded paths such as .git and .env never show. The .gitignore of the root hides names too: name an ignored folder in path to list it. truncated is true when it stopped early (10 s, 20,000 names or 5,000 entries).',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathArg(
          'The folder, relative to the workspace root. Default ".". Name the smallest folder that holds what you look for.',
        ),
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: LIMITS.maxDepth,
          description: 'How many levels to list. Default 1.',
        },
        include: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Globs over paths from the workspace root, also when path is set, such as "src/**/*.ts". * and ? stay inside a part, ** spans parts. A folder that no glob can reach is not read.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, type: entryType, size: { type: 'integer' } },
            required: ['path', 'type'],
          },
        },
        truncated: { type: 'boolean' },
      },
      required: ['entries', 'truncated'],
    },
  },
  search: {
    class: 'read',
    description:
      'Find literal text, not a regular expression, in the text files under a folder. One match for each place, with its line and column. Filter the lines in your program. The .gitignore of the root hides files: name an ignored folder in path to search it. truncated is true when it stopped early (10 s, 20,000 names or maxMatches): the matches are then partial.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text to find, on one line.' },
        path: pathArg(
          'The folder to search, relative to the workspace root. Default ".". Name the smallest folder that holds what you look for.',
        ),
        include: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Globs over paths from the workspace root, also when path is set, such as "src/**/*.ts". * and ? stay inside a part, ** spans parts.',
        },
        ignoreCase: { type: 'boolean', description: 'Default false.' },
        maxMatches: { type: 'integer', minimum: 1, maximum: LIMITS.maxMatches, description: 'Default 200.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        matches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              line: { type: 'integer' },
              column: { type: 'integer' },
              text: { type: 'string' },
            },
            required: ['path', 'line', 'column', 'text'],
          },
        },
        truncated: { type: 'boolean' },
        filesScanned: { type: 'integer' },
        skipped: { type: 'integer' },
      },
      required: ['matches', 'truncated', 'filesScanned', 'skipped'],
    },
  },
  read: {
    class: 'read',
    description:
      'Read one text file whole, with its line ends as they are. Refuses a file over 4 MiB, a binary file, a link and an excluded path. The hash is of the bytes of the file.',
    inputSchema: {
      type: 'object',
      properties: { path: pathArg('The file, relative to the workspace root, with /.') },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        hash: { type: 'string' },
        encoding: { type: 'string', enum: ['utf-8', 'utf-8-bom'] },
        size: { type: 'integer' },
      },
      required: ['path', 'content', 'hash', 'encoding', 'size'],
    },
  },
  stat: {
    class: 'read',
    description: 'Tell what a path is: file, folder, other or missing, and the size of a file. A link is refused.',
    inputSchema: {
      type: 'object',
      properties: { path: pathArg('The path, relative to the workspace root, with /. "." is the root.') },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        type: { type: 'string', enum: ['file', 'folder', 'other', 'missing'] },
        size: { type: 'integer' },
      },
      required: ['path', 'type'],
    },
  },
  // Listed only when the root entry of the session has a valid task. The provider adds the task names to the text.
  run_task: {
    class: 'exec',
    description:
      'Run one named task of this project, such as its tests. The task is fixed in the config: you choose only the name. A non-zero exit code is a result, not an error. One task runs at a time.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The name of the task.' } },
      required: ['task'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        exitCode: { type: ['integer', 'null'] },
        signal: { type: ['string', 'null'] },
        timedOut: { type: 'boolean' },
        ms: { type: 'integer' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        stdoutTruncated: { type: 'boolean' },
        stderrTruncated: { type: 'boolean' },
      },
      required: [
        'task',
        'exitCode',
        'signal',
        'timedOut',
        'ms',
        'stdout',
        'stderr',
        'stdoutTruncated',
        'stderrTruncated',
      ],
    },
  },
  diff: {
    class: 'read',
    description:
      'Preview a change to one file and write nothing. Give edits, as edit takes them, or content (a new file, or with expectedHash a whole replacement). Returns the unified diff, the counts and the hash the file would have.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathArg('The file, relative to the workspace root, with /.'),
        expectedHash: hashArg(
          'The hash that read returned. With content it selects a replacement of an existing file.',
        ),
        edits: editsArg,
        content: { type: 'string', description: 'The whole new text of the file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: changeSchema,
  },
  edit: {
    class: 'write',
    description:
      'Replace exact text in one existing file. Each old is matched against the file as read and must occur once, unless all is true. Needs the hash from read: a changed file fails with stale. Keeps line ends, the byte order mark and the mode. Needs approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathArg('The file, relative to the workspace root, with /.'),
        expectedHash: hashArg('The hash that read returned for this file.'),
        edits: editsArg,
      },
      required: ['path', 'expectedHash', 'edits'],
      additionalProperties: false,
    },
    outputSchema: changeSchema,
  },
  write: {
    class: 'write',
    description:
      'Make a new file, or with expectedHash replace a whole file. Without it, an existing path fails with exists. Makes missing folders. Needs approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathArg('The file, relative to the workspace root, with /.'),
        content: { type: 'string', description: 'The whole text of the file.' },
        expectedHash: hashArg('The hash that read returned, to replace an existing file.'),
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    outputSchema: changeSchema,
  },
} as const

export type WorkspaceToolName = keyof typeof WORKSPACE_TOOLS

export const WORKSPACE_TOOL_NAMES = Object.keys(WORKSPACE_TOOLS) as WorkspaceToolName[]

/** The full names of the tools of one class, as a program calls them. */
export const toolsOfClass = (toolClass: ToolClass): string[] =>
  WORKSPACE_TOOL_NAMES.filter(name => WORKSPACE_TOOLS[name].class === toolClass).map(
    name => `mcp__${WORKSPACE_KEY}__${name}`,
  )

/** The class of the tool `tool` (a full name `mcp__workspace__<tool>`), or undefined for any other name. */
export const workspaceClass = (tool: string): ToolClass | undefined => {
  const prefix = `mcp__${WORKSPACE_KEY}__`
  const name = tool.startsWith(prefix) ? tool.slice(prefix.length) : undefined
  return name !== undefined && Object.hasOwn(WORKSPACE_TOOLS, name)
    ? WORKSPACE_TOOLS[name as WorkspaceToolName].class
    : undefined
}

// ---------------------------------------------------------------------------------------------------------------
// The input of each tool, checked here: the schema is advice to the model, not a check.

export type ListInput = { path: string; depth: number; include: string[] }
export type SearchInput = { query: string; path: string; include: string[]; ignoreCase: boolean; maxMatches: number }
export type PathInput = { path: string }

const bad = (text: string): never => {
  throw new WorkspaceError('bad-input', text)
}

const asObject = (args: unknown, known: readonly string[]): Record<string, unknown> => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return bad('the arguments must be an object')
  const unknown = Object.keys(args).filter(k => !known.includes(k))
  if (unknown.length > 0) return bad(`unknown argument (known: ${known.join(', ')})`)
  return args as Record<string, unknown>
}

const text = (o: Record<string, unknown>, key: string, fallback?: string): string => {
  const v = o[key]
  if (v === undefined && fallback !== undefined) return fallback
  return typeof v === 'string' ? v : bad(`${key} must be a string`)
}

const whole = (o: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number => {
  const v = o[key]
  if (v === undefined) return fallback
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
    ? v
    : bad(`${key} must be a whole number from ${min} to ${max}`)
}

const globs = (o: Record<string, unknown>): string[] => {
  const v = o.include
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > LIMITS.includes)
    return bad(`include must be a list of at most ${LIMITS.includes} globs`)
  v.forEach((g, i) => {
    const problem = globProblem(g)
    if (problem !== undefined) bad(`include[${i}] ${problem}`)
  })
  return v as string[]
}

export const parseListInput = (args: unknown): ListInput => {
  const o = asObject(args, ['path', 'depth', 'include'])
  return { path: text(o, 'path', '.'), depth: whole(o, 'depth', 1, 1, LIMITS.maxDepth), include: globs(o) }
}

export const parseSearchInput = (args: unknown): SearchInput => {
  const o = asObject(args, ['query', 'path', 'include', 'ignoreCase', 'maxMatches'])
  const query = text(o, 'query')
  if (query === '' || query.length > LIMITS.queryChars || /[\r\n]/.test(query))
    bad(`query must be text of 1 to ${LIMITS.queryChars} characters on one line`)
  const ignoreCase = o.ignoreCase
  if (ignoreCase !== undefined && typeof ignoreCase !== 'boolean') bad('ignoreCase must be true or false')
  return {
    query,
    path: text(o, 'path', '.'),
    include: globs(o),
    ignoreCase: ignoreCase === true,
    maxMatches: whole(o, 'maxMatches', LIMITS.defaultMatches, 1, LIMITS.maxMatches),
  }
}

export const parsePathInput = (args: unknown): PathInput => {
  const o = asObject(args, ['path'])
  return { path: text(o, 'path') }
}

export type TaskInput = { task: string }

export const parseTaskInput = (args: unknown): TaskInput => {
  const o = asObject(args, ['task'])
  return { task: text(o, 'task') }
}

// ---------------------------------------------------------------------------------------------------------------
// Pull request B: the input of diff, edit and write

export type Edit = { old: string; new: string; all: boolean }
export type EditInput = { path: string; expectedHash: string; edits: Edit[] }
export type WriteInput = { path: string; content: string; expectedHash?: string }
export type DiffInput = { path: string; expectedHash?: string; edits?: Edit[]; content?: string }

const HASH = /^sha256:[0-9a-f]{64}$/

// A UTF-16 unit of a surrogate pair with no partner. A pattern with no `u` flag reads units, not code points.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

const hash = (o: Record<string, unknown>): string | undefined => {
  const v = o.expectedHash
  if (v === undefined) return undefined
  return typeof v === 'string' && HASH.test(v)
    ? v
    : bad('expectedHash must be sha256: and 64 hex digits, as read returns it')
}

/** The text of a file or of an edit: a string that UTF-8 can hold and that has no NUL. */
const body = (value: unknown, what: string): string => {
  if (typeof value !== 'string') return bad(`${what} must be a string`)
  if (LONE_SURROGATE.test(value))
    throw new WorkspaceError('encoding', `${what} has a lone surrogate, which UTF-8 cannot hold`)
  if (value.includes('\0')) throw new WorkspaceError('binary', `${what} has a NUL character, so it is not text`)
  return value
}

const editList = (value: unknown): Edit[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.edits)
    return bad(`edits must be a list of 1 to ${LIMITS.edits} items`)
  return value.map((item, i) => {
    const o = asObject(item, ['old', 'new', 'all'])
    const old = body(o.old, `edits[${i}].old`)
    if (old === '') bad(`edits[${i}].old must not be empty`)
    const all = o.all
    if (all !== undefined && typeof all !== 'boolean') bad(`edits[${i}].all must be true or false`)
    return { old, new: body(o.new, `edits[${i}].new`), all: all === true }
  })
}

export const parseEditInput = (args: unknown): EditInput => {
  const o = asObject(args, ['path', 'expectedHash', 'edits'])
  const expectedHash = hash(o)
  if (expectedHash === undefined) return bad('expectedHash is required: read the file and pass its hash')
  return { path: text(o, 'path'), expectedHash, edits: editList(o.edits) }
}

export const parseWriteInput = (args: unknown): WriteInput => {
  const o = asObject(args, ['path', 'content', 'expectedHash'])
  const expectedHash = hash(o)
  return {
    path: text(o, 'path'),
    content: body(o.content, 'content'),
    ...(expectedHash !== undefined && { expectedHash }),
  }
}

export const parseDiffInput = (args: unknown): DiffInput => {
  const o = asObject(args, ['path', 'expectedHash', 'edits', 'content'])
  if ((o.edits === undefined) === (o.content === undefined))
    return bad('give edits or content, not both and not neither')
  const expectedHash = hash(o)
  return {
    path: text(o, 'path'),
    ...(expectedHash !== undefined && { expectedHash }),
    ...(o.edits !== undefined && { edits: editList(o.edits) }),
    ...(o.content !== undefined && { content: body(o.content, 'content') }),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Edits and the unified diff. The text of a file is its bytes decoded as UTF-8 with the byte order mark taken off, so
// a change is exact: the new bytes differ from the old only in the replaced ranges.

/** A replaced range of the old text, and the edit that made it (`edit`, an index of `edits`, for the messages). */
export type Range = { readonly start: number; readonly end: number; readonly text: string; readonly edit: number }

/** The places of `old` in `text`. Overlapping places count when `overlap`, which a single edit needs to be sure it is unique. */
const placesOf = (text: string, old: string, overlap: boolean, cap: number): number[] => {
  const found: number[] = []
  for (
    let at = text.indexOf(old);
    at >= 0 && found.length < cap;
    at = text.indexOf(old, at + (overlap ? 1 : old.length))
  )
    found.push(at)
  return found
}

/** The other spelling of the line ends of `old`, when `text` holds `old` only with those: the hint of `no-match`. */
const lineEndHint = (text: string, old: string): string => {
  const lf = old.replace(/\r\n/g, '\n')
  const variants: [string, string][] = [
    [lf, 'LF'],
    [lf.replace(/\n/g, '\r\n'), 'CRLF'],
  ]
  for (const [variant, name] of variants)
    if (variant !== old && text.includes(variant))
      return ` The file has this text with ${name} line ends. Match its line ends in old, or use the same line ends as the file.`
  return ''
}

/**
 * The ranges that `edits` replace in `text`. Each `old` is matched against `text` as it is, never against the result of
 * another edit, so the order of the list changes nothing. Fails with `no-match`, `many-matches` or, for two edits that
 * replace the same text, `bad-input`. Changes nothing.
 */
export const planEdits = (text: string, edits: readonly Edit[]): Range[] => {
  const ranges: Range[] = []
  edits.forEach((e, i) => {
    const at = e.all
      ? placesOf(text, e.old, false, LIMITS.replacements + 1)
      : placesOf(text, e.old, true, LIMITS.replacements + 1)
    if (at.length === 0)
      throw new WorkspaceError('no-match', `edits[${i}].old is not in the file.${lineEndHint(text, e.old)}`)
    if (e.all && at.length > LIMITS.replacements)
      throw new WorkspaceError('bad-input', `edits[${i}].old occurs more than ${LIMITS.replacements} times`)
    if (!e.all && at.length > 1)
      throw new WorkspaceError(
        'many-matches',
        `edits[${i}].old occurs ${at.length > LIMITS.replacements ? `more than ${LIMITS.replacements}` : at.length} times. Add context to old so it occurs once, or set all to true`,
      )
    for (const start of at) ranges.push({ start, end: start + e.old.length, text: e.new, edit: i })
  })
  ranges.sort((a, b) => a.start - b.start || a.edit - b.edit)
  for (let k = 1; k < ranges.length; k++)
    if (ranges[k]!.start < ranges[k - 1]!.end)
      throw new WorkspaceError(
        'bad-input',
        `edits[${ranges[k - 1]!.edit}] and edits[${ranges[k]!.edit}] replace the same text`,
      )
  return ranges
}

/** `text` with the sorted, separate `ranges` replaced. */
export const applyRanges = (text: string, ranges: readonly Range[]): string => {
  let out = ''
  let at = 0
  for (const r of ranges) {
    out += text.slice(at, r.start) + r.text
    at = r.end
  }
  return out + text.slice(at)
}

/** The lines of `text`, each with its own line end. The last has none when the text does not end with a line end. */
const splitLines = (text: string): string[] => {
  const lines: string[] = []
  for (let at = 0; at < text.length; ) {
    const nl = text.indexOf('\n', at)
    const end = nl < 0 ? text.length : nl + 1
    lines.push(text.slice(at, end))
    at = end
  }
  return lines
}

export type DiffResult = { diff: string; diffTruncated: boolean; added: number; removed: number }

type LineChange = { at: number; del: string[]; add: string[] }

/** The line changes of `ranges` in `text`: each changed line whole, then the lines that stay the same at the edges dropped. */
const lineChanges = (text: string, ranges: readonly Range[]): LineChange[] => {
  const lines = splitLines(text)
  const starts: number[] = []
  for (let at = 0, i = 0; i < lines.length; at += lines[i]!.length, i++) starts.push(at)
  // The number of lines that start before `offset`.
  const before = (offset: number): number => {
    let lo = 0
    let hi = starts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid]! < offset) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const endsWithBreak = text.endsWith('\n')
  // The start of the line that holds `offset`. The end of a text with a final line end holds no line.
  const lineStart = (offset: number): number =>
    text.length === 0 || (offset >= text.length && endsWithBreak) ? text.length : starts[before(offset + 1) - 1]!
  const lineEnd = (offset: number): number => {
    if (text.length === 0 || (offset >= text.length && endsWithBreak)) return text.length
    const next = before(offset + 1)
    return next < starts.length ? starts[next]! : text.length
  }
  type Region = { lo: number; hi: number; parts: Range[] }
  const regions: Region[] = []
  for (const r of ranges) {
    const lo = lineStart(r.start)
    const hi = lineEnd(r.end > r.start ? r.end - 1 : r.start)
    const last = regions.at(-1)
    if (last !== undefined && lo < last.hi) {
      last.hi = Math.max(last.hi, hi)
      last.parts.push(r)
    } else regions.push({ lo, hi, parts: [r] })
  }
  const newOf = (lo: number, hi: number, parts: readonly Range[]): string =>
    applyRanges(
      text.slice(lo, hi),
      parts.map(r => ({ ...r, start: r.start - lo, end: r.end - lo })),
    )
  // A region whose new text loses its last line end joins the next line to it: take that line in, and every edit in it.
  for (let k = 0; k < regions.length; k++) {
    const g = regions[k]!
    while (g.hi < text.length && !newOf(g.lo, g.hi, g.parts).endsWith('\n')) {
      g.hi = lineEnd(g.hi)
      while (k + 1 < regions.length && regions[k + 1]!.lo < g.hi) {
        const next = regions.splice(k + 1, 1)[0]!
        g.hi = Math.max(g.hi, next.hi)
        g.parts.push(...next.parts)
      }
    }
  }
  const changes: LineChange[] = []
  for (const { lo, hi, parts } of regions) {
    const old = splitLines(text.slice(lo, hi))
    const now = splitLines(newOf(lo, hi, parts))
    let head = 0
    while (head < old.length && head < now.length && old[head] === now[head]) head++
    let tail = 0
    while (
      tail < old.length - head &&
      tail < now.length - head &&
      old[old.length - 1 - tail] === now[now.length - 1 - tail]
    )
      tail++
    const del = old.slice(head, old.length - tail)
    const add = now.slice(head, now.length - tail)
    if (del.length + add.length > 0) changes.push({ at: before(lo) + head, del, add })
  }
  return changes
}

const shownLine = (mark: string, line: string): string =>
  line.endsWith('\n') ? `${mark}${line}` : `${mark}${line}\n\\ No newline at end of file\n`

/**
 * The unified diff of `ranges` in `text`, with `LIMITS.context` lines of context, cut at `LIMITS.diffChars`. It comes
 * from the changed ranges, with no search for a shorter edit script. `text` is undefined for a new file.
 */
export const unifiedDiff = (path: string, text: string | undefined, ranges: readonly Range[]): DiffResult => {
  const old = text ?? ''
  const changes = lineChanges(old, ranges)
  const added = changes.reduce((n, c) => n + c.add.length, 0)
  const removed = changes.reduce((n, c) => n + c.del.length, 0)
  const all = splitLines(old)
  const out: string[] = []
  const reach = 2 * LIMITS.context
  let delta = 0
  for (let i = 0; i < changes.length; ) {
    let j = i
    while (j + 1 < changes.length && changes[j + 1]!.at - (changes[j]!.at + changes[j]!.del.length) <= reach) j++
    const group = changes.slice(i, j + 1)
    const first = group[0]!
    const from = Math.max(0, first.at - LIMITS.context)
    const body: string[] = []
    let cursor = from
    for (const c of group) {
      for (; cursor < c.at; cursor++) body.push(shownLine(' ', all[cursor]!))
      for (const line of c.del) body.push(shownLine('-', line))
      for (const line of c.add) body.push(shownLine('+', line))
      cursor = c.at + c.del.length
    }
    const stop = Math.min(all.length, cursor + LIMITS.context)
    for (; cursor < stop; cursor++) body.push(shownLine(' ', all[cursor]!))
    const dels = group.reduce((n, c) => n + c.del.length, 0)
    const adds = group.reduce((n, c) => n + c.add.length, 0)
    const oldCount = stop - from
    const newCount = oldCount - dels + adds
    const newFrom = from + delta
    out.push(
      `@@ -${oldCount === 0 ? from : from + 1},${oldCount} +${newCount === 0 ? newFrom : newFrom + 1},${newCount} @@\n`,
      ...body,
    )
    delta += adds - dels
    i = j + 1
  }
  const header =
    text === undefined ? `--- /dev/null\n+++ b/${path}\n` : out.length > 0 ? `--- a/${path}\n+++ b/${path}\n` : ''
  const whole = header + out.join('')
  if (whole.length <= LIMITS.diffChars) return { diff: whole, diffTruncated: false, added, removed }
  const cut = whole.slice(0, LIMITS.diffChars)
  return { diff: cut.slice(0, cut.lastIndexOf('\n') + 1), diffTruncated: true, added, removed }
}

/** What a model should know about the line ends of a change that mixes them. */
export const lineEndWarnings = (before: string, after: string): string[] => {
  const style = (t: string) => ({ crlf: /\r\n/.test(t), bare: /(?<!\r)\n/.test(t) })
  const [b, a] = [style(before), style(after)]
  if (b.crlf && !b.bare && a.bare) return ['The new text has LF line ends in a file that has CRLF line ends.']
  if (b.bare && !b.crlf && a.crlf) return ['The new text has CRLF line ends in a file that has LF line ends.']
  return []
}

/** What diff, edit and write return. `oldHash` is null for a new file. */
export type Change = {
  path: string
  applied: boolean
  created: boolean
  changed: boolean
  oldHash: string | null
  newHash: string
  diff: string
  diffTruncated: boolean
  added: number
  removed: number
  warnings: string[]
}

/** One applied change as the run result and the run log list it. */
export type AppliedChange = {
  readonly path: string
  readonly added: number
  readonly removed: number
  readonly created: boolean
}

/** The applied change in the result of a tool, or undefined when `value` is no change that was applied. */
export const appliedChange = (value: unknown): AppliedChange | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const { path, applied, created, added, removed } = value as Record<string, unknown>
  return applied === true &&
    typeof path === 'string' &&
    typeof created === 'boolean' &&
    Number.isSafeInteger(added) &&
    Number.isSafeInteger(removed)
    ? { path, created, added: added as number, removed: removed as number }
    : undefined
}
