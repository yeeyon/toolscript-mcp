// toolscript-mcp init: the MCP servers in the config files of Claude Code,
// Claude Desktop and Cursor, merged into one toolscript-mcp config, and the
// steps that move each client to toolscript. The host reads the client files
// and writes the config. Nothing here prints a value of env or headers, or a
// secret that hideArgSecrets finds in args or hideUrlSecrets in URLs.

import {
  hideArgSecrets,
  hideUrlSecrets,
  launchArgv,
  launchText,
  parseJson,
  pathWord,
  serverKey,
  shellWord,
  urlOrigin,
  type Env,
  type Launch,
  type ServerKey,
} from './config.ts'
import { printable, shownName } from './policy.ts'

export type ClientId = 'claude-code' | 'claude-desktop' | 'cursor'

const CLIENT_NAME: Readonly<Record<ClientId, string>> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
}

/** The scope of a Claude Code server. The other clients have none. */
export type Scope = 'local' | 'project' | 'user'

export type ClientFile = {
  readonly client: ClientId
  readonly path: string
  readonly scope?: Scope
  /** Local and project scope: the folder of the project. Its entry in `projects` holds the local servers. */
  readonly project?: string
}

/**
 * The config file of each client, in the order of import: when two clients
 * have a server with the same key, the first one wins. Claude Code: the
 * user-scope servers of `~/.claude.json` only.
 */
export const clientFiles = (env: Env, platform: string, home: string): ClientFile[] => {
  const desktop =
    platform === 'win32'
      ? `${env.APPDATA || `${home}/AppData/Roaming`}/Claude`
      : platform === 'darwin'
        ? `${home}/Library/Application Support/Claude`
        : `${env.XDG_CONFIG_HOME || `${home}/.config`}/Claude`
  return [
    { client: 'claude-code', scope: 'user', path: claudeJson(env, home) },
    { client: 'claude-desktop', path: `${desktop}/claude_desktop_config.json` },
    { client: 'cursor', path: `${home}/.cursor/mcp.json` },
  ]
}

const claudeJson = (env: Env, home: string) => `${env.CLAUDE_CONFIG_DIR || home}/.claude.json`

/**
 * The files of `clientFiles` after the Claude Code scopes of the folder `project`, in the order in which Claude Code
 * picks a server that two scopes define: local, project, user. The project files go from the closest.
 */
export const scopedFiles = (env: Env, platform: string, home: string, project: ProjectFolders): ClientFile[] => [
  { client: 'claude-code', scope: 'local', path: claudeJson(env, home), project: project.local },
  ...project.shared.map(
    (dir): ClientFile => ({ client: 'claude-code', scope: 'project', path: `${dir}/.mcp.json`, project: dir }),
  ),
  ...clientFiles(env, platform, home),
]

/**
 * The folders that Claude Code reads for a session started in the folder `start`. `local`: the key of the local
 * scope in `.claude.json`, the root of the main checkout (also for a subfolder or a git worktree), or the folder
 * itself outside git. `shared`: the folders whose `.mcp.json` it reads, `start` and each parent up to the root.
 */
export type ProjectFolders = { readonly start: string; readonly local: string; readonly shared: readonly string[] }

/**
 * The root of the main checkout for a worktree whose `.git` file holds `gitdir: <main>/.git/worktrees/<name>`, or
 * undefined for another `.git` file, such as the one of a submodule, also of a submodule in a worktree.
 */
export const mainCheckoutOf = (dotGitFile: string): string | undefined => {
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(dotGitFile)?.[1]?.replace(/\\/g, '/').replace(/\/+$/, '')
  const at = gitdir === undefined ? undefined : /\/\.git\/worktrees\/[^/]+$/.exec(gitdir)?.index
  return at ? gitdir!.slice(0, at) : undefined
}

/** True when `key` names the folder `project`. Windows paths match with `/` and `\` as one, in any case. */
export const sameFolder = (key: string, project: string, platform: string): boolean => {
  const norm = (p: string) => {
    const path = platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p
    return path.length > 1 ? path.replace(/\/+$/, '') : path
  }
  return norm(key) === norm(project)
}

/** The value of `--from`: `claude-code:local`, or a client alone for the clients without a scope. */
export const sourceName = (file: ClientFile): string => (file.scope ? `${file.client}:${file.scope}` : file.client)

export type ClientRead = ClientFile &
  (
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'missing' }
    | { readonly kind: 'unreadable'; readonly error: string }
  )

type StringMap = Readonly<Record<string, string>>

/** A server as the toolscript-mcp config writes it. `${VAR}` stays as the client file has it. */
export type Entry =
  | {
      readonly command: string
      readonly args?: readonly string[]
      readonly env?: StringMap
      readonly cwd?: string
      readonly untrusted?: true
    }
  | { readonly type: 'http'; readonly url: string; readonly headers?: StringMap; readonly untrusted?: true }

/** What init did with one server of a client file. */
type Outcome =
  | { readonly kind: 'imported'; readonly name: string; readonly key: ServerKey; readonly dropped: readonly string[] }
  /** The same entry as in an earlier client: the config has it already. */
  | { readonly kind: 'same'; readonly name: string }
  | { readonly kind: 'conflict'; readonly name: string; readonly key: ServerKey; readonly keptFrom: ClientId }
  /** toolscript itself: the new toolscript entry replaces it. */
  | { readonly kind: 'self'; readonly name: string }
  | { readonly kind: 'skipped'; readonly name: string; readonly why: string }

type ClientResult = {
  readonly file: ClientFile
  /** Why init read no server from the file. */
  readonly problem?: string
  readonly outcomes: readonly Outcome[]
}

