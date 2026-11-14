// Where toolscript-mcp keeps its files: the folder .toolscript-mcp in HOME
// (the person's) and in the project root. Every path into it is made here, so
// the loaders and the hint-file guard always name the same folders.
// tests/code.check.mjs fails when another file in src/core types one out.

const APP = '.toolscript-mcp'
const HINTS = 'hints'
const FUNCTIONS = 'functions'

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

/**
 * The folders whose files steer the model, as written: the person's and the
 * project's hints (the project's even while projectHints is off, so none can
 * be planted to load later), and the person's saved functions. The model's
 * file tools may not write them. An empty root has none.
 * The plugin's own folder holds its code and its bundled hints: it is guarded
 * where Claude Code installed it, under HOME. A folder loaded with --plugin-dir
 * is the person's own checkout, which they edit.
 */
export const guardedDirs = (home: string, project: string, pluginRoot = ''): string[] => {
  const plugin = normalizePath(pluginRoot)
  const plugins = normalizePath(`${home}/.claude/plugins`)
  return [
    ...(home ? [hintsFolder(home), functionsFolder(home)] : []),
    ...(project ? [hintsFolder(project)] : []),
    ...(home && plugin.startsWith(`${plugins}/`) ? [plugin] : []),
  ]
}
