// The config file of toolscript-mcp: the `mcpServers` shape of Claude Desktop
// and Claude Code, the sandbox's Node and time limit, and the policy rules.
// Parsed here, at the boundary, so the host trusts a Config. Also where the
// file is and the self-loop guard.

import { ACTIONS, type Action, type Policy, type Rule } from './policy.ts'

// The WHATWG URL of every JavaScript runtime. The core loads no DOM or Node types, so it declares what it uses.
declare const URL: { canParse(url: string): boolean; new (url: string): { readonly href: string } }

/** A server key that makes `mcp__<key>__<tool>` split back into the key and the tool. */
export type ServerKey = string & { readonly __brand: 'ServerKey' }

export type StdioServer = {
  readonly kind: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  /** Only these and the SDK's short default list reach the child. */
  readonly env: Readonly<Record<string, string>>
}

/** How an HTTP server logs in with OAuth: `toolscript-mcp login <key>` gets the tokens. */
export type OAuth = {
  /** A client that the person registered by hand, as Google needs. Without it, login registers one. */
  readonly client?: { readonly id: string; readonly secret?: string }
  /** The scopes to ask for when the server names none. */
  readonly scopes: readonly string[]
  /** The port of the login callback on 127.0.0.1. Without it, login takes a free port and keeps it. */
  readonly callbackPort?: number
}

