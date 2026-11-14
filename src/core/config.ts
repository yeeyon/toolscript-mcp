// The config file of toolscript-mcp: the `mcpServers` shape of Claude Desktop
// and Claude Code, the sandbox's Node and time limit, and the policy rules.
// Parsed here, at the boundary, so the host trusts a Config. Also where the
// file is and the self-loop guard.

import { ACTIONS, type Action, type Policy, type Rule } from './policy.ts'

/** A server key that makes `mcp__<key>__<tool>` split back into the key and the tool. */
export type ServerKey = string & { readonly __brand: 'ServerKey' }

export type StdioServer = {
  readonly kind: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  /** Only these and the SDK's short default list reach the child. */
  readonly env: Readonly<Record<string, string>>
}

export type HttpServer = {
  readonly kind: 'http'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export type ServerConfig = StdioServer | HttpServer

/** A server entry with errors. It fails alone: the other servers still start, and search_tools shows the errors. */
export type InvalidServer = { readonly kind: 'invalid'; readonly errors: readonly string[] }

export type ServerEntry = ServerConfig | InvalidServer

/** Why an invalid entry is not connected, as search_tools shows it. */
export const invalidReason = (errors: readonly string[]): string =>
  `invalid entry in the toolscript-mcp config: ${errors.join('; ')}`

export type Sandbox = {
  /** The Node binary that starts the sandbox. */
  readonly node: string
  /** The wall-clock limit of one run, and on Linux and macOS its CPU limit. */
  readonly timeoutSeconds: number
  /** The longest wait for the answer to one nested call. Never more than timeoutSeconds. */
  readonly callTimeoutSeconds: number
}

export type Config = {
  readonly servers: ReadonlyMap<ServerKey, ServerEntry>
  readonly sandbox: Sandbox
  readonly policy: Policy
  /** False when the config says `"log": false`: no run log. */
  readonly log: boolean
}

/** The time limit of a run without `sandbox.timeoutSeconds`, and the least it can be, as in the plugin. */
export const DEFAULT_TIMEOUT_SECONDS = 120
export const MIN_TIMEOUT_SECONDS = 5
// One day. A longer limit overflows the host kill timer (setTimeout), which then fires at once.
export const MAX_TIMEOUT_SECONDS = 86_400
/** The call limit without `sandbox.callTimeoutSeconds`, cut to the run limit when that is shorter. */
export const DEFAULT_CALL_TIMEOUT_SECONDS = 60

export type Env = Readonly<Record<string, string | undefined>>

export type Parsed = { readonly ok: true; readonly config: Config } | { readonly ok: false; readonly errors: string[] }

/** Set on every stdio child, so a copy of toolscript-mcp that a child starts refuses to run. */
export const DEPTH_VAR = 'TOOLSCRIPT_MCP_DEPTH'

const APP = 'toolscript-mcp'

// Letters, digits and hyphens, with single underscores between them: no `__`
// and no `_` at an end, so splitToolName finds the key again. No dot or space,
// so a key is a JavaScript-friendly part of a tool name.
const KEY = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/

/** The key, when it fits in `mcp__<key>__<tool>`. */
export const serverKey = (key: string): ServerKey | undefined => (KEY.test(key) ? (key as ServerKey) : undefined)

/** The refusal of a nested start, or undefined when this process is not a child of toolscript-mcp. */
export const nestedStart = (env: Env): string | undefined =>
  env[DEPTH_VAR]
    ? `toolscript-mcp: refused to start, because ${DEPTH_VAR} is set: a server in the config of another toolscript-mcp started this copy. Remove toolscript-mcp from its own mcpServers.`
    : undefined

/**
 * The config file: `--config`, else TOOLSCRIPT_CONFIG, else the per-user
 * default (`%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere).
 */
export const configPath = (flag: string | undefined, env: Env, platform: string, home: string): string => {
  if (flag) return flag
  if (env.TOOLSCRIPT_CONFIG) return env.TOOLSCRIPT_CONFIG
  const base =
    platform === 'win32' ? env.APPDATA || `${home}/AppData/Roaming` : env.XDG_CONFIG_HOME || `${home}/.config`
  return `${base}/${APP}/config.json`
}

// `${NAME}`, or any other `${...}`, which is an error: no default
// (`${VAR:-x}`) and no escape, so nothing passes through unexpanded.
const VAR = /\$\{([^}]*)\}/g
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `${NAME}` replaced from `env`. A variable that is not set is an error that names it, never a value. */
const expand = (text: string, env: Env, where: string, errors: string[]): string =>
  text.replace(VAR, (whole, name: string) => {
    if (!NAME.test(name)) {
      errors.push(`${where}: ${whole} is not a variable: write \${NAME} with letters, digits and underscores`)
      return whole
    }
    const value = Object.hasOwn(env, name) ? env[name] : undefined
    if (value !== undefined) return value
    errors.push(`${where}: the environment variable ${name} is not set`)
    return whole
  })

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const at = (path: string, key: string): string => (KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`)

const unknownKeys = (o: Record<string, unknown>, known: readonly string[], path: string, errors: string[]) => {
  for (const key of Object.keys(o))
    if (!known.includes(key)) errors.push(`${at(path, key)}: unknown key (known: ${known.join(', ')})`)
}

const stringMap = (v: unknown, path: string, env: Env, errors: string[]): Record<string, string> => {
  if (v === undefined) return {}
  if (!isObject(v)) {
    errors.push(`${path}: must be an object of strings`)
    return {}
  }
  // fromEntries keeps a key such as __proto__ as a plain key.
  return Object.fromEntries(
    Object.entries(v).flatMap(([key, value]) => {
      if (typeof value === 'string') return [[key, expand(value, env, at(path, key), errors)]]
      errors.push(`${at(path, key)}: must be a string`)
      return []
    }),
  )
}

const nonEmpty = (v: unknown, path: string, errors: string[]): string => {
  if (typeof v === 'string' && v.trim() !== '') return v
  errors.push(`${path}: must be a non-empty string`)
  return ''
}

const parseServer = (raw: unknown, path: string, env: Env, errors: string[]): ServerConfig | undefined => {
  if (!isObject(raw)) {
    errors.push(`${path}: must be an object`)
    return undefined
  }
  const type = raw.type ?? 'stdio'
  if (type === 'stdio') {
    unknownKeys(raw, ['type', 'command', 'args', 'env'], path, errors)
    const command = nonEmpty(raw.command, `${path}.command`, errors)
    let args: string[] = []
    if (raw.args !== undefined) {
      if (Array.isArray(raw.args))
        args = raw.args.map((a, i) => {
          if (typeof a === 'string') return expand(a, env, `${path}.args[${i}]`, errors)
          errors.push(`${path}.args[${i}]: must be a string`)
          return ''
        })
      else errors.push(`${path}.args: must be an array of strings`)
    }
    return { kind: 'stdio', command, args, env: stringMap(raw.env, `${path}.env`, env, errors) }
  }
  if (type === 'http') {
    unknownKeys(raw, ['type', 'url', 'headers'], path, errors)
    const url = expand(nonEmpty(raw.url, `${path}.url`, errors), env, `${path}.url`, errors)
    if (url !== '' && !/^https?:\/\//i.test(url)) errors.push(`${path}.url: must start with http:// or https://`)
    return { kind: 'http', url, headers: stringMap(raw.headers, `${path}.headers`, env, errors) }
  }
  errors.push(`${path}.type: must be "stdio" or "http", not ${JSON.stringify(type)}`)
  return undefined
}

