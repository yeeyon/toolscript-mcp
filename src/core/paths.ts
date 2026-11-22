// Where toolscript-mcp keeps its files: the folder .toolscript-mcp in HOME
// (the person's) and in the project root. Every path into it is made here, so
// the loaders and the hint-file guard always name the same folders.
// tests/code.check.mjs fails when another file in src/core types one out.

const APP = '.toolscript-mcp'
const HINTS = 'hints'
const FUNCTIONS = 'functions'
const LEARNED = 'learned'
const OAUTH = 'oauth'
const BROKER = 'broker'

/**
 * An absolute path with empty, `.` and `..` parts resolved. A Windows path
 * with a drive (`C:\Users\u` or `C:/Users/u`) keeps its drive and comes back
 * with forward slashes.
 */
export const normalizePath = (path: string): string => {
  const drive = /^[A-Za-z]:(?=[\\/]|$)/.exec(path)?.[0]
  const rest = drive === undefined ? path : path.slice(drive.length).replaceAll('\\', '/')
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${drive ?? ''}/${parts.join('/')}`
}

/**
 * A path in toolscript-mcp's folder under `root`: HOME or the project root. It
 * is normalized, as isUnder needs: HOME can end in a slash or hold a double one.
 */
export const appPath = (root: string, ...parts: string[]): string => normalizePath([root, APP, ...parts].join('/'))

/** The hint folder under HOME or the project root. */
export const hintsFolder = (root: string): string => appPath(root, HINTS)

/** The saved-function folder under HOME. */
export const functionsFolder = (home: string): string => appPath(home, FUNCTIONS)

/** The run log under HOME, and the one old file that rotation keeps. */
export const runLogFile = (home: string): string => appPath(home, 'runs.jsonl')
export const oldRunLogFile = (home: string): string => appPath(home, 'runs.1.jsonl')

/** The folder of the OAuth stores under HOME. */
export const oauthFolder = (home: string): string => appPath(home, OAUTH)

/**
 * The OAuth store of one HTTP server under HOME. `urlHash` is a hash of its URL, so a changed URL never gets the
 * tokens of the old one. A server key holds only letters, digits, `-` and `_`, so it is a safe file name.
 */
export const oauthFile = (home: string, key: string, urlHash: string): string =>
  `${oauthFolder(home)}/${key}-${urlHash}.json`

/**
 * The folder of the learned files under HOME: the result shapes and the tool lists of lazy servers. The guard on the
 * folder covers both, and nothing else.
 */
export const shapesFolder = (home: string): string => appPath(home, LEARNED)

/** The learned result shapes under HOME: what `search_tools` shows as `returned earlier`, kept across sessions. */
export const shapesFile = (home: string): string => `${shapesFolder(home)}/shapes.json`

/**
 * The last `tools/list` of each lazy server under HOME (issue #63, slice 5), keyed by a hash of its launch. It is for
 * display only: `search_tools` shows a server that is asleep with it, and no check reads it.
 */
export const toolsFile = (home: string): string => `${shapesFolder(home)}/tools.json`

/**
 * The folder of the shared-server broker under HOME (issue #63): its key file, its log and, outside Windows, its
 * socket. The key file is alone in it with them, so a guard on the folder covers nothing else.
 */
export const brokerFolder = (home: string): string => appPath(home, BROKER)

/**
 * The text that names a guarded folder in any root: `.toolscript-mcp/hints` and the four others, never the bare
 * `.toolscript-mcp`, which also holds `files/`, the run log and the config. `src/core/guard.ts` looks for them in
 * the text of a call, where `~`, `$HOME` or a relative path hides the root.
 */
export const GUARD_MARKERS: readonly string[] = [HINTS, FUNCTIONS, LEARNED, OAUTH, BROKER].map(name => `${APP}/${name}`)

/**
 * The folders whose files steer the model, or hold its secrets, as written: the person's and the
 * project's hints (the project's even while projectHints is off, so none can
 * be planted to load later), the person's saved functions, the person's
 * learned shapes and the person's OAuth stores. A nested call may not name them
 * (`src/core/guard.ts`). An empty root has none.
 * The plugin's own folder holds its code and its bundled hints: it is guarded
 * where Claude Code installed it, under HOME. A folder loaded with --plugin-dir
 * is the person's own checkout, which they edit.
 */
export const guardedDirs = (home: string, project: string, pluginRoot = ''): string[] => {
  const plugin = normalizePath(pluginRoot)
  const plugins = normalizePath(`${home}/.claude/plugins`)
  return [
    ...(home
      ? [hintsFolder(home), functionsFolder(home), shapesFolder(home), oauthFolder(home), brokerFolder(home)]
      : []),
    ...(project ? [hintsFolder(project)] : []),
    ...(home && plugin.startsWith(`${plugins}/`) ? [plugin] : []),
  ]
}