export type HttpServer = {
  readonly kind: 'http'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** Absent when the server takes no OAuth login: it has headers, or `"oauth": false`. */
  readonly oauth?: OAuth
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

const OAUTH_KEYS = ['clientId', 'clientSecret', 'scopes', 'callbackPort']

/**
 * The OAuth login of an HTTP server. A server without headers logs in by default. A server with headers logs in
 * only with `"oauth"`, and never with an Authorization header, which the SDK would send in place of the token.
 */
const parseOAuth = (
  raw: unknown,
  headers: Readonly<Record<string, string>>,
  path: string,
  env: Env,
  errors: string[],
): OAuth | undefined => {
  if (raw === false) return undefined
  if (raw === undefined) return Object.keys(headers).length === 0 ? { scopes: [] } : undefined
  if (raw !== true && !isObject(raw)) {
    errors.push(`${path}: must be true, false or an object`)
    return undefined
  }
  if (Object.keys(headers).some(name => name.toLowerCase() === 'authorization'))
    errors.push(`${path}: an entry with an Authorization header does not log in: remove one of them`)
  if (raw === true) return { scopes: [] }
  unknownKeys(raw, OAUTH_KEYS, path, errors)
  const { clientId, clientSecret, scopes, callbackPort } = raw
  const id =
    clientId === undefined
      ? undefined
      : expand(nonEmpty(clientId, `${path}.clientId`, errors), env, `${path}.clientId`, errors)
  let secret: string | undefined
  if (clientSecret !== undefined) {
    if (typeof clientSecret !== 'string') errors.push(`${path}.clientSecret: must be a string`)
    else if (id === undefined) errors.push(`${path}.clientSecret: needs clientId`)
    else secret = expand(clientSecret, env, `${path}.clientSecret`, errors)
  }
  const okScopes = Array.isArray(scopes) && scopes.every(s => typeof s === 'string' && /^\S+$/.test(s))
  if (scopes !== undefined && !okScopes) errors.push(`${path}.scopes: must be an array of scope names without spaces`)
  const okPort = Number.isInteger(callbackPort) && (callbackPort as number) >= 1 && (callbackPort as number) <= 65535
  if (callbackPort !== undefined && !okPort) errors.push(`${path}.callbackPort: must be a whole number from 1 to 65535`)
  return {
    ...(id !== undefined && { client: { id, ...(secret !== undefined && { secret }) } }),
    scopes: okScopes ? (scopes as string[]) : [],
    ...(okPort && { callbackPort: callbackPort as number }),
  }
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
    unknownKeys(raw, ['type', 'url', 'headers', 'oauth'], path, errors)
    const found = errors.length
    const url = expand(nonEmpty(raw.url, `${path}.url`, errors), env, `${path}.url`, errors)
    // An empty or unexpanded url has its error already. The text names only the
    // key: the URL can come from a variable and hold a token.
    if (errors.length === found) {
      if (!/^https?:\/\//i.test(url)) errors.push(`${path}.url: must start with http:// or https://`)
      else if (!URL.canParse(url)) errors.push(`${path}.url: must be a valid URL`)
    }
    const headers = stringMap(raw.headers, `${path}.headers`, env, errors)
    const oauth = parseOAuth(raw.oauth, headers, `${path}.oauth`, env, errors)
    return { kind: 'http', url, headers, ...(oauth && { oauth }) }
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
export const SECRET_NAMES = [
  'key',
  'token',
  'secret',
  'pass',
  'pwd',
  'auth',
  'bearer',
  'header',
  'credential',
  'cookie',
  'session',
  'dsn',
] as const
/** These hold a secret only as a whole part of a name, as in `GITHUB_PAT` or `--sig`, so `--path` and `--signal` do not. */
export const SECRET_PARTS = ['pat', 'sig', 'sas', 'pw'] as const
/**
 * A word of at least this many characters, with letters and digits, is a secret: of letters, digits, `_` and `-`,
 * or, with upper and lower case, also of `. / + = : ~ %` (a JWT, a base64 key, a bot token), unless it starts as a path.
 */
export const SECRET_WORD_LENGTH = 20

const SECRET_NAME = new RegExp(`${SECRET_NAMES.join('|')}|(?<![a-z])(?:${SECRET_PARTS.join('|')})(?![a-z])`, 'i')
const PLAIN_WORD = new RegExp(`^(?=.*\\d)(?=.*[A-Za-z])[\\w-]{${SECRET_WORD_LENGTH},}$`)
const MIXED_WORD = new RegExp(`^(?=.*\\d)(?=.*[a-z])(?=.*[A-Z])[\\w./+=:~%-]{${SECRET_WORD_LENGTH},}$`)
const PATH_START = /^(?:[./~]|[A-Za-z]:[\\/])/
const isSecretWord = (word: string): boolean =>
  PLAIN_WORD.test(word) || (MIXED_WORD.test(word) && !PATH_START.test(word))

// An empty `--name=` takes the next arg as its value.
const FLAG = /^--?[A-Za-z][\w.-]*=?$/
// `-t` and `-p` often take a token or a password, and also a port (`8080:80`), a time, a path or a package.
const SHORT_FLAG = /^-[tp]$/
const SHORT_KEEP = /^(?:[\d.:]+|[@./~]\S*|[A-Za-z]:[\\/]\S*)$/
// curl takes `user:password` after these, and docker takes `user:group`.
const USER_FLAG = /^(?:-u|--user|--proxy-user)$/
// The user can be empty (`:<token>`), an email or `DOMAIN\name`.
const USER_PASS = /^([^\s:/]*):(?!\/)(\S+)$/
// `Name:` as a word of its own, before the value: `-H "X-Api-Key: <value>"` in a script.
const NAME_COLON = /^[A-Za-z][\w.-]*:$/
// The scheme ends the word before the value, alone or after a name: `X-Custom:Bearer <value>`.
const BEARER = /(?:^|[:=])(?:bearer|basic)$/i
// `name=value` or `Name: value`, and not the `://` of a URL.
const ASSIGN = /^(-{0,2}[A-Za-z][\w.-]*)(=|:(?!\/\/)\s*)([\s\S]*)$/
const HEADER = /^([\w-]+:\s+)([\s\S]+)$/
// A URL, with white space only in its user and password, which run to the last `@`.
const WHOLE_URL = /^[A-Za-z][\w+.-]*:\/\/(?:[\s\S]*@)?\S*$/
const URL_TEXT = /[A-Za-z][\w+.-]*:\/\/\S+/g

type Hide = (secret: string) => string

/** `hide`, which keeps each secret it hides, and the non-empty secrets so far. */
const collector = (): { hide: Hide; secrets: () => string[] } => {
  const found: string[] = []
  return {
    hide: secret => {
      found.push(secret)
      return '***'
    },
    secrets: () => found.filter(s => s !== ''),
  }
}

/**
 * A URL with its user and password, each query value or bare part, each `;name=value` path value, its fragment and
 * each secret word of its path hidden.
 */
const maskUrl = (url: string, hide: Hide): string =>
  url
    .replace(/#([\s\S]+)$/, (_, fragment: string) => `#${hide(fragment)}`)
    // All text up to the last `@` is user and password, because a password can hold `@` or `/`. An error can
    // show the user or the password alone, so each is a secret of its own too.
    .replace(/^([^:]*:\/\/)([\s\S]*)@/, (_, scheme: string, user: string) => {
      const colon = user.indexOf(':')
      if (colon >= 0) {
        hide(user.slice(0, colon))
        hide(user.slice(colon + 1))
      }
      return `${scheme}${hide(user)}@`
    })
    .replace(/([?&][^=&#]*=)([^&#]+)/g, (_, name: string, value: string) => `${name}${hide(value)}`)
    .replace(/([?&])([^=&#]+)(?=[&#]|$)/g, (_, mark: string, part: string) => `${mark}${hide(part)}`)
    .replace(/(;[^=;/?#]*=)([^;/?#]+)/g, (_, name: string, value: string) => `${name}${hide(value)}`)
    .replace(/\/([\w.~%+=-]+)(?=[/?#]|$)/g, (whole, part: string) => (isSecretWord(part) ? `/${hide(part)}` : whole))

/** maskUrl, and the secrets of the URL as the URL parser writes it (`%20` for a space), the form that an error shows. */
const hideUrl = (url: string, hide: Hide): string => {
  if (URL.canParse(url)) maskUrl(new URL(url).href, hide)
  return maskUrl(url, hide)
}

/** The url of an HTTP server with each secret in it as `***`, and the secrets. The whole value is the URL. */
export const hideUrlSecrets = (url: string): { url: string; secrets: string[] } => {
  const { hide, secrets } = collector()
  return { url: hideUrl(url, hide), secrets: secrets() }
}

/**
 * `user:password` with the password hidden, or undefined for a value with no password. A number on either side, or
 * the same name twice, is a docker user and group (`1000:1000`, `1000:docker`, `node:node`). A path stays too.
 */
const hidePassword = (value: string, hide: Hide): string | undefined => {
  const [, user = '', password = ''] = USER_PASS.exec(value) ?? []
  const group = password === user || /^\d+$/.test(user) || /^\d+$/.test(password)
  if (password === '' || group || SHORT_KEEP.test(value)) return undefined
  return `${user}:${hide(password)}`
}

/** The hidden form of `value` after the word or arg `prev`, or undefined when `prev` says nothing about it. */
const afterPrev = (value: string, prev: string | undefined, hide: Hide): string | undefined => {
  // A value can start with `-`. Only a `--` word after a secret flag is taken for the next flag.
  if (prev === undefined || value === '' || value.startsWith('--')) return undefined
  if (prev === '-H') {
    const header = HEADER.exec(value)
    if (header === null) return undefined
    const [, name = '', rest = ''] = header
    return SECRET_NAME.test(name) ? `${name}${hide(rest)}` : `${name}${hideText(rest, hide)}`
  }
  if (FLAG.test(prev) && SECRET_NAME.test(prev)) {
    const header = HEADER.exec(value)
    return header ? `${header[1]}${hide(header[2] ?? '')}` : hide(value)
  }
  if (USER_FLAG.test(prev)) return hidePassword(value, hide)
  // `-t` takes no value in docker, so a `-x` after it is the next flag.
  if (SHORT_FLAG.test(prev) && !value.startsWith('-')) return SHORT_KEEP.test(value) ? value : hide(value)
  if ((NAME_COLON.test(prev) && SECRET_NAME.test(prev)) || BEARER.test(prev)) return hide(value)
  return undefined
}

/** True for `Server=db;Password=x` or `host=db,password=x`: each part holds `=`. */
const isConnection = (text: string): boolean => {
  const parts = text.split(/[;,]/).filter(p => p.trim() !== '')
  return parts.length > 1 && parts.every(p => p.includes('='))
}

/** Each word of `text` hidden as an arg, after the word before it. Quotes and `;` or `,` at the ends of a word stay. */
const hideWords = (text: string, hide: Hide): string => {
  let prev: string | undefined
  return text
    .split(/(\s+)/)
    .map((part, i) => {
      if (i % 2 === 1 || part === '') return part
      const [, lead = '', core = '', tail = ''] = /^(['"(]*)([\s\S]*?)(['");,]*)$/.exec(part) ?? []
      const shown = afterPrev(core, prev, hide) ?? hideText(core, hide)
      prev = core
      return `${lead}${shown}${tail}`
    })
    .join('')
}

// Inside a secret object these name the secret, as in `{"auth": {"user": "bob", "value": "<secret>"}}`, so they stay.
const JSON_LABEL = /^(?:name|user|username|type|id)$/i

/**
 * A JSON value with each value under a key with a secret name hidden, also inside an object or array there, except
 * a label, and the secrets in each other string.
 */
const hideJson = (value: unknown, secret: boolean, hide: Hide): unknown => {
  if (Array.isArray(value)) return value.map(v => hideJson(v, secret, hide))
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        hideJson(v, (secret && !JSON_LABEL.test(k)) || SECRET_NAME.test(k), hide),
      ]),
    )
  if (typeof value === 'string') return secret ? hide(value) : hideText(value, hide)
  return secret && typeof value === 'number' ? hide(String(value)) : value
}

/** `hide` that also keeps each secret as JSON escapes it, the form in which a server echoes a JSON arg. */
const hideEscapedToo =
  (hide: Hide): Hide =>
  secret => {
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped !== secret) hide(escaped)
    return hide(secret)
  }

/** One arg, or one word or part of one, with its secrets hidden. */
const hideText = (text: string, hide: Hide): string => {
  const json = /^[[{]/.test(text) ? parseJson(text) : undefined
  if (json?.ok && typeof json.value === 'object' && json.value !== null) {
    try {
      return JSON.stringify(hideJson(json.value, false, hideEscapedToo(hide)))
    } catch {
      // Nested deeper than the stack allows: the whole arg is the secret, so a failed server never stops the others.
      return hide(text)
    }
  }
  const assign = ASSIGN.exec(text)
  const [, name = '', sep = '', value = ''] = assign ?? []
  if (assign && SECRET_NAME.test(name)) return value === '' ? text : `${name}${sep}${hide(value)}`
  const password = assign && sep === '=' && USER_FLAG.test(name) ? hidePassword(value, hide) : undefined
  if (password !== undefined) return `${name}${sep}${password}`
  if (WHOLE_URL.test(text)) return hideUrl(text, hide)
  if (assign && WHOLE_URL.test(value)) return `${name}${sep}${hideUrl(value, hide)}`
  if (isConnection(text))
    return text
      .split(/([;,])/)
      .map((part, i) => (i % 2 === 1 ? part : hideText(part, hide)))
      .join('')
  if (/\s/.test(text)) return hideWords(text, hide)
  if (text.includes('://')) return text.replace(URL_TEXT, url => hideUrl(url, hide))
  if (assign && isSecretWord(value)) return `${name}${sep}${hide(value)}`
  return isSecretWord(text) ? hide(text) : text
}

/**
 * The args of a server with each secret in them as `***`, and the secrets. A secret is the value after a flag with a
 * secret name (the name of a header stays), also after an empty `--name=`, the value after `-t` or `-p` unless it is a
 * number, a path or a scoped package, the password of `user:password` after `-u`, `--user` or `--proxy-user`, a secret
 * header value after `-H`, the value of `name=value` or `Name: value` with a secret name, also as a part of
 * `Server=db;Password=x`, each value under a key with a secret name in a JSON object or array (a JSON arg too deep for
 * the stack is hidden whole), the word after Bearer or Basic, the user, password,
 * query values and bare parts, `;name=value` path values, fragment and secret path words of a URL, and a secret word.
 * An arg of several words, such as a `sh -c` script, gets the same rules word by word. Other text stays as it is. A
 * JSON arg shows on one line.
 */
export const hideArgSecrets = (args: readonly string[]): { args: string[]; secrets: string[] } => {
  const { hide, secrets } = collector()
  const hidden = args.map((arg, i) => afterPrev(arg, args[i - 1], hide) ?? hideText(arg, hide))
  return { args: hidden, secrets: secrets() }
}

// Only letters or only digits, shorter than LONG: a common word or number such as `error`, `localhost` or `3000`.
const PLAIN = /^(?:[A-Za-z]+|\d+)$/
const LONG = 12

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * `text` with the secrets of the server replaced by `***`: a failed child's stderr can echo a token, and the reason
 * goes to the model. The secrets are the ones that hideArgSecrets finds in the args or the URL, the `env` and `headers`
 * values with a secret name or a secret word or of 12 characters or more, the OAuth client secret, the secrets inside
 * every such value, each
 * word of 8 or more in one ("Bearer <token>"), and the URL-decoded form of each. A number shorter than 12 digits is
 * never replaced, and a plain word only as a whole word, so `localhost:3000` stays readable. The user and password
 * of any URL in `text` are hidden too.
 */
export const redact = (text: string, server: ServerConfig): string => {
  const values = [
    ...(server.kind === 'stdio' ? hideArgSecrets(server.args) : hideUrlSecrets(server.url)).secrets,
    ...Object.entries(server.kind === 'stdio' ? server.env : server.headers).flatMap(([key, value]) => [
      ...(SECRET_NAME.test(key) || isSecretWord(value) || value.length >= LONG ? [value] : []),
      ...hideArgSecrets([value]).secrets,
    ]),
    ...(server.kind === 'http' && server.oauth?.client?.secret !== undefined ? [server.oauth.client.secret] : []),
  ]
  const secrets = [
    ...new Set(
      [...values, ...values.flatMap(v => v.split(/\s+/).filter(w => w.length >= 8))].flatMap(v => [v, decoded(v)]),
    ),
  ].filter(v => v.length >= 4 && !(/^\d+$/.test(v) && v.length < LONG))
  const hidden = secrets
    .sort((a, b) => b.length - a.length)
    .reduce(
      (t, v) =>
        PLAIN.test(v) && v.length < LONG
          ? t.replace(new RegExp(`(?<![A-Za-z])${v}(?![A-Za-z])`, 'g'), '***')
          : t.replaceAll(v, '***'),
      text,
    )
  return hidden.replace(/:\/\/[^\s/?#]*@/g, '://***@')
}