const parseSandbox = (raw: unknown, execPath: string, platform: string, errors: string[]): Sandbox => {
  const sandbox = {
    node: execPath,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    callTimeoutSeconds: DEFAULT_CALL_TIMEOUT_SECONDS,
  }
  if (raw === undefined) return sandbox
  if (!isObject(raw)) {
    errors.push('sandbox: must be an object')
    return sandbox
  }
  unknownKeys(raw, ['node', 'timeoutSeconds', 'callTimeoutSeconds'], 'sandbox', errors)
  if (raw.node !== undefined) {
    sandbox.node = nonEmpty(raw.node, 'sandbox.node', errors)
    // The sandbox process gets an empty PATH on Windows, so a bare name finds nothing.
    if (platform === 'win32' && sandbox.node !== '' && !/[\\/]/.test(sandbox.node))
      errors.push(
        `sandbox.node: on Windows, give the full path of node.exe, such as "C:\\\\Program Files\\\\nodejs\\\\node.exe", not "${sandbox.node}": the sandbox has no PATH`,
      )
  }
  const t = raw.timeoutSeconds
  if (t !== undefined) {
    if (typeof t === 'number' && Number.isInteger(t) && t >= MIN_TIMEOUT_SECONDS && t <= MAX_TIMEOUT_SECONDS)
      sandbox.timeoutSeconds = t
    else
      errors.push(
        `sandbox.timeoutSeconds: must be a whole number of seconds from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}, not ${JSON.stringify(t)}`,
      )
  }
  const c = raw.callTimeoutSeconds
  if (c === undefined) sandbox.callTimeoutSeconds = Math.min(DEFAULT_CALL_TIMEOUT_SECONDS, sandbox.timeoutSeconds)
  else if (!(typeof c === 'number' && Number.isInteger(c) && c >= 1 && c <= MAX_TIMEOUT_SECONDS))
    errors.push(
      `sandbox.callTimeoutSeconds: must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}, not ${JSON.stringify(c)}`,
    )
  else if (c > sandbox.timeoutSeconds)
    errors.push(`sandbox.callTimeoutSeconds: must not be more than sandbox.timeoutSeconds (${sandbox.timeoutSeconds})`)
  else sandbox.callTimeoutSeconds = c
  return sandbox
}

