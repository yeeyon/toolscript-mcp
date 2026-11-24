// The config file of toolscript-mcp: the `mcpServers` shape of Claude Desktop
// and Claude Code, the sandbox's Node and time limit, and the policy rules.
// Parsed here, at the boundary, so the host trusts a Config. Also where the
// file is and the self-loop guard.

import { ACTIONS, type Action, type Bridges, type Guards, type Policy, type Rule } from './policy.ts'
import { classify } from './share.ts'
import { TASK_LIMITS, TASK_NAME, commandProblem, cwdParts, type TaskConfig } from './task.ts'
import { DEFAULT_SKIP, globProblem, LIMITS, WORKSPACE_KEY, type WorkspaceConfig } from './workspace.ts'

// The WHATWG URL and btoa of every JavaScript runtime. The core loads no DOM or Node types, so it declares what it uses.
declare const URL: {
  canParse(url: string): boolean
  new (url: string): { readonly href: string; readonly origin: string }
}
declare const btoa: (data: string) => string

/** A server key that makes `mcp__<key>__<tool>` split back into the key and the tool. */
export type ServerKey = string & { readonly __brand: 'ServerKey' }

/**
 * `"untrusted": true` in a server entry: each result, error and attachment of the server is untrusted from its first
 * call. Without it, the results of a server are untrusted only after its first result in an untrusted wrapper.
 */
type Trust = { readonly untrusted?: true }

export type StdioServer = Trust & {
  readonly kind: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  /** Only these and the SDK's short default list reach the child. */
  readonly env: Readonly<Record<string, string>>
  /** The absolute folder that the child starts in. Without it, the child starts in the folder of toolscript-mcp. */
  readonly cwd?: string
  /** `"share"` as written. Without a key, the class comes from the rules in `share.ts`. */
  readonly share?: boolean | 'folder'
  /**
   * `"lazy"` as written (decision 028). The child of a lazy server starts on first use and stops when idle. Without a
   * key, only a Claude Code bridge is lazy.
   */
  readonly lazy?: boolean
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

/** AWS SigV4 signing of each request with the credentials of an AWS CLI profile, in place of an OAuth login. */
export type SigV4 = {
  readonly profile: string
  readonly region: string
  readonly service: string
}

export type HttpServer = Trust & {
  readonly kind: 'http'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** Absent when the server takes no OAuth login: it has headers, `"oauth": false` or `"sigv4"`. */
  readonly oauth?: OAuth
  readonly sigv4?: SigV4
}

export type ServerConfig = StdioServer | HttpServer

/**
 * The built-in Workspace (issue #144): an in-process server that reads one approved folder. It comes from the
 * `workspace` section, never from `mcpServers`. Each result is a file name or file content, so it is untrusted.
 */
export type WorkspaceServer = { readonly kind: 'workspace'; readonly untrusted: true }

/** A server entry with errors. It fails alone: the other servers still start, and search_tools shows the errors. */
export type InvalidServer = { readonly kind: 'invalid'; readonly errors: readonly string[] }

export type ServerEntry = ServerConfig | WorkspaceServer | InvalidServer

/** Why an invalid entry is not connected, as search_tools shows it. */
export const invalidReason = (errors: readonly string[]): string =>
  `invalid entry in the toolscript-mcp config: ${errors.join('; ')}`

/**
 * One word of a printed command, as it is when the shell keeps it, else quoted as a literal. On Windows the word
 * works in cmd.exe, PowerShell and Git Bash: bare, else in double quotes. A word with `$`, a backtick, `"` (PowerShell
 * also reads U+201C to U+201E as double quotes), which expand or end the string in one of them, or with a final
 * backslash, which escapes the closing quote, goes in single quotes instead. PowerShell reads those, and bash when the
 * word has no single quote, and there nothing expands. No form keeps the `%NAME%` of a set variable in cmd.exe, so
 * `%` stays in double quotes, which keep it in the other shells. On other systems a POSIX shell reads the word, in
 * single quotes. A bare PowerShell word starts with a letter or a path character, so it is not a number. Before a
 * script, such as the npm shim of claude, PowerShell drops a bare `--` and splits `-a:b`. It also reads the curly
 * quotes U+2018 to U+201B as single quotes, so a word with one is never bare, and the single-quote form doubles it.
 */
export const shellWord = (word: string, platform: string): string =>
  platform === 'win32'
    ? /^(?:--?[A-Za-z][\w-]*|[A-Za-z./\\][\w./:\\~-]*)$/.test(word)
      ? word
      : /[$`"“-„]|\\$/.test(word)
        ? `'${word.replace(/['‘-‛]/g, '$&$&')}'`
        : `"${word}"`
    : /^[\w./:@+-][\w./:@+~-]*$/.test(word)
      ? word
      : `'${word.replace(/'/g, `'\\''`)}'`

/**
 * A file path as one word of a printed command. On Windows it gets forward slashes: Git Bash drops a backslash that
 * is not in quotes, and Node reads both. A UNC path stays one, as `//host/share`.
 */
