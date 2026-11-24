// The built-in Workspace (issue #144): the tools that read one approved folder, as the model sees them, and the pure
// rules behind them: the tool table, the limits, the check of a path text, the globs, the exclusions, the refusal of a
// root and the binding of a session to its root. The code that touches files is in src/host/workspace/.
// The table holds a class for each tool, so a later tool is one more entry (decision 144).

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

/** The path as the tools show it: the parts with `/`, and `.` for the root. */
export const showPath = (parts: readonly string[]): string => (parts.length === 0 ? '.' : parts.join('/'))

// ---------------------------------------------------------------------------------------------------------------
// Exclusions

// The names that no tool reads, lists or writes, whatever their folder. Version control data, secrets, and the
// settings and hooks of clients.
const BUILT_IN_NAMES: readonly string[] = [
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

/** The real path as a list of parts, `/` and `\` alike. On Windows and macOS with no regard to case. */
const partsOf = (path: string, platform: string): string[] =>
  path
    .split(/[\\/]+/)
    .filter(p => p !== '')
    .map(p => (foldsCase(platform) ? fold(p) : p))

/** True when `child` is `parent` or inside it. Both are real paths. */
export const isInside = (child: string, parent: string, platform: string): boolean => {
  const c = partsOf(child, platform)
  const p = partsOf(parent, platform)
  return c.length >= p.length && p.every((part, i) => part === c[i])
}

/**
 * Why a real path cannot be a root, or undefined. The text is ours and names no path. A root is never a drive or
 * file system root, the home folder or a folder that holds it, a folder with a built-in excluded name in its path,
 * or, on Windows, a network path.
 */
export const rootProblem = (real: string, home: string, platform: string): string | undefined => {
  const all = real.split(/[\\/]+/).filter(p => p !== '')
  if (platform === 'win32' && /^[\\/]{2}/.test(real)) return 'it is a network path'
  if (all.length === 0 || (platform === 'win32' && all.length === 1 && /^[A-Za-z]:$/.test(all[0]!)))
    return 'it is a drive or file system root'
  if (isInside(home, real, platform)) return 'it is your home folder or holds it'
  if (builtInExcluded(all)) return 'a part of its path has a name that Workspace never opens, such as .git or .ssh'
  return undefined
}

/** One entry of `workspace.roots`, its path as a real path. `write` has no effect before the editing tools. */
export type RealRoot = { readonly path: string; readonly write: boolean }

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
    .map((root, index) => ({ root, index, depth: partsOf(root.path, platform).length }))
    .filter(({ root }) => isInside(start, root.path, platform))
    .sort((a, b) => b.depth - a.depth)
  if (inside.length > 0) return { ok: true, index: inside[0]!.index, root: start }
  if (roots.length === 1) return { ok: true, index: 0, root: roots[0]!.path }
  return {
    ok: false,
    reason: `the client started toolscript-mcp in a folder that is in none of the ${roots.length} entries of workspace.roots. Start the client in one of them, or keep one entry`,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The config section

/** The `workspace` section of the config, checked by `parseConfig`. */
export type WorkspaceConfig = {
  readonly roots: readonly { readonly path: string; readonly write: boolean }[]
  /** Added to the built-in exclusions. */
  readonly exclude: readonly string[]
  /** The folder names that `list` and `search` do not enter. */
  readonly skip: readonly string[]
}

// ---------------------------------------------------------------------------------------------------------------
// The tools

/** What a tool may do. The policy gives each class its default (policy.ts). A later class is one more entry. */
export type ToolClass = 'read'

const entryType = { type: 'string', enum: ['file', 'folder', 'link', 'other'] } as const

const pathArg = (description: string) => ({ type: 'string', description }) as const

/** One tool of the provider as tools/list shows it. */
export const WORKSPACE_TOOLS = {
  list: {
    class: 'read',
    description:
      'List files and folders under a folder of the workspace, sorted by path. A link is listed and never entered. Excluded paths such as .git and .env never show.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathArg('The folder, relative to the workspace root, with /. Default ".".'),
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
            'Globs over paths from the root, such as "src/**/*.ts". * and ? stay inside a part, ** spans parts.',
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
      'Find literal text, not a regular expression, in the text files under a folder. One match for each place, with its line and column. Filter the lines in your program.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text to find, on one line.' },
        path: pathArg('The folder, relative to the workspace root. Default ".".'),
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Globs over paths from the root, such as "src/**/*.ts".',
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
} as const

export type WorkspaceToolName = keyof typeof WORKSPACE_TOOLS

export const WORKSPACE_TOOL_NAMES = Object.keys(WORKSPACE_TOOLS) as WorkspaceToolName[]

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