const MATCH = 'a glob over mcp__<server>__<tool>, such as "mcp__github__*"'

const parsePolicy = (raw: unknown, errors: string[]): Rule[] => {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    errors.push(`policy: must be an array of rules, such as [{ "match": "mcp__github__*", "action": "allow" }]`)
    return []
  }
  return raw.flatMap((entry, index): Rule[] => {
    const path = `policy[${index}]`
    if (!isObject(entry)) {
      errors.push(`${path}: must be an object with "match" and "action"`)
      return []
    }
    unknownKeys(entry, ['match', 'action'], path, errors)
    const { match, action } = entry
    const okMatch = typeof match === 'string' && /^(mcp__|\*)/.test(match)
    if (!okMatch) errors.push(`${path}.match: must be ${MATCH}, not ${JSON.stringify(match)}`)
    const okAction = typeof action === 'string' && (ACTIONS as readonly string[]).includes(action)
    if (!okAction) errors.push(`${path}.action: must be "allow", "deny" or "ask", not ${JSON.stringify(action)}`)
    return okMatch && okAction ? [{ match: match as string, action: action as Action, index }] : []
  })
}

/** The JSON in `text`, or where it breaks. V8 quotes the text near the error, which can hold a token: only the place is kept. */
export const parseJson = (text: string): { ok: true; value: unknown } | { ok: false; where: string } => {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    const where = /line \d+ column \d+|position \d+/.exec(err instanceof Error ? err.message : '')
    return { ok: false, where: where ? ` (${where[0]})` : '' }
  }
}

/**
 * The config in `text`. `execPath` is the default Node of the sandbox and
 * `platform` the host's process.platform. Every error names the key it is
 * about, as `mcpServers.github.env.TOKEN` or `policy[2].action`. An error in
 * one server entry makes only that entry invalid.
 */
export const parseConfig = (text: string, env: Env, execPath: string, platform: string): Parsed => {
  const json = parseJson(text)
  if (!json.ok) return { ok: false, errors: [`the config is not valid JSON${json.where}`] }
  const raw = json.value
  if (!isObject(raw)) return { ok: false, errors: ['the config must be a JSON object with an mcpServers object'] }
  const errors: string[] = []
  unknownKeys(raw, ['$schema', 'mcpServers', 'sandbox', 'policy', 'log'], 'config', errors)

  const servers = new Map<ServerKey, ServerEntry>()
  if (!isObject(raw.mcpServers)) errors.push('mcpServers: must be an object')
  else
    for (const [name, entry] of Object.entries(raw.mcpServers)) {
      const path = at('mcpServers', name)
      const key = serverKey(name)
      if (key === undefined) {
        errors.push(
          `${path}: a server key must be letters, digits and hyphens, with single underscores between them, so tool names read mcp__<key>__<tool>`,
        )
        continue
      }
      const entryErrors: string[] = []
      const server = parseServer(entry, path, env, entryErrors)
      servers.set(key, server && entryErrors.length === 0 ? server : { kind: 'invalid', errors: entryErrors })
    }

  const sandbox = parseSandbox(raw.sandbox, execPath, platform, errors)
  const policy = parsePolicy(raw.policy, errors)
  if (raw.log !== undefined && typeof raw.log !== 'boolean')
    errors.push(`log: must be true or false, not ${JSON.stringify(raw.log)}`)
  const log = raw.log !== false

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: { servers, sandbox, policy, log } }
}

/**
 * Only the `policy` of the config in `text`, which is read again at each run.
 * A change to a server or the sandbox takes effect at the next start.
 */
export const policyOf = (text: string): { ok: true; policy: Policy } | { ok: false; errors: string[] } => {
  const json = parseJson(text)
  if (!json.ok) return { ok: false, errors: [`the config is not valid JSON${json.where}`] }
  if (!isObject(json.value)) return { ok: false, errors: ['the config must be a JSON object'] }
  const errors: string[] = []
  const policy = parsePolicy(json.value.policy, errors)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, policy }
}

