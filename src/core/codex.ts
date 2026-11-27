// The Codex servers of init (issue #86): the fields that Codex gives for a server, from `codex mcp get --json` or from
// config.toml, and their map to a toolscript-mcp entry, policy rules and notes. Pure: the host reads and spawns. The
// map is the table of the issue: every field is mapped, dropped with a reason, or listed as left out by name. A
// literal env or header value never goes into a reason, a note or a rule.

import { PLAIN_NAME } from './commands.ts'
import { matches, shownName } from './policy.ts'
import { UNREADABLE_ENTRY } from './toml.ts'

export type CodexRaw =
  | {
      readonly via: 'codex' | 'config.toml'
      readonly fields: Readonly<Record<string, unknown>>
      readonly authStatus?: string
      /** Path A: the keys that config.toml sets and `codex mcp get --json` does not show. */
      readonly unseen?: readonly string[]
    }
  | { readonly skip: string }

export type CodexRule = { readonly match: string; readonly action: 'deny' | 'ask' }

type StringMap = Readonly<Record<string, string>>

export type CodexEntry =
  | { readonly command: string; readonly args?: readonly string[]; readonly env?: StringMap; readonly cwd?: string }
  | { readonly type: 'http'; readonly url: string; readonly headers?: StringMap }

export type CodexMapped =
  | {
      readonly entry: CodexEntry
      /** The keys that init left out, each with its reason. */
      readonly dropped: readonly string[]
      /** The rules of `enabled_tools` and `disabled_tools`, in the order in which the first match decides. */
      readonly policy: readonly CodexRule[]
      /** Plain sentences about the server, with no command and no value. */
      readonly notes: readonly string[]
      /** Codex has an OAuth login for this server: the step is the login command of toolscript-mcp. */
      readonly login: boolean
    }
  | { readonly why: string }

/** At most this many tool names in the two lists of one server. */
export const TOOL_NAMES_MAX = 200

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The reference to an environment variable that the config expands: `${NAME}`. */
const ref = (name: string): string => '${' + name + '}'

const STDIO_KEYS = ['command', 'args', 'env', 'env_vars', 'cwd']
const HTTP_KEYS = ['url', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'http_headers_helper']
const COMMON_KEYS = ['enabled', 'enabled_tools', 'disabled_tools', 'startup_timeout_sec', 'tool_timeout_sec']
/** Fields of `codex mcp get --json` that carry no setting. */
const SILENT_KEYS = ['name', 'disabled_reason']

