// toolscript-mcp init: the MCP servers in the config files of Claude Code,
// Claude Desktop and Cursor, merged into one toolscript-mcp config, and the
// steps that move each client to toolscript. The host reads the client files
// and writes the config. Nothing here prints a value of env or headers, or a
// secret that hideArgSecrets finds in args and URLs.

import { hideArgSecrets, parseJson, serverKey, type Env, type ServerKey } from './config.ts'

export type ClientId = 'claude-code' | 'claude-desktop' | 'cursor'

const CLIENT_NAME: Readonly<Record<ClientId, string>> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
}

export type ClientFile = { readonly client: ClientId; readonly path: string }

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
    { client: 'claude-code', path: `${env.CLAUDE_CONFIG_DIR || home}/.claude.json` },
    { client: 'claude-desktop', path: `${desktop}/claude_desktop_config.json` },
    { client: 'cursor', path: `${home}/.cursor/mcp.json` },
  ]
}

export type ClientRead = ClientFile &
  (
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'missing' }
    | { readonly kind: 'unreadable'; readonly error: string }
  )

type StringMap = Readonly<Record<string, string>>

/** A server as the toolscript-mcp config writes it. `${VAR}` stays as the client file has it. */
export type Entry =
  | { readonly command: string; readonly args?: readonly string[]; readonly env?: StringMap }
  | { readonly type: 'http'; readonly url: string; readonly headers?: StringMap }

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

const STDIO_KEYS = ['type', 'command', 'args', 'env', 'disabled']
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
    const { command, args, env } = raw
    if (typeof command !== 'string' || command.trim() === '') return { why: 'no command' }
    if (args !== undefined && !isStrings(args)) return { why: '"args" is not a list of strings' }
    if (env !== undefined && !isStringMap(env)) return { why: '"env" is not an object of strings' }
    const map = nonEmpty(env)
    const entry = { command, ...(args?.length ? { args: [...args] } : {}), ...(map ? { env: map } : {}) }
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

/** The servers of one client file, by name, or why there are none. */
const serversOf = (read: ClientRead): { problem: string } | { servers: [string, unknown][] } => {
  if (read.kind === 'missing') return { problem: 'no file' }
  if (read.kind === 'unreadable') return { problem: `cannot read it: ${read.error}` }
  const json = parseJson(read.text)
  if (!json.ok) return { problem: `not valid JSON${json.where}` }
  if (!isObject(json.value)) return { problem: 'not a JSON object' }
  const list = json.value.mcpServers
  if (list === undefined) return { servers: [] }
  return isObject(list) ? { servers: Object.entries(list) } : { problem: '"mcpServers" is not an object' }
}

/** The servers of every client file, merged by key: the first client wins, and a different entry with the same key is a conflict. */
export const importServers = (reads: readonly ClientRead[]): Import => {
  const kept = new Map<ServerKey, { entry: Entry; from: ClientId; json: string }>()
  const clients = reads.map((read): ClientResult => {
    const file = { client: read.client, path: read.path }
    const found = serversOf(read)
    if ('problem' in found) return { file, problem: found.problem, outcomes: [] }
    const outcomes = found.servers.map(([name, raw]): Outcome => {
      if (isSelf(name, raw)) return { kind: 'self', name }
      const parsed = toEntry(raw)
      if ('why' in parsed) return { kind: 'skipped', name, why: parsed.why }
      const key = keyOf(name)
      if (key === undefined) return { kind: 'skipped', name, why: 'no letter or digit to make a server key of' }
      const json = JSON.stringify(parsed.entry)
      const earlier = kept.get(key)
      if (earlier === undefined) {
        kept.set(key, { entry: parsed.entry, from: read.client, json })
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
      url: hideArgSecrets([entry.url]).args[0] ?? '',
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

/**
 * One word of a printed command, as it is when the shell keeps it, else as a literal in single quotes, so no `$`,
 * backtick or `$(...)` expands: PowerShell on Windows, a POSIX shell elsewhere. A bare PowerShell word starts with a
 * letter or a path character, so it is not a number. Before a script, such as the npm shim of claude, PowerShell
 * drops a bare `--` and splits `-a:b`. It also reads the curly quotes U+2018 to U+201B as single quotes.
 */
export const shellWord = (word: string, platform: string): string =>
  platform === 'win32'
    ? /^(?:--?[A-Za-z][\w-]*|[A-Za-z./\\][\w./:\\~-]*)$/.test(word)
      ? word
      : `'${word.replace(/['‘-‛]/g, '$&$&')}'`
    : /^[\w./:@+-][\w./:@+~-]*$/.test(word)
      ? word
      : `'${word.replace(/'/g, `'\\''`)}'`

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The steps that move one client to toolscript: remove what the config now holds, then add toolscript. */
const steps = (c: ClientResult, configFile: string, platform: string): string[] => {
  const remove = c.outcomes.flatMap(o =>
    o.kind === 'imported' || o.kind === 'same' || o.kind === 'self' ? [o.name] : [],
  )
  const run = ['-y', 'toolscript-mcp', '--config', configFile]
  if (c.file.client === 'claude-code') {
    // Claude Code on Windows starts npx only through cmd /c.
    const npx = platform === 'win32' ? ['cmd', '/c', 'npx'] : ['npx']
    const word = (w: string) => shellWord(w, platform)
    return [
      platform === 'win32' ? 'Claude Code, in PowerShell:' : 'Claude Code:',
      ...remove.map(name => `  claude mcp remove ${word(name)} --scope user`),
      `  claude mcp add --scope user toolscript ${['--', ...npx, ...run].map(word).join(' ')}`,
      '  Then start a new Claude Code session.',
    ]
  }
  const client = CLIENT_NAME[c.file.client]
  return [
    `${client}, in ${c.file.path}:`,
    ...(remove.length > 0 ? [`  Remove from "mcpServers": ${remove.map(n => JSON.stringify(n)).join(', ')}`] : []),
    `  Add to "mcpServers": "toolscript": ${JSON.stringify({ command: 'npx', args: run })}`,
    `  Then restart ${client}.`,
  ]
}

/** What init read, imported and left out, the starter policy, and the steps for each client. No secret. */
export const initReport = (imp: Import, configFile: string, platform: string): string => {
  const name = (c: ClientResult) => CLIENT_NAME[c.file.client]
  const out = ['Client files. init reads them and does not change them:']
  for (const c of imp.clients) {
    const scope = c.file.client === 'claude-code' ? ' (user scope)' : ''
    out.push(`- ${name(c)}${scope}, ${c.file.path}: ${c.problem ?? plural(c.outcomes.length, 'server')}`)
  }
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
  out.push('', `Imported ${plural(imp.servers.size, 'server')}:`, ...imported)

  const [first] = imp.servers.keys()
  out.push(
    '',
    'The policy in the config is empty, so toolscript-mcp asks you before a program calls a tool.',
    'If your client cannot ask, toolscript-mcp refuses the run, and the result names the rule to add.',
    `Add rules to "policy" in ${configFile}, for example {"match": "mcp__${first}__*", "action": "allow"}.`,
    'toolscript-mcp reads the policy again at each run, so a new rule needs no restart.',
    '',
    'Next, in each client, remove the servers that toolscript-mcp now runs, and add toolscript:',
  )
  for (const c of imp.clients) if (c.problem === undefined) out.push('', ...steps(c, configFile, platform))
  return out.join('\n')
}
