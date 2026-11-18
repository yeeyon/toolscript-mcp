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
 * picks a server that two scopes define: local, project, user.
 */
export const scopedFiles = (env: Env, platform: string, home: string, project: string): ClientFile[] => [
  { client: 'claude-code', scope: 'local', path: claudeJson(env, home), project },
  { client: 'claude-code', scope: 'project', path: `${project}/.mcp.json`, project },
  ...clientFiles(env, platform, home),
]

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

/** The `mcpServers` of one client file, or why there are none. Local scope: the entry of its folder in `projects`. */
const serversOf = (read: ClientRead, platform: string): { problem: string } | { servers: [string, unknown][] } => {
  if (read.kind === 'missing') return { problem: NO_FILE }
  if (read.kind === 'unreadable') return { problem: `cannot read it: ${read.error}` }
  const json = parseJson(read.text)
  if (!json.ok) return { problem: `not valid JSON${json.where}` }
  if (!isObject(json.value)) return { problem: 'not a JSON object' }
  let holder = json.value
  if (read.scope === 'local') {
    const { projects } = json.value
    const project = read.project ?? ''
    const key = isObject(projects) ? Object.keys(projects).find(k => sameFolder(k, project, platform)) : undefined
    if (key === undefined || !isObject(projects)) return { servers: [] }
    const entry = projects[key]
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

const parseServer = (name: string, raw: unknown): Parsed => {
  if (isSelf(name, raw)) return { kind: 'self' }
  const parsed = toEntry(raw)
  if ('why' in parsed) return { kind: 'skipped', why: parsed.why }
  const key = keyOf(name)
  if (key === undefined) return { kind: 'skipped', why: 'no letter or digit to make a server key of' }
  const entry: Entry = namesAzureDevOps(key, parsed.entry) ? { ...parsed.entry, untrusted: true } : parsed.entry
  return { kind: 'entry', key, entry, dropped: parsed.dropped }
}

/** A server that init found in a client file: where, its name there, and its entry. */
export type Candidate = { readonly file: ClientFile; readonly name: string; readonly parsed: Parsed }

/** The servers of one client file, or why init read none. */
export type FileServers = {
  readonly file: ClientFile
  readonly problem?: string
  readonly candidates: readonly Candidate[]
}

export const fileServers = (read: ClientRead, platform: string): FileServers => {
  const { client, path, scope, project } = read
  const file: ClientFile = { client, path, ...(scope && { scope }), ...(project !== undefined && { project }) }
  const found = serversOf(read, platform)
  if ('problem' in found) return { file, problem: found.problem, candidates: [] }
  return { file, candidates: found.servers.map(([name, raw]) => ({ file, name, parsed: parseServer(name, raw) })) }
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

/** The lines that remove the servers `names` from one client file. */
const removeLines = (file: ClientFile, names: readonly string[], platform: string): string[] => {
  if (file.client === 'claude-code')
    return names.map(name => `  claude mcp remove ${shellWord(name, platform)} --scope ${file.scope ?? 'user'}`)
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

const statusOf = ({ parsed }: Candidate, servers: OldConfig['servers']): string => {
  if (parsed.kind === 'self') return 'toolscript itself'
  if (parsed.kind === 'skipped') return `skipped: ${parsed.why}`
  if (!Object.hasOwn(servers, parsed.key)) return 'not in config'
  return canonical(servers[parsed.key]) === canonical(parsed.entry) ? 'in config' : 'name taken by a different entry'
}

/** `stdio <executable>` or `http <origin>`: no argument, path, query or login. */
const kindOf = ({ parsed }: Candidate): string => {
  if (parsed.kind !== 'entry') return '-'
  const { entry } = parsed
  if ('type' in entry) return `http ${urlOrigin(entry.url) ?? '-'}`
  return `stdio ${hideArgSecrets([entry.command.split(/[\\/]/).at(-1) ?? '']).args.join('')}`
}

const table = (rows: readonly (readonly string[])[]): string[] => {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map(r => r[i]?.length ?? 0))) ?? []
  return rows.map(r => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  '))
}

/** One line for each server of the client files, with its status in the config. Names only, no value. */
export const listReport = (files: readonly FileServers[], config: OldConfig): string => {
  const rows = files.flatMap(f =>
    f.candidates.map(c => [
      JSON.stringify(c.name),
      c.file.client,
      c.file.scope ?? '-',
      kindOf(c),
      statusOf(c, config.servers),
    ]),
  )
  const problems = files.flatMap(f =>
    f.problem === undefined || f.problem === NO_FILE
      ? []
      : [`Cannot read ${sourceName(f.file)}, ${f.file.path}: ${f.problem}`],
  )
  const list =
    rows.length > 0
      ? table([['name', 'client', 'scope', 'kind', 'status'], ...rows])
      : ['No MCP server in the client files.']
  return [...list, ...problems].join('\n')
}

/** A server that `--add` copies into the config, and the client files that hold the same entry. */
export type Added = { readonly key: ServerKey; readonly entry: Entry; readonly from: readonly Candidate[] }

/**
 * The servers `names` of the client files, or every reason to add none. `from` keeps only the files of one client,
 * as `cursor`, or of one scope, as `claude-code:local`.
 */
export const planAdd = (
  files: readonly FileServers[],
  names: readonly string[],
  from: string | undefined,
  config: OldConfig,
): { ok: true; added: Added[] } | { ok: false; errors: string[] } => {
  const pool = files
    .flatMap(f => f.candidates)
    .filter(c => from === undefined || [c.file.client, sourceName(c.file)].includes(from))
  const errors: string[] = []
  const added: Added[] = []
  for (const name of names) {
    const quoted = JSON.stringify(name)
    const found = pool.filter(c => c.name === name)
    const usable = found.flatMap(c => (c.parsed.kind === 'entry' ? [{ c, parsed: c.parsed }] : []))
    const first = usable[0]
    if (found.length === 0) errors.push(`${quoted} is in no client file${from ? ` of ${from}` : ''}.`)
    else if (first === undefined)
      errors.push(
        `${quoted} cannot be added: ${found.map(c => `${sourceName(c.file)}: ${statusOf(c, {})}`).join(', ')}.`,
      )
    else if (usable.some(u => canonical(u.parsed.entry) !== canonical(first.parsed.entry)))
      errors.push(
        `${quoted} has different entries in ${usable.map(u => sourceName(u.c.file)).join(', ')}. Pick one with --from.`,
      )
    else if (Object.hasOwn(config.servers, first.parsed.key))
      errors.push(`${quoted} is in the config already, as ${first.parsed.key}.`)
    else if (added.some(a => a.key === first.parsed.key))
      errors.push(`${quoted} makes the server key ${first.parsed.key}, which another name in --add makes too.`)
    else added.push({ key: first.parsed.key, entry: first.parsed.entry, from: usable.map(u => u.c) })
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, added }
}

/** The config with the added servers: the old config with its other keys and policy, or a new one. */
export const addedConfigText = (old: OldConfig | undefined, added: readonly Added[]): string => {
  const servers = new Map(added.map(a => [a.key, a.entry]))
  if (old === undefined) return configText(servers, false)
  return `${JSON.stringify({ ...old.json, mcpServers: { ...old.servers, ...Object.fromEntries(servers) } }, null, 2)}\n`
}

/** What `--add` added, with no value, and the steps that remove the direct entries from the clients. */
export const addReport = (added: readonly Added[], configFile: string, platform: string, launch: Launch): string[] => {
  const out = [`Added ${plural(added.length, 'server')}:`]
  const remove = new Map<string, { file: ClientFile; names: string[] }>()
  for (const { key, from } of added) {
    const sources = from.map(c => `${sourceLabel(c.file)}${c.name === key ? '' : ` ${JSON.stringify(c.name)}`}`)
    const dropped = [...new Set(from.flatMap(c => (c.parsed.kind === 'entry' ? c.parsed.dropped : [])))]
    out.push(`- ${key}, from ${sources.join(', ')}${dropped.length > 0 ? `. Left out: ${dropped.join(', ')}` : ''}`)
    for (const c of from) {
      const at = remove.get(sourceName(c.file)) ?? { file: c.file, names: [] }
      at.names.push(c.name)
      remove.set(sourceName(c.file), at)
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
  return out
}