export const pathWord = (file: string, platform: string): string =>
  shellWord(platform === 'win32' ? file.replaceAll('\\', '/') : file, platform)

/** How this process started, so a printed command starts it the same way: npx from npm, node and main.js from a clone. */
export type Launch = { readonly kind: 'npx' } | { readonly kind: 'node'; readonly main: string }

/** The npm form. The host detects the form of the running process: this core holds no path. */
export const NPX_LAUNCH: Launch = { kind: 'npx' }

/** The command and arguments that start toolscript-mcp, as a client config holds them. */
export const launchArgv = (launch: Launch): readonly string[] =>
  launch.kind === 'npx' ? ['npx', '-y', 'toolscript-mcp'] : ['node', launch.main]

/** The start of a command line that runs toolscript-mcp, quoted for the shell of `platform`. */
export const launchText = (launch: Launch, platform: string): string =>
  launch.kind === 'npx' ? launchArgv(launch).join(' ') : `node ${pathWord(launch.main, platform)}`

/**
 * A command of the CLI for one server. `config` is the config file, when it is not the default one. A key can start
 * with `-`, so it then comes last, after `--`: the CLI would read it as an option.
 */
const serverCommand = (command: string, launch: Launch, platform: string, key: ServerKey, config?: string): string => {
  const option = config === undefined ? [] : ['--config', pathWord(config, platform)]
  const words = key.startsWith('-')
    ? [...option, shellWord('--', platform), shellWord(key, platform)]
    : [shellWord(key, platform), ...option]
  return [launchText(launch, platform), command, ...words].join(' ')
}

/** The command that logs in to a server. */
export const loginCommand = (launch: Launch, platform: string, key: ServerKey, config?: string): string =>
  serverCommand('login', launch, platform, key, config)

/** The command that connects to one server and lists its tools. */
export const toolsCommand = (launch: Launch, platform: string, key: ServerKey, config?: string): string =>
  serverCommand('tools', launch, platform, key, config)

/** Why a server that needs an OAuth login, or whose refresh was refused, is not connected, as search_tools shows it. */
export const loginReason = (command: string): string =>
  `it needs an OAuth login. Ask the person to run \`${command}\` in a terminal, then try again`

/**
 * Why a server is not connected when its token refresh got no answer, or an error that is not a refusal. Like any
 * failed server, it connects again on next use.
 */
export const refreshReason = (cause: string): string =>
  `could not refresh the OAuth token: ${cause}. No login is needed`

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
  /** The servers that are Claude Code itself (isBridge). Only an allow rule that names one allows its tools. */
  readonly bridges: Bridges
  /** What the policy needs besides its rules: the bridges, and whether the built-in Workspace is on. */
  readonly guards: Guards
  /** The valid `workspace` section. The server reads it one time, at the start: no policy reload reads it. */
  readonly workspace?: WorkspaceConfig
  readonly sandbox: Sandbox
  readonly policy: Policy
  /** False when the config says `"log": false`: no run log. */
  readonly log: boolean
  /**
   * The share switch: `TOOLSCRIPT_SHARE`, else the top-level `"share"`, else off (decision 026). When it is off, every
   * server starts one time per session, also one with `"share": true`. With it on, a shared or per-folder stdio
   * server has one child in the broker (`src/host/broker.ts`).
   */
  readonly share: { readonly on: boolean; readonly source: 'default' | 'config' | 'env' }
  /** The lazy switch: false only with `TOOLSCRIPT_LAZY=0`, which turns every lazy start off (decision 028). */
  readonly lazy: boolean
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
const SIGV4_KEYS = ['profile', 'region', 'service']

/** A profile name of the AWS CLI. It goes to `aws --profile` as one argument, so a plain name only. */
const AWS_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.+=@-]{0,127}$/
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/
const AWS_SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/

