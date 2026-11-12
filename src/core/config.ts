// The config file of toolscript-mcp: the `mcpServers` shape of Claude Desktop
// and Claude Code, and the sandbox's Node. Parsed here, at the boundary, so
// the host trusts a Config. Also where the file is and the self-loop guard.

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

export type Config = {
  readonly servers: ReadonlyMap<ServerKey, ServerConfig>
  /** The Node binary that starts the sandbox. */
  readonly sandbox: { readonly node: string }
}

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

/**
 * The config in `text`. `execPath` is the default Node of the sandbox. Every
 * error names the key it is about, as `mcpServers.github.env.TOKEN`.
 */
export const parseConfig = (text: string, env: Env, execPath: string): Parsed => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    // V8 quotes the text near the error, which can hold a token: keep only where it is.
    const where = /line \d+ column \d+|position \d+/.exec(err instanceof Error ? err.message : '')
    return { ok: false, errors: [`the config is not valid JSON${where ? ` (${where[0]})` : ''}`] }
  }
  if (!isObject(raw)) return { ok: false, errors: ['the config must be a JSON object with an mcpServers object'] }
  const errors: string[] = []
  unknownKeys(raw, ['$schema', 'mcpServers', 'sandbox'], 'config', errors)

  const servers = new Map<ServerKey, ServerConfig>()
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
      const server = parseServer(entry, path, env, errors)
      if (server) servers.set(key, server)
    }

  let node = execPath
  if (raw.sandbox !== undefined) {
    if (!isObject(raw.sandbox)) errors.push('sandbox: must be an object')
    else {
      unknownKeys(raw.sandbox, ['node'], 'sandbox', errors)
      if (raw.sandbox.node !== undefined) node = nonEmpty(raw.sandbox.node, 'sandbox.node', errors)
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: { servers, sandbox: { node } } }
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

/**
 * `text` with each `env` and `headers` value of the server (4 characters or
 * more), and each word of 8 or more in one ("Bearer <token>"), replaced by
 * `***`: a failed child's stderr can echo a token, and the reason goes to the model.
 */
export const redact = (text: string, server: ServerConfig): string => {
  const values = Object.values(server.kind === 'stdio' ? server.env : server.headers)
  const secrets = [
    ...values.filter(v => v.length >= 4),
    ...values.flatMap(v => v.split(/\s+/).filter(w => w.length >= 8)),
  ]
  return secrets.sort((a, b) => b.length - a.length).reduce((t, v) => t.replaceAll(v, '***'), text)
}