const REASON: Readonly<Record<string, string>> = {
  http_headers_helper: 'init does not run the helper command of Codex',
  startup_timeout_sec: 'toolscript-mcp has no time limit for the start of one server',
  tool_timeout_sec: 'toolscript-mcp has one time limit for every call, set in the config',
  tools: 'per-tool settings: init does not map them',
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
const isStringMap = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.values(v).every(s => typeof s === 'string')

/** A C0 control character or DEL: never in a name, a command, an argument, a value or a URL. */
export const hasControl = (text: string): boolean => /[\u0000-\u001f\u007f]/.test(text)

/**
 * The keys of a Codex server that ` + "`codex mcp get --json`" + ` shows. config.toml can set more (McpServerConfig in
 * codex-rs/config/src/mcp_types.rs): scopes, oauth, oauth_resource, default_tools_approval_mode, tools, required,
 * supports_parallel_tool_calls, omit_tools_from, auth, environment_id.
 */
export const SHOWN_KEYS = [...STDIO_KEYS, ...HTTP_KEYS, ...COMMON_KEYS]

/** The keys that the CLI does not show, for the note when init cannot read config.toml. */
export const HIDDEN_KEYS = [
  'scopes',
  'oauth',
  'oauth_resource',
  'default_tools_approval_mode',
  'tools',
  'required',
  'supports_parallel_tool_calls',
  'omit_tools_from',
  'auth',
  'environment_id',
]

const present = (fields: Readonly<Record<string, unknown>>, key: string) =>
  fields[key] !== undefined && fields[key] !== null

/**
 * The rules of the tool lists of one server, in the order in which the first match decides: a disabled tool is denied
 * before an enabled one is asked, and the tools that Codex does not list are denied last: never looser than Codex.
 * `enabled` undefined means that Codex lists no `enabled_tools`, so no tool is held back.
 */
const buildRules = (
  prefix: string,
  disabled: readonly string[],
  enabled: readonly string[] | undefined,
): CodexRule[] => [
  ...disabled.map((t): CodexRule => ({ match: prefix + t, action: 'deny' })),
  ...(enabled === undefined
    ? []
    : [
        ...enabled.map((t): CodexRule => ({ match: prefix + t, action: 'ask' })),
        { match: `${prefix}*`, action: 'deny' } as CodexRule,
      ]),
]

/** The deny rule of a tool, the ask rule of a tool, and the deny rule of the rest of a server: the three kinds of rule. */
const isRest = (r: CodexRule) => r.action === 'deny' && r.match.endsWith('*')
const isToolDeny = (r: CodexRule) => r.action === 'deny' && !r.match.endsWith('*')

/**
 * The rules of one server from two clients that define the same entry: every tool that one of them disables stays
 * disabled, and a tool stays asked only when each client that lists `enabled_tools` lists it. Never looser than either.
 */
export const combineRules = (key: string, a: readonly CodexRule[], b: readonly CodexRule[]): CodexRule[] => {
  const prefix = `mcp__${key}__`
  const lists = (rules: readonly CodexRule[]) => ({
    disabled: rules.filter(isToolDeny).map(r => r.match.slice(prefix.length)),
    enabled: rules.some(isRest)
      ? rules.filter(r => r.action === 'ask').map(r => r.match.slice(prefix.length))
      : undefined,
  })
  const x = lists(a)
  const y = lists(b)
  const enabled =
    x.enabled === undefined
      ? y.enabled
      : y.enabled === undefined
        ? x.enabled
        : x.enabled.filter(t => y.enabled!.includes(t))
  return buildRules(prefix, [...new Set([...x.disabled, ...y.disabled])], enabled)
}

/**
 * The rules of every imported server as the config holds them, ahead of the old rules, which keep their order and stay
 * as they are: a rule of the old policy is never moved, so the policy of a server that init does not import is the
 * same as before. `decide` (policy.ts) takes the first rule that matches, so the generated rules go in this order: the
 * denies of a tool, then the asks, then the deny of the rest of each server. A generated rule only matches the tools
 * `mcp__<key>__...` of an imported server. An old deny rule that matches a tool that Codex lists and asks about
 * would lose to that ask, so the tool gets a generated deny instead of the ask: no old deny gets weaker. An old allow
 * rule goes after the generated rules, so it loosens neither an ask nor the deny of an unlisted tool.
 */
export const mergePolicy = (generated: readonly CodexRule[], existing: readonly unknown[] = []): unknown[] => {
  const denies = existing.flatMap(r => {
    const rule = r as { action?: unknown; match?: unknown } | null
    return typeof rule === 'object' && rule !== null && rule.action === 'deny' && typeof rule.match === 'string'
      ? [rule.match]
      : []
  })
  const asks = generated.filter(r => r.action === 'ask')
  const held = asks.filter(r => denies.some(d => matches(d, r.match))).map((r): CodexRule => ({ ...r, action: 'deny' }))
  return [
    ...generated.filter(isToolDeny),
    ...held,
    ...asks.filter(r => !held.some(h => h.match === r.match)),
    ...generated.filter(isRest),
    ...existing,
  ]
}

/** The server with the fields `fields` as a toolscript-mcp entry, or why init skips it. `key` is the key of the server in the config. */
export const mapCodex = (
  key: string,
  fields: Readonly<Record<string, unknown>>,
  via: 'codex' | 'config.toml',
  authStatus: string | undefined,
  unseen: readonly string[] = [],
): CodexMapped => {
  if (present(fields, 'enabled') && typeof fields.enabled !== 'boolean')
    return { why: '"enabled" is not true or false' }
  if (fields.enabled === false) return { why: 'disabled in Codex' }
  const hasCommand = present(fields, 'command')
  const hasUrl = present(fields, 'url')
  if (hasCommand && hasUrl) return { why: 'has a command and a url' }
  if (!hasCommand && !hasUrl) return { why: 'no command and no url' }
  const get = (name: string) => (present(fields, name) ? fields[name] : undefined)
  const notes: string[] = []
  const dropped: string[] = []
  let entry: CodexEntry
  let helperOnly = false
  if (hasCommand) {
    const { command, args, env, env_vars, cwd } = {
      command: get('command'),
      args: get('args'),
      env: get('env'),
      env_vars: get('env_vars'),
      cwd: get('cwd'),
    }
    if (typeof command !== 'string' || command.trim() === '') return { why: '"command" is not a text' }
    if (args !== undefined && !isStrings(args)) return { why: '"args" is not a list of strings' }
    if (env !== undefined && !isStringMap(env)) return { why: '"env" is not a table of strings' }
    if (Array.isArray(env_vars) && env_vars.some(isObject))
      return { why: 'a table in "env_vars" (name and source) is a form that init does not read' }
    if (env_vars !== undefined && !isStrings(env_vars)) return { why: '"env_vars" is not a list of strings' }
    if (cwd !== undefined && typeof cwd !== 'string') return { why: '"cwd" is not a text' }
    if ((env_vars ?? []).some(v => !VARIABLE.test(v))) return { why: 'an entry of "env_vars" is not a variable name' }
    const map: Record<string, string> = { ...(env ?? {}) }
    for (const v of env_vars ?? []) if (!Object.hasOwn(map, v)) map[v] = ref(v)
    entry = {
      command,
      ...(args?.length ? { args: [...args] } : {}),
      ...(Object.keys(map).length > 0 ? { env: map } : {}),
      ...(cwd ? { cwd } : {}),
    }
  } else {
    const { url, bearer, headers, envHeaders } = {
      url: get('url'),
      bearer: get('bearer_token_env_var'),
      headers: get('http_headers'),
      envHeaders: get('env_http_headers'),
    }
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { why: 'no http:// or https:// url' }
    if (bearer !== undefined && (typeof bearer !== 'string' || !VARIABLE.test(bearer)))
      return { why: '"bearer_token_env_var" is not a variable name' }
    if (headers !== undefined && !isStringMap(headers)) return { why: '"http_headers" is not a table of strings' }
    if (envHeaders !== undefined && !isStringMap(envHeaders))
      return { why: '"env_http_headers" is not a table of strings' }
    if (Object.values(envHeaders ?? {}).some(v => !VARIABLE.test(v)))
      return { why: 'a value of "env_http_headers" is not a variable name' }
    const map: Record<string, string> = { ...(headers ?? {}) }
    for (const [name, variable] of Object.entries(envHeaders ?? {})) map[name] = ref(variable)
    if (bearer !== undefined) map.Authorization = `Bearer ${ref(bearer)}`
    entry = { type: 'http', url, ...(Object.keys(map).length > 0 ? { headers: map } : {}) }
    helperOnly = get('http_headers_helper') !== undefined && Object.keys(map).length === 0
  }
  // A name, a command, an argument, a value or a URL with a control character, also one that an escape of TOML or JSON
  // made, never reaches a command line or the screen.
  const texts =
    'type' in entry
      ? [entry.url, ...Object.entries(entry.headers ?? {}).flat()]
      : [entry.command, entry.cwd ?? '', ...(entry.args ?? []), ...Object.entries(entry.env ?? {}).flat()]
  if (texts.some(hasControl)) return { why: 'a command, an argument, a value or a url holds a control character' }
  const own = hasCommand ? STDIO_KEYS : HTTP_KEYS
  const other = hasCommand ? HTTP_KEYS : STDIO_KEYS
  // A key name comes from the file: it prints through shownName, so an escape of TOML never reaches the screen raw.
  const left = (name: string, why: string) => dropped.push(`${shownName(name)} (${why})`)
  const unknown = 'init does not know this key'
  for (const name of Object.keys(fields)) {
    if (!present(fields, name)) continue
    if (Object.hasOwn(REASON, name)) left(name, REASON[name]!)
    else if (other.includes(name)) left(name, 'not used by this kind of server')
    else if (!own.includes(name) && !COMMON_KEYS.includes(name) && !SILENT_KEYS.includes(name)) left(name, unknown)
  }
  for (const name of unseen)
    if (!Object.hasOwn(fields, name)) left(name, Object.hasOwn(REASON, name) ? REASON[name]! : unknown)
  if (helperOnly)
    notes.push(`${key}: Codex took its header from http_headers_helper only. The server has no header now.`)
  const enabledTools = get('enabled_tools')
  const disabledTools = get('disabled_tools')
  if (enabledTools !== undefined && !isStrings(enabledTools)) return { why: '"enabled_tools" is not a list of strings' }
  if (disabledTools !== undefined && !isStrings(disabledTools))
    return { why: '"disabled_tools" is not a list of strings' }
  const names = [...(enabledTools ?? []), ...(disabledTools ?? [])]
  if (names.length > TOOL_NAMES_MAX)
    return { why: `more than ${TOOL_NAMES_MAX} tool names in enabled_tools and disabled_tools` }
  if (names.some(n => !PLAIN_NAME.test(n)))
    return { why: 'a tool name in enabled_tools or disabled_tools holds a character that a rule cannot name' }
  const policy = buildRules(`mcp__${key}__`, disabledTools ?? [], enabledTools)
  // McpAuthStatus of Codex is serialized in snake_case: unknown, unsupported, not_logged_in, bearer_token, o_auth
  // (codex-rs/protocol/src/protocol.rs, printed by codex-rs/cli/src/mcp_cmd.rs). A login needs the last two states.
  const oauth = authStatus === 'o_auth' || authStatus === 'not_logged_in'
  const login = 'type' in entry && via === 'codex' && oauth
  if ('type' in entry && via === 'config.toml' && entry.headers === undefined)
    notes.push(`${key}: init read config.toml only, so it could not see the login state of this HTTP server.`)
  return { entry, dropped, policy, notes, login }
}

/** The text that init prints when it skips a server of config.toml that it cannot read. */
export const UNREADABLE = UNREADABLE_ENTRY

// ---------------------------------------------------------------------------------------------------------------
// The JSON of the Codex CLI

/** A name and the login state of each server of `codex mcp list --json`, or undefined for any other JSON. */
export const parseCodexList = (json: unknown): { name: string; authStatus: string | undefined }[] | undefined => {
  if (!Array.isArray(json)) return undefined
  const out: { name: string; authStatus: string | undefined }[] = []
  for (const item of json) {
    if (!isObject(item) || typeof item.name !== 'string' || item.name === '') return undefined
    if (item.auth_status !== undefined && item.auth_status !== null && typeof item.auth_status !== 'string')
      return undefined
    out.push({ name: item.name, authStatus: typeof item.auth_status === 'string' ? item.auth_status : undefined })
  }
  return new Set(out.map(o => o.name)).size === out.length ? out : undefined
}

const TRANSPORTS = ['stdio', 'streamable_http']

/**
 * The fields of one server from `codex mcp get <name> --json`, or undefined for any other JSON. The transport
 * is flattened, a null is no field, and a field that init does not know stays, so the map lists it. A transport type
 * other than stdio and streamable_http gives a `skip`.
 */
export const parseCodexGet = (json: unknown, authStatus: string | undefined): CodexRaw | undefined => {
  if (!isObject(json) || typeof json.name !== 'string' || !isObject(json.transport)) return undefined
  const { type, ...transport } = json.transport
  if (typeof type !== 'string') return undefined
  if (!TRANSPORTS.includes(type)) return { skip: 'its transport is not stdio or streamable HTTP' }
  const { transport: _t, ...top } = json
  const fields = Object.fromEntries(Object.entries({ ...top, ...transport }).filter(([, v]) => v !== null))
  return { via: 'codex', fields, ...(authStatus !== undefined && { authStatus }) }
}