/**
 * The environment of a stdio child: the config's `env` and the depth marker,
 * which the config cannot unset. Windows names variables in any letter case,
 * so a key that differs from the marker only in case goes too.
 */
export const childEnv = (server: StdioServer): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(server.env).filter(([k]) => k.toUpperCase() !== DEPTH_VAR)),
  [DEPTH_VAR]: '1',
})

/** A name with one of these in it, in any case, holds a secret: `--api-key <value>`, `--token=<value>`, `TOKEN=<value>`. */
export const SECRET_NAMES = ['key', 'token', 'secret', 'pass', 'auth', 'bearer', 'header', 'credential'] as const
/** A word of at least this many letters, digits, `_` and `-`, with both letters and digits, is a secret. */
export const SECRET_WORD_LENGTH = 20

const SECRET_NAME = new RegExp(SECRET_NAMES.join('|'), 'i')
const SECRET_WORD = new RegExp(`^(?=.*\\d)(?=.*[A-Za-z])[\\w-]{${SECRET_WORD_LENGTH},}$`)
const FLAG = /^--?[A-Za-z][\w.-]*$/
// `name=value` or `Name: value`, and not the `://` of a URL.
const ASSIGN = /^(-{0,2}[A-Za-z][\w.-]*)(=|:(?!\/\/)\s*)([\s\S]*)$/
const HEADER = /^([\w-]+:\s+)([\s\S]+)$/
const URL_TEXT = /[A-Za-z][\w+.-]*:\/\/\S+/g

/** A URL with its user and password, each query value, its fragment and each secret word of its path hidden. */
const hideUrl = (url: string, hide: (secret: string) => string): string =>
  url
    .replace(/#([\s\S]+)$/, (_, fragment: string) => `#${hide(fragment)}`)
    // All text up to the last `@` is user and password, because a password can hold `@` or `/`.
    .replace(/^([^:]*:\/\/)([\s\S]*)@/, (_, scheme: string, user: string) => `${scheme}${hide(user)}@`)
    .replace(/([?&][^=&#]*=)([^&#]+)/g, (_, name: string, value: string) => `${name}${hide(value)}`)
    .replace(/\/([\w-]+)(?=[/?#]|$)/g, (whole, part: string) => (SECRET_WORD.test(part) ? `/${hide(part)}` : whole))

/**
 * The args of a server with each secret in them as `***`, and the secrets. A secret is the value after a flag
 * with a secret name (the name of a header stays), the value of `name=value` or `Name: value` with a secret name,
 * the word after Bearer or Basic, the user, password, query values, fragment and secret path words of a URL, and an
 * arg that is one secret word. Other args stay as they are.
 */
export const hideArgSecrets = (args: readonly string[]): { args: string[]; secrets: string[] } => {
  const secrets: string[] = []
  const hide = (secret: string) => {
    secrets.push(secret)
    return '***'
  }
  const hidden = args.map((arg, i) => {
    const flag = args[i - 1]
    if (flag !== undefined && FLAG.test(flag) && SECRET_NAME.test(flag) && !arg.startsWith('-')) {
      const header = HEADER.exec(arg)
      return header ? `${header[1]}${hide(header[2] ?? '')}` : hide(arg)
    }
    const assign = ASSIGN.exec(arg)
    if (assign && SECRET_NAME.test(assign[1] ?? '')) return `${assign[1]}${assign[2]}${hide(assign[3] ?? '')}`
    const text = arg
      .replace(
        /\b(Bearer|Basic)(\s+)(\S+)/gi,
        (_, word: string, space: string, token: string) => word + space + hide(token),
      )
      .replace(URL_TEXT, url => hideUrl(url, hide))
    return SECRET_WORD.test(text) ? hide(text) : text
  })
  return { args: hidden, secrets: secrets.filter(s => s !== '') }
}

/**
 * `text` with each `env` and `headers` value of the server, and each secret that hideArgSecrets finds in its args or
 * URL (4 characters or more), and each word of 8 or more in one ("Bearer <token>"), replaced by `***`: a failed
 * child's stderr can echo a token, and the reason goes to the model.
 */
export const redact = (text: string, server: ServerConfig): string => {
  const values = [
    ...Object.values(server.kind === 'stdio' ? server.env : server.headers),
    ...hideArgSecrets(server.kind === 'stdio' ? server.args : [server.url]).secrets,
  ]
  const secrets = [
    ...values.filter(v => v.length >= 4),
    ...values.flatMap(v => v.split(/\s+/).filter(w => w.length >= 8)),
  ]
  return secrets.sort((a, b) => b.length - a.length).reduce((t, v) => t.replaceAll(v, '***'), text)
}