export type Import = { readonly servers: ReadonlyMap<ServerKey, Entry>; readonly clients: readonly ClientResult[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
const isStringMap = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.values(v).every(s => typeof s === 'string')

/** A key such as `my-notes` for a client name such as "my notes", or undefined when no key fits. */
const keyOf = (name: string): ServerKey | undefined =>
  serverKey(
    name
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, ''),
  )

// The package (`npx -y toolscript-mcp@1`), its bin, or the built entry of a clone.
// Not any path with toolscript-mcp in it: a clone holds other servers too.
const SELF = /(^|[\\/])toolscript-mcp(@[^\\/]*)?(\.cmd)?$|toolscript-mcp[\\/]dist[\\/]host[\\/]main\.js$/i

const isSelf = (name: string, raw: unknown): boolean =>
  name.toLowerCase() === 'toolscript' ||
  (isObject(raw) &&
    [raw.command, ...(Array.isArray(raw.args) ? raw.args : [])].some(a => typeof a === 'string' && SELF.test(a)))

// An Azure DevOps MCP server returns text from outside sources: work items, wikis, pull requests. It can start as the
// package @azure-devops/mcp, its bin mcp-server-azuredevops, a clone, a community package, the remote server through
// mcp-remote, or a local bridge, so any mention counts. A server that this marks by mistake only gets more wrappers.
const AZURE_DEVOPS = /azure[-_ ]?devops|mcp\.dev\.azure\.com/i

/** True when the key, the command, an argument or the URL of a server names Azure DevOps. */
const namesAzureDevOps = (key: ServerKey, entry: Entry): boolean =>
  [key, ...('type' in entry ? [entry.url] : [entry.command, ...(entry.args ?? [])])].some(t => AZURE_DEVOPS.test(t))

const STDIO_KEYS = ['type', 'command', 'args', 'env', 'cwd', 'disabled']
const HTTP_KEYS = ['type', 'url', 'headers', 'disabled']

const extraKeys = (raw: Record<string, unknown>, known: readonly string[]): string[] =>
  Object.keys(raw).filter(k => !known.includes(k))

const nonEmpty = (map: Record<string, string> | undefined): StringMap | undefined =>
  map === undefined || Object.keys(map).length === 0 ? undefined : Object.fromEntries(Object.entries(map))

const toEntry = (raw: unknown): { entry: Entry; dropped: string[] } | { why: string } => {
  if (!isObject(raw)) return { why: 'not an object' }
  if (raw.disabled === true) return { why: 'disabled in this client' }
  const type = raw.type ?? (raw.command === undefined && raw.url !== undefined ? 'http' : 'stdio')
  if (type === 'stdio') {
    const { command, args, env, cwd } = raw
    if (typeof command !== 'string' || command.trim() === '') return { why: 'no command' }
    if (args !== undefined && !isStrings(args)) return { why: '"args" is not a list of strings' }
    if (env !== undefined && !isStringMap(env)) return { why: '"env" is not an object of strings' }
    if (cwd !== undefined && typeof cwd !== 'string') return { why: '"cwd" is not a string' }
    const map = nonEmpty(env)
    const entry = {
      command,
      ...(args?.length ? { args: [...args] } : {}),
      ...(map ? { env: map } : {}),
      ...(cwd ? { cwd } : {}),
    }
    return { entry, dropped: extraKeys(raw, STDIO_KEYS) }
  }
  if (type === 'http') {
    const { url, headers } = raw
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { why: 'no http:// or https:// url' }
    if (headers !== undefined && !isStringMap(headers)) return { why: '"headers" is not an object of strings' }
    const map = nonEmpty(headers)
    return { entry: { type: 'http', url, ...(map ? { headers: map } : {}) }, dropped: extraKeys(raw, HTTP_KEYS) }
  }
  if (type === 'sse') return { why: 'type "sse": toolscript-mcp connects over stdio and streamable HTTP only' }
  return { why: `type ${JSON.stringify(type)} is not supported` }
}

const NO_FILE = 'no file'

/** The entry of the folder `folder` in `projects` of `.claude.json`. */
const projectOf = (claudeJson: Record<string, unknown>, folder: string, platform: string): unknown => {
  const { projects } = claudeJson
  if (!isObject(projects)) return undefined
  const key = Object.keys(projects).find(k => sameFolder(k, folder, platform))
  return key === undefined ? undefined : projects[key]
}

/** The `mcpServers` of one client file, or why there are none. Local scope: the entry of its folder in `projects`. */
const serversOf = (read: ClientRead, platform: string): { problem: string } | { servers: [string, unknown][] } => {
  if (read.kind === 'missing') return { problem: NO_FILE }
  if (read.kind === 'unreadable') return { problem: `cannot read it: ${read.error}` }
  const json = parseJson(read.text)
  if (!json.ok) return { problem: `not valid JSON${json.where}` }
  if (!isObject(json.value)) return { problem: 'not a JSON object' }
  let holder = json.value
  if (read.scope === 'local') {
    const project = read.project ?? ''
    const entry = projectOf(json.value, project, platform)
    if (entry === undefined) return { servers: [] }
    if (!isObject(entry)) return { problem: `the entry of ${project} in "projects" is not an object` }
    holder = entry
  }
  const list = holder.mcpServers
  if (list === undefined) return { servers: [] }
  return isObject(list) ? { servers: Object.entries(list) } : { problem: '"mcpServers" is not an object' }
}

/** One server of a client file, as the toolscript-mcp config would hold it, or why it cannot. */
type Parsed =
  | { readonly kind: 'entry'; readonly key: ServerKey; readonly entry: Entry; readonly dropped: readonly string[] }
  | { readonly kind: 'self' }
  | { readonly kind: 'skipped'; readonly why: string }

/**
 * Claude Code 2.1 starts each stdio server of the local or project scope in the folder `start` of the session, and
 * does not read the `cwd` of the entry. toolscript-mcp starts in the folder of its client, so the entry gets `start`
 * as its `cwd`, and its own `cwd` is left out.
 */
const startIn = (parsed: { entry: Entry; dropped: string[] }, start: string | undefined) => {
  const { entry, dropped } = parsed
  if (start === undefined || 'type' in entry) return parsed
  return { entry: { ...entry, cwd: start }, dropped: entry.cwd === undefined ? dropped : [...dropped, 'cwd'] }
}

const parseServer = (name: string, raw: unknown, start: string | undefined): Parsed => {
  if (isSelf(name, raw)) return { kind: 'self' }
  const parsed = toEntry(raw)
  if ('why' in parsed) return { kind: 'skipped', why: parsed.why }
  const key = keyOf(name)
  if (key === undefined) return { kind: 'skipped', why: 'no letter or digit to make a server key of' }
  const { entry: started, dropped } = startIn(parsed, start)
  const entry: Entry = namesAzureDevOps(key, started) ? { ...started, untrusted: true } : started
  return { kind: 'entry', key, entry, dropped }
}

/** What Claude Code decided about a server of a `.mcp.json` file. It runs only an approved one. */
export type Approval = 'approved' | 'not approved' | 'disabled'

/**
 * The text of the files that hold the choices of Claude Code 2.1 on the servers of `.mcp.json` files, or undefined
 * for no file. Checked with `claude mcp list` in a temp CLAUDE_CONFIG_DIR.
 */
export type ApprovalFiles = {
  /** `.claude.json`: the choices in the entry of the local-scope project, and the trusted folders. */
  readonly claudeJson: string | undefined
  /** The user settings. They count in any folder. */
  readonly user: string | undefined
  /** `.claude/settings.json` of the start folder, not of a parent. */
  readonly shared: string | undefined
  /** `.claude/settings.local.json` of the start folder, not of a parent. */
  readonly local: string | undefined
}

/** The paths of the settings files of `ApprovalFiles`. */
export const settingsFiles = (env: Env, home: string, start: string) => ({
  user: `${env.CLAUDE_CONFIG_DIR || `${home}/.claude`}/settings.json`,
  shared: `${start}/.claude/settings.json`,
  local: `${start}/.claude/settings.local.json`,
})

const objectOf = (text: string | undefined): Record<string, unknown> | undefined => {
  const json = text === undefined ? undefined : parseJson(text)
  return json?.ok && isObject(json.value) ? json.value : undefined
}

const lists = (holder: unknown, key: string, name: string): boolean =>
  isObject(holder) && Array.isArray(holder[key]) && holder[key].includes(name)

const enablesAll = (holder: unknown): boolean | undefined =>
  isObject(holder) && typeof holder.enableAllProjectMcpServers === 'boolean'
    ? holder.enableAllProjectMcpServers
    : undefined

/**
 * The approval of each `.mcp.json` server for a session started in `folders.start`, as Claude Code 2.1 decides it.
 * A list of disabled servers in any of the files disables it, also in a folder that is not trusted. Else a list of
 * enabled servers approves it, or `enableAllProjectMcpServers` of the last file that sets it, in the order user,
 * shared, local. The project files and the project entry in `.claude.json` count only in a trusted folder: one that
 * has `hasTrustDialogAccepted` on it or on a parent up to the project root. Claude Code moves `true` of the entry
 * into the local settings of the start folder when they do not set it, and drops `false`. Claude Code can also
 * approve a server in a way that init does not read, such as managed settings: init then shows it as not approved,
 * and `--unapproved` adds it.
 */
export const approvals = (
  files: ApprovalFiles,
  folders: ProjectFolders,
  platform: string,
): ((name: string) => Approval) => {
  const claude = objectOf(files.claudeJson)
  const entry = (dir: string) => (claude === undefined ? undefined : projectOf(claude, dir, platform))
  const project = entry(folders.local)
  const user = objectOf(files.user)
  const shared = objectOf(files.shared)
  const local = objectOf(files.local)
  const root = folders.shared.findIndex(dir => sameFolder(dir, folders.local, platform))
  const trusted = folders.shared.slice(0, root === -1 ? 1 : root + 1).some(dir => {
    const e = entry(dir)
    return isObject(e) && e.hasTrustDialogAccepted === true
  })
  const moved = enablesAll(project) === true ? true : undefined
  const all = [enablesAll(user), ...(trusted ? [enablesAll(shared), enablesAll(local) ?? moved] : [])]
  const approvesAll = all.findLast(v => v !== undefined) === true
  const enabling = trusted ? [user, shared, local, project] : [user]
  return name => {
    if ([user, shared, local, project].some(h => lists(h, 'disabledMcpjsonServers', name))) return 'disabled'
    if (approvesAll || enabling.some(h => lists(h, 'enabledMcpjsonServers', name))) return 'approved'
    return 'not approved'
  }
}

/**
 * A server that init found in a client file: where, its name there, and its entry. `hiddenBy`: the Claude Code scope
 * whose server of the same name Claude Code runs instead of this one. `approval`: of a project-scope server only.
 */
export type Candidate = {
  readonly file: ClientFile
  readonly name: string
  readonly parsed: Parsed
  readonly hiddenBy?: Scope
  readonly approval?: Approval
}

/** The servers of one client file, or why init read none. */
export type FileServers = {
  readonly file: ClientFile
  readonly problem?: string
  readonly candidates: readonly Candidate[]
}

/** The servers of one client file. A stdio server of the local or project scope starts in `start`. */
const fileServers = (read: ClientRead, platform: string, start?: string): FileServers => {
  const { client, path, scope, project } = read
  const file: ClientFile = { client, path, ...(scope && { scope }), ...(project !== undefined && { project }) }
  const found = serversOf(read, platform)
  if ('problem' in found) return { file, problem: found.problem, candidates: [] }
  const folder = scope === 'local' || scope === 'project' ? start : undefined
  const parse = ([name, raw]: [string, unknown]) => ({ file, name, parsed: parseServer(name, raw, folder) })
  return { file, candidates: found.servers.map(parse) }
}

/**
 * The servers of the files of `scopedFiles` for a session started in `start`. Claude Code 2.1 runs the server of a
 * name from the first of its files in that order, but skips a project server that is not approved. Each other server
 * of the name is hidden by the scope that Claude Code runs. With no such scope, the closest project server hides the
 * farther ones: Claude Code runs it once approved.
 */
export const scopedServers = (
  reads: readonly ClientRead[],
  platform: string,
  start: string,
  approval: (name: string) => Approval,
): FileServers[] => {
  const files = reads.map(read => fileServers(read, platform, start))
  const runs = new Map<string, Scope>()
  for (const { file, candidates } of files)
    for (const { name } of candidates)
      if (file.scope && !runs.has(name) && (file.scope !== 'project' || approval(name) === 'approved'))
        runs.set(name, file.scope)
  const placed = new Set<string>()
  return files.map(servers => {
    const { scope } = servers.file
    if (scope === undefined) return servers
    const candidates = servers.candidates.map(c => {
      const head = runs.get(c.name) ?? 'project'
      const hiddenBy = scope === head && !placed.has(c.name) ? undefined : head
      if (hiddenBy === undefined) placed.add(c.name)
      return {
        ...c,
        ...(hiddenBy && { hiddenBy }),
        ...(scope === 'project' && { approval: approval(c.name) }),
      }
    })
    return { ...servers, candidates }
  })
}

/** The servers of every client file, merged by key: the first client wins, and a different entry with the same key is a conflict. */
export const importServers = (reads: readonly ClientRead[], platform: string): Import => {
  const kept = new Map<ServerKey, { entry: Entry; from: ClientId; json: string }>()
  const clients = reads.map((read): ClientResult => {
    const { file, problem, candidates } = fileServers(read, platform)
    if (problem !== undefined) return { file, problem, outcomes: [] }
    const outcomes = candidates.map(({ name, parsed }): Outcome => {
      if (parsed.kind !== 'entry') return { ...parsed, name }
      const { key, entry } = parsed
      const json = JSON.stringify(entry)
      const earlier = kept.get(key)
      if (earlier === undefined) {
        kept.set(key, { entry, from: read.client, json })
        return { kind: 'imported', name, key, dropped: parsed.dropped }
      }
      return earlier.json === json ? { kind: 'same', name } : { kind: 'conflict', name, key, keptFrom: earlier.from }
    })
    return { file, outcomes }
  })
  return { servers: new Map([...kept].map(([key, k]) => [key, k.entry])), clients }
}

const masked = (entry: Entry): Entry => {
  const hide = (map: StringMap | undefined) => map && Object.fromEntries(Object.keys(map).map(k => [k, '***']))
  if ('type' in entry)
    return {
      ...entry,
      url: hideUrlSecrets(entry.url).url,
      ...(entry.headers && { headers: hide(entry.headers) }),
    }
  return {
    ...entry,
    ...(entry.args && { args: hideArgSecrets(entry.args).args }),
    ...(entry.env && { env: hide(entry.env) }),
  }
}

const configObject = (servers: ReadonlyMap<ServerKey, Entry>, mask: boolean) => ({
  mcpServers: Object.fromEntries([...servers].map(([key, entry]) => [key, mask ? masked(entry) : entry])),
  policy: [],
})

/** The toolscript-mcp config of the imported servers, with an empty policy. `mask` hides the secrets for the screen. */
export const configText = (servers: ReadonlyMap<ServerKey, Entry>, mask: boolean): string =>
  `${JSON.stringify(configObject(servers, mask), null, 2)}\n`

/**
 * The report lines on the old config in `oldText`, which `bak` keeps: the top-level keys and the servers that the
 * new config of `servers` leaves out or has with a different value. Names only, no value.
 */
export const oldConfigReport = (oldText: string, servers: ReadonlyMap<ServerKey, Entry>, bak: string): string[] => {
  const json = parseJson(oldText)
  if (!json.ok || !isObject(json.value))
    return ['The old config is not a JSON object, so init cannot list what the new config leaves out of it.']
  const next = configObject(servers, false)
  const top: Record<string, unknown> = next
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const left = Object.entries(json.value).flatMap(([key, value]): string[] => {
    if (key !== 'mcpServers' || !isObject(value))
      return same(value, Object.hasOwn(top, key) ? top[key] : undefined) ? [] : [JSON.stringify(key)]
    return Object.entries(value).flatMap(([name, entry]) => {
      const server = `the server ${JSON.stringify(name)}`
      if (!Object.hasOwn(next.mcpServers, name)) return [`${server}: not in the new config`]
      return same(entry, next.mcpServers[name]) ? [] : [`${server}: a different entry`]
    })
  })
  if (left.length === 0) return ['The new config keeps every part of the old one.']
  return [
    `The new config leaves out these parts of the old one. Copy the ones you need from ${bak}:`,
    ...left.map(l => `- ${l}`),
  ]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "Claude Code (local scope)", or the client name alone. */
const sourceLabel = (file: ClientFile) => `${CLIENT_NAME[file.client]}${file.scope ? ` (${file.scope} scope)` : ''}`

/** One word of a command that init prints, or why init prints no command with it. */
type Word = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly why: string }

/**
 * The words that the `shellWord` form of Windows does not pass as they are: a test of the word and of the form, single
 * quotes or not, and the reason. The command runs in PowerShell or Git Bash, and cmd.exe must run nothing else from
 * it. cmd.exe reads no single quotes, and a `"` turns its quoting on and off. It can expand a `%NAME%` that is set.
 * Git Bash reads `''` as two quotes and `\` as an escape. It rewrites a `/` as a Windows path at the start of the word
 * or of a part after `=`, after only signs (checked in Git for Windows 2.x).
 */
const WINDOWS_REFUSALS: readonly [(word: string, single: boolean) => boolean, string][] = [
  [w => w.includes('"'), 'holds ", which cmd.exe cannot quote'],
  [w => w.includes('\\'), 'holds \\, which Git Bash reads as an escape'],
  [
    (w, single) => single && w.includes("'"),
    "holds ' and also $ or `, which no quoting passes to both PowerShell and Git Bash",
  ],
  [
    (w, single) => single && /[&|<>^]/.test(w),
    'needs single quotes, which cmd.exe does not read, and holds & | < > or ^',
  ],
  [w => w.split('=').some(part => /^[^A-Za-z0-9]*\//.test(part)), 'holds a / that Git Bash rewrites as a Windows path'],
]

/**
 * `word` quoted by `shellWord`, or why no quoting passes it as it is. A name in a client file can come from a cloned
 * repo, so it is hostile, and a person or an agent runs the command. The command stays printable ASCII. On other
 * systems than Windows, single quotes pass any such word.
 */
export const commandWord = (word: string, platform: string): Word => {
  const text = shellWord(word, platform)
  if (/[^\x20-\x7e]/.test(word)) return { ok: false, why: 'holds a character outside printable ASCII' }
  const refusal = platform === 'win32' ? WINDOWS_REFUSALS.find(([test]) => test(word, text.startsWith("'"))) : undefined
  return refusal === undefined ? { ok: true, text } : { ok: false, why: refusal[1] }
}

/** The lines that remove the servers `names` from one client file. */
const removeLines = (file: ClientFile, names: readonly string[], platform: string): string[] => {
  if (file.client === 'claude-code') {
    const scope = `--scope ${file.scope ?? 'user'}`
    return names.map(name => {
      const word = commandWord(name, platform)
      if (!word.ok)
        return `  ${shownName(name)}: init prints no command, because the name ${word.why}. Remove it from ${file.path} by hand.`
      return `  claude mcp remove ${word.text} ${scope}`
    })
  }
  return names.length > 0 ? [`  Remove from "mcpServers": ${names.map(n => JSON.stringify(n)).join(', ')}`] : []
}

/** The steps that move one client to toolscript: remove what the config now holds, then add toolscript. */
const steps = (c: ClientResult, configFile: string, platform: string, launch: Launch): string[] => {
  const remove = c.outcomes.flatMap(o =>
    o.kind === 'imported' || o.kind === 'same' || o.kind === 'self' ? [o.name] : [],
  )
  if (c.file.client === 'claude-code') {
    // Claude Code on Windows starts npx only through cmd /c. It starts node directly.
    const cmd = platform === 'win32' && launch.kind === 'npx' ? 'cmd /c ' : ''
    const word = (w: string) => shellWord(w, platform)
    return [
      platform === 'win32' ? 'Claude Code, in PowerShell:' : 'Claude Code:',
      ...removeLines(c.file, remove, platform),
      `  claude mcp add --scope user toolscript ${word('--')} ${cmd}${launchText(launch, platform)} --config ${pathWord(configFile, platform)}`,
      '  Then start a new Claude Code session.',
    ]
  }
  const client = CLIENT_NAME[c.file.client]
  const [command, ...args] = launchArgv(launch)
  return [
    `${client}, in ${c.file.path}:`,
    ...removeLines(c.file, remove, platform),
    `  Add to "mcpServers": "toolscript": ${JSON.stringify({ command, args: [...args, '--config', configFile] })}`,
    `  Then restart ${client}.`,
  ]
}

/** The notes on the servers that a config gets: the untrusted ones, and the HTTP ones that can need a login. */
const serverNotes = (
  servers: ReadonlyMap<ServerKey, Entry>,
  configFile: string,
  platform: string,
  launch: Launch,
): string[] => {
  const out: string[] = []
  const untrusted = [...servers].flatMap(([key, e]) => (e.untrusted ? [key] : []))
  if (untrusted.length > 0)
    out.push(
      '',
      `The config sets "untrusted": true on the servers that name Azure DevOps: ${untrusted.join(', ')}. Each of their results reaches the model as untrusted text.`,
    )
  // The config gives each of them an OAuth login by default.
  const bare = [...servers].flatMap(([key, e]) => ('type' in e && e.headers === undefined ? [key] : []))
  if (bare.length > 0)
    out.push(
      '',
      `These HTTP servers have no headers: ${bare.join(', ')}. If one asks for an OAuth login, run ${launchText(launch, platform)} login <server> --config ${pathWord(configFile, platform)} for it.`,
    )
  return out
}

/** What init read, imported and left out, the starter policy, and the steps for each client. No secret. */
export const initReport = (imp: Import, configFile: string, platform: string, launch: Launch): string => {
  const name = (c: ClientResult) => CLIENT_NAME[c.file.client]
  const out = ['Client files. init reads them and does not change them:']
  for (const c of imp.clients)
    out.push(`- ${sourceLabel(c.file)}, ${c.file.path}: ${c.problem ?? plural(c.outcomes.length, 'server')}`)
  const imported: string[] = []
  const left: string[] = []
  for (const c of imp.clients)
    for (const o of c.outcomes) {
      const from = `${name(c)} ${JSON.stringify(o.name)}`
      if (o.kind === 'imported') {
        const renamed = o.name === o.key ? '' : ` ${JSON.stringify(o.name)}`
        const dropped = o.dropped.length > 0 ? `. Left out: ${o.dropped.join(', ')}` : ''
        imported.push(`- ${o.key}, from ${name(c)}${renamed}${dropped}`)
      } else if (o.kind === 'self') left.push(`- ${from}: this is toolscript-mcp itself`)
      else if (o.kind === 'skipped') left.push(`- ${from}: ${o.why}`)
      else if (o.kind === 'conflict')
        left.push(`- ${from}: differs from the ${o.key} entry of ${CLIENT_NAME[o.keptFrom]}, which the config keeps`)
    }
  if (left.length > 0) out.push('', 'Not imported:', ...left)
  if (imp.servers.size === 0) return [...out, '', 'No server to import. init wrote nothing.'].join('\n')
  out.push(
    '',
    `Imported ${plural(imp.servers.size, 'server')}:`,
    ...imported,
    ...serverNotes(imp.servers, configFile, platform, launch),
  )

  const [first] = imp.servers.keys()
  out.push(
    '',
    'The policy in the config is empty, so toolscript-mcp asks you before a program calls a tool.',
    'If your client cannot ask, toolscript-mcp refuses the run, and the result names the rule to add.',
    `Add rules to "policy" in ${configFile}, for example {"match": "mcp__${first}__*", "action": "allow"}.`,
    'toolscript-mcp reads the policy again at each run. It asks you to approve a new allow rule before it applies.',
    'If your client cannot ask, restart toolscript-mcp to apply a new allow rule.',
    '',
    'Next, in each client, remove the servers that toolscript-mcp now runs, and add toolscript:',
  )
  for (const c of imp.clients) if (c.problem === undefined) out.push('', ...steps(c, configFile, platform, launch))
  return out.join('\n')
}

/** A toolscript-mcp config that `--list` and `--add` read: a JSON object whose `mcpServers` is an object. */
export type OldConfig = {
  readonly json: Readonly<Record<string, unknown>>
  readonly servers: Readonly<Record<string, unknown>>
}

export const parseOldConfig = (text: string): { ok: true; config: OldConfig } | { ok: false; why: string } => {
  const json = parseJson(text)
  if (!json.ok) return { ok: false, why: `not valid JSON${json.where}` }
  if (!isObject(json.value)) return { ok: false, why: 'not a JSON object' }
  const servers = json.value.mcpServers ?? {}
  if (!isObject(servers)) return { ok: false, why: '"mcpServers" is not an object' }
  return { ok: true, config: { json: json.value, servers } }
}

/** The config of `--list` when there is no config file. */
export const NO_CONFIG: OldConfig = { json: {}, servers: {} }

/** JSON with the keys of each object in order, so that two entries compare by content. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => (isObject(v) ? Object.fromEntries(Object.entries(v).sort(byKey)) : v))

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0)

const configStatus = (parsed: Parsed, servers: OldConfig['servers']): string => {
  if (parsed.kind === 'self') return 'toolscript itself'
  if (parsed.kind === 'skipped') return `skipped: ${parsed.why}`
  if (!Object.hasOwn(servers, parsed.key)) return 'not in config'
  return canonical(servers[parsed.key]) === canonical(parsed.entry) ? 'in config' : 'name taken by a different entry'
}

/** The approval of a project server that Claude Code does not run for it, or undefined. */
const gateOf = ({ approval }: Candidate): Exclude<Approval, 'approved'> | undefined =>
  approval === 'approved' ? undefined : approval

/**
 * True for a project server that Claude Code skips for lack of approval, and runs the server of the same name in
 * another scope instead. A closer project server hides one that is not approved only when it is not approved either.
 */
const runsAnother = (c: Candidate): boolean =>
  gateOf(c) !== undefined && c.hiddenBy !== undefined && c.hiddenBy !== 'project'

const statusOf = (c: Candidate, servers: OldConfig['servers']): string => {
  const gate = gateOf(c)
  const hidden = runsAnother(c) ? `Claude Code runs the ${c.hiddenBy} one` : c.hiddenBy && `hidden by ${c.hiddenBy}`
  return [
    configStatus(c.parsed, servers),
    ...(gate ? [`${gate} in Claude Code`] : []),
    ...(hidden ? [hidden] : []),
  ].join(', ')
}

/** `stdio <executable>` or `http <origin>`: no argument, path, query or login. */
const kindOf = ({ parsed }: Candidate): string => {
  if (parsed.kind !== 'entry') return '-'
  const { entry } = parsed
  if ('type' in entry) return `http ${urlOrigin(entry.url) ?? '-'}`
  // A command with a space can hold arguments, and so a secret.
  if (/\s/.test(entry.command)) return 'stdio'
  return `stdio ${hideArgSecrets([entry.command.split(/[\\/]/).at(-1) ?? '']).args.join('')}`
}

const table = (rows: readonly (readonly string[])[]): string[] => {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map(r => r[i]?.length ?? 0))) ?? []
  return rows.map(r => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  '))
}

/**
 * One line for each server of the client files, with its status in the config, then the command that adds each one
 * that `--add` can take. Names only, no value. Each text from a file is printable, so a name or path never moves the
 * cursor or turns the text around.
 */
export const listReport = (files: readonly FileServers[], config: OldConfig, at: AddAt): string => {
  const rows = files.flatMap(f =>
    f.candidates.map(c => [
      shownName(c.name),
      c.file.client,
      c.file.scope ?? '-',
      printable(kindOf(c)),
      printable(statusOf(c, config.servers)),
      printable(c.file.project ?? '-'),
    ]),
  )
  const problems = files.flatMap(f =>
    f.problem === undefined || f.problem === NO_FILE
      ? []
      : [printable(`Cannot read ${sourceName(f.file)}, ${f.file.path}: ${f.problem}`)],
  )
  const list =
    rows.length > 0
      ? table([['name', 'client', 'scope', 'kind', 'status', 'folder'], ...rows])
      : ['No MCP server in the client files.']
  return [...list, ...problems, ...addCommands(files, config, at)].join('\n')
}

/**
 * A server that `--add` copies into the config, the client files that hold the same entry, and the Claude Code
 * servers of the same name that the one in `from` hides.
 */
export type Added = {
  readonly key: ServerKey
  readonly entry: Entry
  readonly from: readonly Candidate[]
  readonly hides: readonly Candidate[]
}

/**
 * The servers `names` of the client files, or every reason to add none. `from` keeps only the files of one client,
 * as `cursor`, or of one scope, as `claude-code:local`. Of a name in several Claude Code scopes, `--add` takes the
 * one that Claude Code runs: the one that `scopedServers` does not hide. Different entries in two clients need
 * `from`. A project server that is not approved needs `unapproved`. `--add` picks such a server only when no other
 * scope has the name, or when `from` leaves out the others.
 */
export const planAdd = (
  files: readonly FileServers[],
  names: readonly string[],
  config: OldConfig,
  { from, unapproved }: { readonly from: string | undefined; readonly unapproved: boolean },
): { ok: true; added: Added[] } | { ok: false; errors: string[] } => {
  const pool = files
    .flatMap(f => f.candidates)
    .filter(c => from === undefined || [c.file.client, sourceName(c.file)].includes(from))
  const errors: string[] = []
  const added: Added[] = []
  for (const name of names) {
    const quoted = shownName(name)
    const found = pool.filter(c => c.name === name)
    // Of each client, the server that it runs, or the first one when --from leaves that one out.
    const picked = found.filter(c => {
      const own = found.filter(o => o.file.client === c.file.client)
      return c === (own.find(o => o.hiddenBy === undefined) ?? own[0])
    })
    const usable = picked.flatMap(c => (c.parsed.kind === 'entry' ? [{ c, parsed: c.parsed }] : []))
    const first = usable[0]
    const gated = usable.find(u => gateOf(u.c))?.c
    if (found.length === 0) errors.push(`${quoted} is in no client file${from ? ` of ${printable(from)}` : ''}.`)
    else if (first === undefined)
      errors.push(
        `${quoted} cannot be added: ${picked.map(c => `${sourceName(c.file)}: ${printable(statusOf(c, {}))}`).join(', ')}.`,
      )
    else if (usable.some(u => canonical(u.parsed.entry) !== canonical(first.parsed.entry)))
      errors.push(
        `${quoted} has different entries in ${usable.map(u => sourceName(u.c.file)).join(', ')}. Pick one with --from.`,
      )
    else if (gated !== undefined && !unapproved)
      errors.push(
        `${quoted} of ${printable(gated.file.path)} is ${gated.approval} in Claude Code for this folder. To add it anyway, add --unapproved.`,
      )
    else if (Object.hasOwn(config.servers, first.parsed.key))
      errors.push(`${quoted} is in the config already, as ${first.parsed.key}.`)
    else if (added.some(a => a.key === first.parsed.key))
      errors.push(`${quoted} makes the server key ${first.parsed.key}, which another name in --add makes too.`)
    else {
      const runs = usable.some(u => u.c.file.client === 'claude-code')
      const hides = runs ? found.filter(c => !picked.includes(c)) : []
      added.push({ key: first.parsed.key, entry: first.parsed.entry, from: usable.map(u => u.c), hides })
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, added }
}

/** The names in the values of `--add`: each value split at its commas, each name without the spaces at its ends. */
export const addNames = (values: readonly string[]): string[] => values.flatMap(v => v.split(',')).map(n => n.trim())

/** What a printed `--add` command holds: the folder of `--list`, the config file, the system and the launch form. */
export type AddAt = {
  readonly start: string
  readonly configFile: string
  readonly platform: string
  readonly launch: Launch
}

/**
 * The options with which `--add` takes the server `c` and no other copy of its name, found with `planAdd` itself, or
 * undefined when no options do. `gate`: the approval that `--unapproved` passes over.
 */
const addOptions = (
  files: readonly FileServers[],
  c: Candidate,
  config: OldConfig,
): { from?: string; gate?: Exclude<Approval, 'approved'> } | undefined => {
  for (const from of [undefined, sourceName(c.file)])
    for (const unapproved of [false, true]) {
      const plan = planAdd(files, [c.name], config, { from, unapproved })
      const taken = plan.ok ? plan.added[0]?.from : undefined
      if (taken?.includes(c))
        return { from, ...(unapproved && { gate: taken.map(gateOf).find(g => g !== undefined) ?? 'not approved' }) }
    }
  return undefined
}

/**
 * For each server with the status `not in config`, the command that adds it, or why init prints none. The command
 * names the config, the folder when a local or project scope has the name, `--from` when `--add` would take another
 * copy of the name, and `--unapproved` when Claude Code does not run the server. Such a line says to ask first.
 */
const addCommands = (files: readonly FileServers[], config: OldConfig, at: AddAt): string[] => {
  const { start, configFile, platform, launch } = at
  const bare = (text: string): Word => ({ ok: true, text })
  const quoted = (label: string, word: string): Word => {
    const quoting = commandWord(word, platform)
    return quoting.ok ? quoting : { ok: false, why: `${label} ${quoting.why}` }
  }
  const file = (label: string, p: string) => quoted(label, platform === 'win32' ? p.replaceAll('\\', '/') : p)
  const launchWords =
    launch.kind === 'npx'
      ? launchArgv(launch).map(bare)
      : [bare('node'), file('the path of toolscript-mcp', launch.main)]
  const all = files.flatMap(f => f.candidates)
  const lines = all.flatMap(c => {
    if (configStatus(c.parsed, config.servers) !== 'not in config') return []
    const head = `- ${shownName(c.name)} (${sourceName(c.file)}`
    const none = (why: string) => [`${head}): no command, because ${why}.`]
    const [parsed, ...more] = addNames([c.name])
    if (parsed !== c.name || more.length > 0)
      return none('--add splits a name at a comma and drops the spaces at its ends')
    const options = addOptions(files, c, config)
    if (options === undefined) return none('--add takes another copy of this name')
    const scoped = all.some(o => o.name === c.name && (o.file.scope === 'local' || o.file.scope === 'project'))
    const words = [
      ...launchWords,
      bare('init'),
      /^[\w.-]+$/.test(c.name) ? bare(`--add=${c.name}`) : quoted('the name', `--add=${c.name}`),
      ...(options.from ? [bare('--from'), quoted('the source', options.from)] : []),
      ...(options.gate ? [bare('--unapproved')] : []),
      ...(scoped ? [bare('--project'), file('the folder', start)] : []),
      bare('--config'),
      file('the config path', configFile),
    ]
    const refused = words.find((w): w is Extract<Word, { ok: false }> => !w.ok)
    if (refused !== undefined) return none(refused.why)
    const gate = options.gate ? `, ask first: ${options.gate} in Claude Code` : ''
    return [`${head}${gate}): ${words.map(w => (w.ok ? w.text : '')).join(' ')}`]
  })
  return lines.length > 0 ? ['', 'Commands that add a server:', ...lines] : []
}

/** The config with the added servers: the old config with its other keys and policy, or a new one. */
export const addedConfigText = (old: OldConfig | undefined, added: readonly Added[]): string => {
  const servers = new Map(added.map(a => [a.key, a.entry]))
  if (old === undefined) return configText(servers, false)
  return `${JSON.stringify({ ...old.json, mcpServers: { ...old.servers, ...Object.fromEntries(servers) } }, null, 2)}\n`
}

/**
 * What `--add` added, with no value, and the steps that remove the direct entries from the clients. Each line is
 * printable: the names, paths and keys come from the client files.
 */
export const addReport = (added: readonly Added[], configFile: string, platform: string, launch: Launch): string[] => {
  const out = [`Added ${plural(added.length, 'server')}:`]
  const remove = new Map<string, { file: ClientFile; names: string[] }>()
  for (const { key, from, hides } of added) {
    const sources = from.map(c => `${sourceLabel(c.file)}${c.name === key ? '' : ` ${shownName(c.name)}`}`)
    const dropped = [...new Set(from.flatMap(c => (c.parsed.kind === 'entry' ? c.parsed.dropped : [])))]
    out.push(`- ${key}, from ${sources.join(', ')}${dropped.length > 0 ? `. Left out: ${dropped.join(', ')}` : ''}`)
    const runs = from.find(c => c.file.client === 'claude-code')?.file.scope
    for (const h of hides) {
      const why = runsAnother(h) ? `which is ${h.approval} in Claude Code` : `which the ${runs} one hides`
      out.push(
        `  ${sourceLabel(h.file)}${h.file.scope === 'project' ? ` in ${h.file.path}` : ''} also has ${shownName(h.name)}, ${why}.`,
      )
    }
    for (const c of from) {
      // The local and user scopes share a file, and the project scope has a file in each folder.
      const where = `${sourceName(c.file)} ${c.file.path}`
      const at = remove.get(where) ?? { file: c.file, names: [] }
      at.names.push(c.name)
      remove.set(where, at)
    }
  }
  out.push(...serverNotes(new Map(added.map(a => [a.key, a.entry])), configFile, platform, launch))
  out.push('', 'The clients keep their direct entries. After a run through toolscript-mcp works, remove them:')
  for (const { file, names } of remove.values()) {
    if (file.client !== 'claude-code') {
      const client = CLIENT_NAME[file.client]
      out.push('', `${client}, in ${file.path}:`, ...removeLines(file, names, platform), `  Then restart ${client}.`)
      continue
    }
    const shell = platform === 'win32' ? ', in PowerShell' : ''
    const folder = file.scope === 'user' ? '' : `, in the folder ${file.project}`
    out.push('', `Claude Code${shell}${folder}:`, ...removeLines(file, names, platform))
    if (file.scope === 'project')
      out.push(
        `  ${file.path} is shared with everyone who uses the project. Decide with them before you remove the entry.`,
      )
    out.push('  Then start a new Claude Code session.')
  }
  return out.map(printable)
}