/** The service and region of an AWS endpoint host such as `aws-mcp.us-east-1.api.aws`, or undefined. */
export const awsEndpoint = (url: string): { service: string; region: string } | undefined => {
  if (!URL.canParse(url)) return undefined
  const host = /^https:\/\/([^/?#@:]+)(?::\d+)?(?:[/?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? ''
  const m = /^([a-z0-9-]+)\.([a-z]{2}(?:-[a-z]+)+-\d{1,2})\.(?:api\.aws|amazonaws\.com)$/.exec(host)
  return m ? { service: m[1]!, region: m[2]! } : undefined
}

/**
 * The SigV4 signing of an HTTP server. The region and service default to the ones in the host of the URL. It never
 * goes with an OAuth login or an Authorization header: the signature is the Authorization header.
 */
const parseSigV4 = (
  raw: unknown,
  url: string,
  headers: Readonly<Record<string, string>>,
  oauth: unknown,
  path: string,
  env: Env,
  errors: string[],
): SigV4 | undefined => {
  if (raw === undefined) return undefined
  if (!isObject(raw)) {
    errors.push(`${path}: must be an object with "profile"`)
    return undefined
  }
  unknownKeys(raw, SIGV4_KEYS, path, errors)
  if (oauth !== undefined && oauth !== false)
    errors.push(`${path}: an entry with "sigv4" does not log in: remove "oauth"`)
  if (Object.keys(headers).some(name => name.toLowerCase() === 'authorization'))
    errors.push(`${path}: an entry with an Authorization header cannot sign with SigV4: remove one of them`)
  const field = (key: string, rule: RegExp, fallback: string | undefined): string | undefined => {
    const value = raw[key]
    if (value === undefined) {
      if (fallback === undefined) errors.push(`${path}.${key}: is needed, because the URL is not an AWS endpoint`)
      return fallback
    }
    const text = expand(nonEmpty(value, `${path}.${key}`, errors), env, `${path}.${key}`, errors)
    if (text !== '' && !rule.test(text)) {
      errors.push(`${path}.${key}: is not a valid ${key}`)
      return undefined
    }
    return text
  }
  const endpoint = awsEndpoint(url)
  const found = errors.length
  if (raw.profile === undefined) errors.push(`${path}.profile: is needed`)
  const profile = raw.profile === undefined ? undefined : field('profile', AWS_PROFILE, undefined)
  const region = field('region', AWS_REGION, endpoint?.region)
  const service = field('service', AWS_SERVICE, endpoint?.service)
  if (errors.length !== found || !profile || !region || !service) return undefined
  return { profile, region, service }
}

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
    const where = `${path}.clientSecret`
    if (typeof clientSecret !== 'string') errors.push(`${where}: must be a string`)
    else if (id === undefined) errors.push(`${where}: needs clientId`)
    else {
      // An empty secret is a variable set to nothing, not a client without a secret: then leave the key out.
      secret = expand(clientSecret, env, where, errors)
      if (secret === '') errors.push(`${where}: must be a non-empty string`)
    }
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

/**
 * An absolute folder. The config file can live anywhere, and toolscript-mcp starts in the folder of its client, so
 * a relative path has no base that a person can predict. On Windows a path needs a drive letter or a share: `/srv`
 * is on the drive of the moment.
 */
const parseCwd = (raw: unknown, path: string, env: Env, platform: string, errors: string[]): string | undefined => {
  if (raw === undefined) return undefined
  const found = errors.length
  const cwd = expand(nonEmpty(raw, path, errors), env, path, errors)
  if (errors.length > found) return undefined
  const windows = platform === 'win32'
  if (windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(cwd) : cwd.startsWith('/')) return cwd
  const example = windows ? ' with a drive letter or a share, such as "C:/work/app"' : ', such as "/home/me/app"'
  errors.push(`${path}: must be an absolute path${example}, not ${JSON.stringify(raw)}`)
  return undefined
}

/** A list of at most `LIMITS.configGlobs` items, each one checked by `each`, or undefined with an error. */
const parseList = (
  raw: unknown,
  path: string,
  each: (item: unknown) => string | undefined,
  errors: string[],
): string[] | undefined => {
  if (!Array.isArray(raw) || raw.length > LIMITS.configGlobs) {
    errors.push(`${path}: must be an array of at most ${LIMITS.configGlobs} strings`)
    return undefined
  }
  const found = errors.length
  raw.forEach((item, i) => {
    const problem = each(item)
    if (problem !== undefined) errors.push(`${path}[${i}]: ${problem}`)
  })
  return errors.length === found ? (raw as string[]) : undefined
}

/** A folder name for `workspace.skip`: one part, with no `/`, and not `.` or `..`. */
const skipProblem = (name: unknown): string | undefined =>
  typeof name === 'string' &&
  name !== '' &&
  name.length <= 255 &&
  !/[\\/\u0000-\u001f]/.test(name) &&
  name !== '.' &&
  name !== '..'
    ? undefined
    : 'must be a folder name with no / or \\'

const TASK_KEYS = ['command', 'args', 'cwd', 'timeoutSeconds', 'env']

/**
 * The tasks of one root entry (issue #144, pull request C). Only text is checked here: a command is an absolute path
 * or a bare name, and a folder is a relative path. The host looks them up at the start and marks a task invalid with a
 * reason when it cannot run. `callTimeout` is `sandbox.callTimeoutSeconds`: no task may run longer than one call.
 */
const parseTasks = (
  raw: unknown,
  path: string,
  env: Env,
  platform: string,
  callTimeout: number,
  errors: string[],
): TaskConfig[] => {
  if (raw === undefined) return []
  if (!isObject(raw)) {
    errors.push(`${path}: must be an object of tasks, such as { "test": { "command": "node", "args": ["--test"] } }`)
    return []
  }
  const names = Object.keys(raw)
  if (names.length > TASK_LIMITS.tasks) {
    errors.push(`${path}: must have at most ${TASK_LIMITS.tasks} tasks`)
    return []
  }
  const windows = platform === 'win32'
  return names.flatMap((name): TaskConfig[] => {
    const here = at(path, name)
    const task = raw[name]
    if (!TASK_NAME.test(name)) {
      errors.push(`${here}: a task name has 1 to ${TASK_LIMITS.nameChars} characters from a-z, 0-9, - and _`)
      return []
    }
    if (!isObject(task)) {
      errors.push(`${here}: must be an object with "command"`)
      return []
    }
    const found = errors.length
    unknownKeys(task, TASK_KEYS, here, errors)
    const command = expand(nonEmpty(task.command, `${here}.command`, errors), env, `${here}.command`, errors)
    const problem = command === '' ? undefined : commandProblem(command, windows)
    if (problem !== undefined) errors.push(`${here}.command: ${problem}`)
    const args: string[] = []
    if (task.args !== undefined) {
      if (!Array.isArray(task.args) || task.args.length > TASK_LIMITS.args)
        errors.push(`${here}.args: must be an array of at most ${TASK_LIMITS.args} strings`)
      else
        task.args.forEach((a, i) => {
          const where = `${here}.args[${i}]`
          if (typeof a !== 'string') return void errors.push(`${where}: must be a string`)
          const text = expand(a, env, where, errors)
          if (text.length > TASK_LIMITS.argChars || text.includes('\u0000'))
            errors.push(`${where}: must hold at most ${TASK_LIMITS.argChars} characters and no NUL character`)
          args.push(text)
        })
    }
    let cwd: readonly string[] = []
    if (task.cwd !== undefined) {
      const parts = typeof task.cwd === 'string' ? cwdParts(task.cwd, windows) : 'must be a string'
      if (typeof parts === 'string') errors.push(`${here}.cwd: ${parts}`)
      else cwd = parts
    }
    const limit = Math.min(callTimeout, TASK_LIMITS.defaultSeconds)
    let timeoutSeconds = limit
    const t = task.timeoutSeconds
    if (t !== undefined) {
      if (typeof t === 'number' && Number.isInteger(t) && t >= 1 && t <= callTimeout) timeoutSeconds = t
      else
        errors.push(
          `${here}.timeoutSeconds: must be a whole number of seconds from 1 to ${callTimeout}, the value of sandbox.callTimeoutSeconds`,
        )
    }
    const variables = stringMap(task.env, `${here}.env`, env, errors)
    const entries = Object.entries(variables)
    if (entries.length > TASK_LIMITS.envVars)
      errors.push(`${here}.env: must have at most ${TASK_LIMITS.envVars} variables`)
    for (const [key, value] of entries)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.length > TASK_LIMITS.envChars || value.includes('\u0000'))
        errors.push(
          `${at(`${here}.env`, key)}: the name must have letters, digits and underscores, and the value at most ${TASK_LIMITS.envChars} characters and no NUL character`,
        )
    // The timer of the task fires one second before the call limit, so the program sees `timedOut`, not a cancel.
    timeoutSeconds = Math.max(1, Math.min(timeoutSeconds, callTimeout - 1))
    return errors.length > found ? [] : [{ name, command, args, cwd, timeoutSeconds, env: variables }]
  })
}

/**
 * The `workspace` section (issue #144). Every error names the key, and none holds a value of the file. A root is an
 * absolute path as `cwd` is. `write` is read now and has no effect before the editing tools ship.
 * `callTimeout` is `sandbox.callTimeoutSeconds`, the limit of a task.
 */
const parseWorkspace = (
  raw: unknown,
  env: Env,
  platform: string,
  callTimeout: number,
  errors: string[],
): WorkspaceConfig | undefined => {
  const here = WORKSPACE_KEY
  const found = errors.length
  if (!isObject(raw)) {
    errors.push(`${here}: must be an object with "roots"`)
    return undefined
  }
  unknownKeys(raw, ['roots', 'exclude', 'skip'], here, errors)
  const roots: { path: string; write: boolean; tasks?: readonly TaskConfig[] }[] = []
  if (!Array.isArray(raw.roots) || raw.roots.length < 1 || raw.roots.length > LIMITS.roots)
    errors.push(`${here}.roots: must be an array of 1 to ${LIMITS.roots} entries, such as [{ "path": "/home/me/app" }]`)
  else
    raw.roots.forEach((entry, i) => {
      const path = `${here}.roots[${i}]`
      if (!isObject(entry)) return void errors.push(`${path}: must be an object with "path"`)
      unknownKeys(entry, ['path', 'write', 'tasks'], path, errors)
      const before = errors.length
      const text = expand(nonEmpty(entry.path, `${path}.path`, errors), env, `${path}.path`, errors)
      const absolute = platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(text) : text.startsWith('/')
      if (errors.length === before && !absolute)
        errors.push(`${path}.path: must be an absolute path${platform === 'win32' ? ' with a drive letter' : ''}`)
      if (entry.write !== undefined && typeof entry.write !== 'boolean')
        errors.push(`${path}.write: must be true or false`)
      const tasks = parseTasks(entry.tasks, `${path}.tasks`, env, platform, callTimeout, errors)
      if (errors.length === before)
        roots.push({ path: text, write: entry.write === true, ...(tasks.length > 0 && { tasks }) })
    })
  const exclude = raw.exclude === undefined ? [] : parseList(raw.exclude, `${here}.exclude`, globProblem, errors)
  const skip = raw.skip === undefined ? [...DEFAULT_SKIP] : parseList(raw.skip, `${here}.skip`, skipProblem, errors)
  return errors.length > found ? undefined : { roots, exclude: exclude ?? [], skip: skip ?? [] }
}

const parseTrust = (raw: unknown, path: string, errors: string[]): Trust => {
  if (raw === true) return { untrusted: true }
  if (raw !== undefined && raw !== false) errors.push(`${path}: must be true or false`)
  return {}
}

/** `TOOLSCRIPT_SHARE` (0 or 1), else the top-level `"share"`, else off. No text repeats a bad value. */
const parseShare = (raw: unknown, env: Env, errors: string[]): Config['share'] => {
  if (raw !== undefined && typeof raw !== 'boolean') errors.push('share: must be true or false')
  const fromEnv = env.TOOLSCRIPT_SHARE
  if (fromEnv === '0' || fromEnv === '1') return { on: fromEnv === '1', source: 'env' }
  if (fromEnv !== undefined && fromEnv !== '') errors.push('TOOLSCRIPT_SHARE: must be 0 or 1')
  return typeof raw === 'boolean' ? { on: raw, source: 'config' } : { on: false, source: 'default' }
}

/** `TOOLSCRIPT_LAZY`: 0 turns every lazy start off, 1 or nothing leaves it on. No text repeats a bad value. */
const parseLazy = (env: Env, errors: string[]): boolean => {
  const value = env.TOOLSCRIPT_LAZY
  if (value === '0') return false
  if (value !== undefined && value !== '' && value !== '1') errors.push('TOOLSCRIPT_LAZY: must be 0 or 1')
  return true
}

const parseServer = (
  raw: unknown,
  path: string,
  env: Env,
  platform: string,
  errors: string[],
): ServerConfig | undefined => {
  if (!isObject(raw)) {
    errors.push(`${path}: must be an object`)
    return undefined
  }
  const type = raw.type ?? 'stdio'
  if (type === 'stdio') {
    unknownKeys(raw, ['type', 'command', 'args', 'env', 'cwd', 'share', 'lazy', 'untrusted'], path, errors)
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
    const cwd = parseCwd(raw.cwd, `${path}.cwd`, env, platform, errors)
    const share = raw.share
    if (share !== undefined && share !== true && share !== false && share !== 'folder')
      errors.push(`${path}.share: must be true, false or "folder"`)
    const lazy = raw.lazy
    if (lazy !== undefined && typeof lazy !== 'boolean') errors.push(`${path}.lazy: must be true or false`)
    return {
      kind: 'stdio',
      command,
      args,
      env: stringMap(raw.env, `${path}.env`, env, errors),
      ...(cwd && { cwd }),
      ...((share === true || share === false || share === 'folder') && { share }),
      ...(typeof lazy === 'boolean' && { lazy }),
      ...parseTrust(raw.untrusted, `${path}.untrusted`, errors),
    }
  }
  if (type === 'http') {
    unknownKeys(raw, ['type', 'url', 'headers', 'oauth', 'sigv4', 'untrusted'], path, errors)
    const found = errors.length
    const url = expand(nonEmpty(raw.url, `${path}.url`, errors), env, `${path}.url`, errors)
    // An empty or unexpanded url has its error already. The text names only the
    // key: the URL can come from a variable and hold a token.
    if (errors.length === found) {
      if (!/^https?:\/\//i.test(url)) errors.push(`${path}.url: must start with http:// or https://`)
      else if (!URL.canParse(url)) errors.push(`${path}.url: must be a valid URL`)
    }
    const headers = stringMap(raw.headers, `${path}.headers`, env, errors)
    const sigv4 = parseSigV4(raw.sigv4, url, headers, raw.oauth, `${path}.sigv4`, env, errors)
    // A signed entry takes no OAuth login: its errors are in the sigv4 check.
    const oauth = raw.sigv4 === undefined ? parseOAuth(raw.oauth, headers, `${path}.oauth`, env, errors) : undefined
    return {
      kind: 'http',
      url,
      headers,
      ...(oauth && { oauth }),
      ...(sigv4 && { sigv4 }),
      ...parseTrust(raw.untrusted, `${path}.untrusted`, errors),
    }
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

// The errors name places and hold no text of the file: a program can write the config through a tool, and the note
// of the next run shows them to the model.
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
    const unknown = Object.keys(entry).filter(key => key !== 'match' && key !== 'action').length
    if (unknown > 0) errors.push(`${path}: ${unknown} unknown key${unknown === 1 ? '' : 's'} (known: match, action)`)
    const { match, action } = entry
    const okMatch = typeof match === 'string' && /^(mcp__|\*)/.test(match)
    if (!okMatch) errors.push(`${path}.match: must be ${MATCH}`)
    const okAction = typeof action === 'string' && (ACTIONS as readonly string[]).includes(action)
    if (!okAction) errors.push(`${path}.action: must be "allow", "deny" or "ask"`)
    return okMatch && okAction ? [{ match: match as string, action: action as Action, index }] : []
  })
}

/** The key of the Claude Code bridge in the README and the setup skill. */
const BRIDGE_KEY = 'claude-code'

// Claude Code, in any case: `claude`, `claude.exe`, `claude.cmd` or `claude.ps1`, alone or at the end of a path; the
// package `@anthropic-ai/claude-code`, also with `@<version>` (a range such as `@>=2` splits at `>`); or a path that
// ends in `claude-code/cli.js` or `claude-code/cli.mjs`.
const CLAUDE =
  /^(?:(?:.*[\\/])?claude(?:\.exe|\.cmd|\.ps1)?|@anthropic-ai\/claude-code(?:@[^\\/]*)?|.*[\\/]claude-code[\\/]cli\.m?js)$/i
// What the stage of a bridge match waits for: the Claude Code word, then `mcp`, then `serve`.
const BRIDGE_WORDS = [
  (word: string) => CLAUDE.test(word),
  (word: string) => word === 'mcp',
  (word: string) => word === 'serve',
]

/**
 * True for Claude Code serving its own tools, such as Bash and Write: the key
 * BRIDGE_KEY, or a stdio entry whose words hold the Claude Code word, then
 * `mcp`, then `serve`, with any words between. A word ends at white space or
 * a shell operator, and quotes and the `^` of cmd do not count, so
 * `cmd /c "cd /d C:\w&&claude mcp serve"` and `claude --model opus mcp serve`
 * count. A launch that is no bridge but has the three words counts too, which
 * only asks more. A program that calls these tools skips the permission rules
 * and hooks of Claude Code, so only the policy guards them. One pass over the
 * words: a config can hold a long hostile command line.
 */
const isBridge = (key: ServerKey, server: ServerEntry): boolean => {
  if (key === BRIDGE_KEY) return true
  if (server.kind !== 'stdio') return false
  let stage = 0
  for (const arg of [server.command, ...server.args])
    for (const word of arg.replace(/["'^]/g, '').split(/[\s;&|()<>`$,]+/))
      if (word !== '' && BRIDGE_WORDS[stage]!(word) && ++stage === BRIDGE_WORDS.length) return true
  return false
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
  unknownKeys(raw, ['$schema', 'mcpServers', 'sandbox', 'policy', 'log', 'share', WORKSPACE_KEY], 'config', errors)

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
      const server = parseServer(entry, path, env, platform, entryErrors)
      servers.set(key, server && entryErrors.length === 0 ? server : { kind: 'invalid', errors: entryErrors })
    }

  // Read before the section: no task may run longer than one call (`sandbox.callTimeoutSeconds`).
  const sandbox = parseSandbox(raw.sandbox, execPath, platform, errors)

  // The section is an entry of its own: an error in it, or a clash with a server of the same key, makes only
  // `workspace` invalid, and the other servers start.
  let workspace: WorkspaceConfig | undefined
  if (raw.workspace !== undefined) {
    const sectionErrors: string[] = []
    const parsed = parseWorkspace(raw.workspace, env, platform, sandbox.callTimeoutSeconds, sectionErrors)
    if (servers.has(WORKSPACE_KEY as ServerKey))
      servers.set(WORKSPACE_KEY as ServerKey, {
        kind: 'invalid',
        errors: [
          `the config has a "workspace" section and an mcpServers entry with the key "${WORKSPACE_KEY}": the built-in Workspace uses that key. Rename the server, or remove the section`,
        ],
      })
    else if (parsed === undefined) servers.set(WORKSPACE_KEY as ServerKey, { kind: 'invalid', errors: sectionErrors })
    else {
      servers.set(WORKSPACE_KEY as ServerKey, { kind: 'workspace', untrusted: true })
      workspace = parsed
    }
  }

  const policy = parsePolicy(raw.policy, errors)
  if (raw.log !== undefined && typeof raw.log !== 'boolean')
    errors.push(`log: must be true or false, not ${JSON.stringify(raw.log)}`)
  const log = raw.log !== false
  const bridges = new Set([...servers].flatMap(([key, server]) => (isBridge(key, server) ? [key] : [])))
  // A bridge is never shared. Only its entry is invalid, and the key stays a bridge.
  for (const key of bridges) {
    const server = servers.get(key)
    if (server?.kind === 'stdio' && (server.share === true || server.share === 'folder'))
      servers.set(key, {
        kind: 'invalid',
        errors: [
          `${at('mcpServers', key)}.share: a Claude Code bridge is never shared: remove "share" or set it to false`,
        ],
      })
  }
  const share = parseShare(raw.share, env, errors)
  // With sharing on, a shared or per-folder server has its child in the broker, which has its own idle stop.
  if (share.on)
    for (const [key, server] of servers) {
      if (server.kind !== 'stdio' || server.lazy === undefined) continue
      if (classify(key, server, bridges)?.class !== 'session')
        servers.set(key, {
          kind: 'invalid',
          errors: [
            `${at('mcpServers', key)}.lazy: a shared or per-folder server has its child in the broker: remove "lazy", or set "share": false`,
          ],
        })
    }
  const lazy = parseLazy(env, errors)

  return errors.length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        config: {
          servers,
          bridges,
          guards: { bridges, workspace: workspace !== undefined },
          ...(workspace !== undefined && { workspace }),
          sandbox,
          policy,
          log,
          share,
          lazy,
        },
      }
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

/** The scheme, host and port of a URL, with no login, path, query or fragment. */
export const urlOrigin = (url: string): string | undefined => (URL.canParse(url) ? new URL(url).origin : undefined)

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
 * The client ID and secret as an HTTP Basic Authorization header holds them, or undefined when btoa cannot encode
 * them: the SDK then sends no header either.
 */
export const basicCredentials = (id: string, secret: string): string | undefined => {
  try {
    return btoa(`${id}:${secret}`)
  } catch {
    return undefined
  }
}

/**
 * encodeURIComponent with each lone surrogate as U+FFFD, as a form and fetch encode it: encodeURIComponent throws on
 * one, and a server can send one in a token or a client.
 */
const encodeUri = (value: string): string =>
  encodeURIComponent(
    value.replace(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      String.fromCharCode(0xfffd),
    ),
  )

/**
 * An OAuth client with a secret. `registered` when an authorization server registered it: that server picked both the
 * id and the secret.
 */
export type ClientSecret = { readonly id: string; readonly secret: string; readonly registered: boolean }

/** `value` as an HTML form writes it. */
const formEncode = (value: string): string =>
  encodeUri(value)
    .replace(/[!'()~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+')

/**
 * `text` with each client secret replaced by `***` where it stands as one: the value of a `client_secret` form field
 * or JSON key, and the secret of `client` in its Basic pair and Basic header value, as the SDK sends them, URL-encoded
 * and form-encoded (RFC 6749 section 2.3.1). redact hides a secret under 8 characters nowhere else, so a server cannot
 * blank a common word. For the same reason the pair `id:secret` hides only with an id that is not empty and a secret
 * of 8 or more characters: a server that registers a client picks both, and id `https` with secret `//as.` would blank
 * each `https://as.`. For a client of the config, a secret of 4 or more characters with a word character is enough.
 * Any other pair shows, as one with a secret under 4 characters or without a word character, but its Basic value and
 * `client_secret=` still hide.
 */
export const hideClientSecret = (text: string, client: ClientSecret | undefined): string => {
  let hidden = text
  if (client !== undefined) {
    const { id, secret, registered } = client
    hidden = hidden.replaceAll(`client_secret=${secret}`, () => 'client_secret=***')
    const pairs = id !== '' && (registered ? secret.length >= 8 : secret.length >= 4 && /\w/.test(secret))
    for (const [i, s] of [
      [id, secret],
      [encodeUri(id), encodeUri(secret)],
      [formEncode(id), formEncode(secret)],
    ] as const) {
      const basic = basicCredentials(i, s)
      if (basic !== undefined) hidden = hidden.replaceAll(`Basic ${basic}`, () => 'Basic ***')
      if (pairs) hidden = hidden.replaceAll(`${i}:${s}`, () => `${i}:***`)
    }
  }
  return hidden
    .replace(/(client_secret=)[^&\s"]*/g, '$1***')
    .replace(/("client_secret"\s*:\s*")(?:[^"\\]|\\.)*/g, '$1***')
}

/**
 * `value` as encodeURIComponent and as an HTML form write it, also with lowercase hex digits, and inside a JSON
 * string: an error can echo a URL, a form or a JSON body that it got.
 */
const encodings = (value: string): string[] => {
  const uri = encodeUri(value)
  const form = formEncode(value)
  const lower = (encoded: string) => encoded.replace(/%[0-9A-F]{2}/g, hex => hex.toLowerCase())
  return [uri, form, lower(uri), lower(form), JSON.stringify(value).slice(1, -1)]
}

/**
 * `text` with the secrets of the server replaced by `***`: a failed child's stderr can echo a token, and the reason
 * goes to the model. The secrets are the ones that hideArgSecrets finds in the args or the URL, the `env` and `headers`
 * values with a secret name or a secret word or of 12 characters or more, the OAuth client secret and its Basic
 * header value, the secrets in `more` (the OAuth tokens, code and verifier of this server), the secrets inside every
 * such value, each word of 8 or more in one ("Bearer <token>"), and the URL-decoded, URL-encoded and form-encoded
 * form of each, of 4 characters or more. A value in `more` and each of its forms count only with 8 or more. A number
 * shorter than 12 digits is never replaced, and a plain word only as a whole word, so `localhost:3000` stays readable.
 * The user and password of any URL in `text` are hidden too.
 */
export const redact = (text: string, server: ServerConfig, more: readonly string[] = []): string => {
  const client = server.kind === 'http' ? server.oauth?.client : undefined
  const values = [
    ...(server.kind === 'stdio' ? hideArgSecrets(server.args) : hideUrlSecrets(server.url)).secrets,
    ...Object.entries(server.kind === 'stdio' ? server.env : server.headers).flatMap(([key, value]) => [
      ...(SECRET_NAME.test(key) || isSecretWord(value) || value.length >= LONG ? [value] : []),
      ...hideArgSecrets([value]).secrets,
    ]),
    ...(client?.secret === undefined ? [] : [client.secret, basicCredentials(client.id, client.secret) ?? '']),
  ]
  const forms = (vs: readonly string[]) =>
    [...vs, ...vs.flatMap(v => v.split(/\s+/).filter(w => w.length >= 8))].flatMap(v => [
      v,
      decoded(v),
      ...encodings(v),
    ])
  // A server picks the values in `more`: one that is, decodes to or encodes to a common text would blank it in each
  // reason, as `://` would blank each `%3A%2F%2F`.
  const long = (vs: readonly string[]) => vs.filter(v => v.length >= 8)
  const all = new Set([...forms(values).filter(v => v.length >= 4), ...long(forms(long(more)))])
  const secrets = [...all].filter(v => !(/^\d+$/.test(v) && v.length < LONG))
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
