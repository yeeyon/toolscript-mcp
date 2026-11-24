// `toolscript-mcp doctor` checks a whole setup and prints one line per finding: its status, the check and the detail.
// This file holds the shape of a line and the parts of the checks that need no IO: the Node version, a server state,
// the policy against the listed tools and the stale OAuth stores. src/host/doctor.ts runs the checks.

import { catalogOf, interactiveTools, type ServerState, type SettledState } from './catalog.ts'
import { loginReason, type Config, type ServerKey } from './config.ts'
import { LAZY_IDLE_MS, isLazy } from './lazy.ts'
import { classify, type Class } from './share.ts'
import {
  decide,
  matches,
  printable,
  ruleText,
  shownName,
  type Bridges,
  type Guards,
  type Policy,
  type Rule,
} from './policy.ts'

/** `info` is a fact to know, `warn` a problem that leaves the setup working, `fail` a problem that stops it. */
export type Status = 'ok' | 'info' | 'warn' | 'fail'

/** The checks in the order that doctor prints them. */
export const CHECK_NAMES = [
  'node',
  'config',
  'servers',
  'workspace',
  'share',
  'broker',
  'lazy',
  'policy',
  'sandbox',
  'run-log',
  'files',
] as const
export type CheckName = (typeof CHECK_NAMES)[number]

/** What one check found. A check gives one finding or more. */
export type Finding = { readonly status: Status; readonly detail: string }

export type Check = Finding & { readonly name: CheckName }

export const ok = (detail: string): Finding => ({ status: 'ok', detail })
export const info = (detail: string): Finding => ({ status: 'info', detail })
export const warn = (detail: string): Finding => ({ status: 'warn', detail })
export const fail = (detail: string): Finding => ({ status: 'fail', detail })

/** `warn  policy   <detail>`. Every character outside printable ASCII shows as a `\u` escape. */
export const checkLine = ({ status, name, detail }: Check): string =>
  `${status.padEnd(4)}  ${name.padEnd(7)}  ${printable(detail)}`

/** 1 when a check failed, else 0. */
export const doctorExit = (checks: readonly Check[]): number => (checks.some(c => c.status === 'fail') ? 1 : 0)

/** The oldest Node that runs the sandbox: the launcher passes `--permission`. */
const MIN_NODE = [22, 13] as const

/** True for `v22.13.0` or later, false for an older version, undefined when `version` is not a Node version. */
export const recentNode = (version: string): boolean | undefined => {
  const m = /^v(\d+)\.(\d+)\.\d+/.exec(version.trim())
  if (m === null) return undefined
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

/** The finding for the version of one Node binary: `what` names the binary. */
export const nodeFinding = (what: string, version: string): Finding => {
  const recent = recentNode(version)
  const shown = shownName(version.trim())
  if (recent === undefined) return fail(`${what} printed ${shown}, which is not a Node version`)
  return recent ? ok(`${what} ${shown}`) : fail(`${what} ${shown} is older than 22.13, which the sandbox needs`)
}

/**
 * The finding for one server once it connected or failed. `login` is its login command, `untrusted` its mark in the
 * config. The reason of a failed server is as connectAll gives it: secrets hidden, and no text of an untrusted server.
 */
export const serverFinding = (state: SettledState, untrusted: boolean, login: string): Finding => {
  const server = untrusted ? `${state.key} (untrusted)` : state.key
  if (state.status === 'connected') return ok(`${server}: connected, ${state.tools.length} tools`)
  return state.reason.startsWith(loginReason(login))
    ? fail(`${server}: needs an OAuth login. Run this command in a terminal: ${login}`)
    : fail(`${server}: cannot connect: ${state.reason}`)
}

/**
 * True only when each name that the glob `later` matches, the glob `earlier` matches too. A false can still be such a
 * pair: the test is conservative. Each `*` of `later` becomes a character that `earlier` does not hold. If `earlier`
 * matches that text, each such character falls in a `*` of `earlier`, and that `*` matches any text in its place.
 */
export const hiddenBy = (earlier: string, later: string): boolean => {
  let code = 0xe000
  while (earlier.includes(String.fromCharCode(code))) code++
  return matches(earlier, later.replaceAll('*', String.fromCharCode(code)))
}

/** The server that each name of the glob names, when the text before its first `*` holds `mcp__<server>__`. */
const pinnedServer = (match: string): string | undefined => {
  const prefix = match.split('*')[0]!
  const at = prefix.startsWith('mcp__') ? prefix.indexOf('__', 'mcp__'.length) : -1
  return at > 'mcp__'.length ? prefix.slice('mcp__'.length, at) : undefined
}

/**
 * True when `earlier` decides each tool that `later` matches, so `later` never decides one. An allow rule decides a
 * tool of a bridge only when its match starts with `mcp__<bridge>__` (`counts` in policy.ts).
 */
const hides = (earlier: Rule, later: Rule, bridges: Bridges): boolean => {
  if (!hiddenBy(earlier.match, later.match)) return false
  if (earlier.action !== 'allow') return true
  const server = pinnedServer(later.match)
  return [...bridges].every(b => earlier.match.startsWith(`mcp__${b}__`) || (server !== undefined && server !== b))
}

/** The bridges whose tools an allow rule can match but never allows, because its match does not name the bridge. */
const skippedBridges = (rule: Rule, bridges: Bridges): string[] => {
  if (rule.action !== 'allow' || !rule.match.includes('*')) return []
  const prefix = rule.match.split('*')[0]!
  return [...bridges].filter(b => !rule.match.startsWith(`mcp__${b}__`) && `mcp__${b}__`.startsWith(prefix))
}

/**
 * The findings of the policy: each rule that an earlier rule hides, each allow rule that matches no listed tool (only
 * when every server connected), each allow rule that skips a bridge, and each tool that needs a person at each run.
 */
export const policyFindings = (policy: Policy, guards: Guards, states: readonly ServerState[]): Finding[] => {
  const { bridges } = guards
  const hidden = policy.flatMap((later, j) => {
    const earlier = policy.slice(0, j).find(rule => hides(rule, later, bridges))
    return earlier === undefined
      ? []
      : [
          warn(
            `${ruleText(later)} never decides a tool: the earlier ${ruleText(earlier)} matches each tool that it matches`,
          ),
        ]
  })
  const allConnected = states.every(s => s.status === 'connected')
  const names = catalogOf(states).map(t => t.name)
  const unused = allConnected
    ? policy
        .filter(rule => rule.action === 'allow' && !names.some(name => matches(rule.match, name)))
        .map(rule =>
          warn(
            `${ruleText(rule)} matches no tool of the servers: check the name, or remove the rule if the tool is gone`,
          ),
        )
    : policy.some(rule => rule.action === 'allow')
      ? [info('skipped the check for allow rules that match no tool, because a server did not connect')]
      : []
  const bridged = policy.flatMap(rule =>
    skippedBridges(rule, bridges).map(b =>
      warn(
        `${ruleText(rule)} does not allow the tools of the Claude Code bridge ${b}: only an allow rule that starts with mcp__${b}__ does`,
      ),
    ),
  )
  // A deny rule wins over the mark, as in the tools command.
  const person = [...interactiveTools(states)]
    .filter(name => decide(policy, guards, name).action !== 'deny')
    .map(name =>
      info(
        `${shownName(name)} needs a person at each run: its server marks it, and an allow rule does not replace that`,
      ),
    )
  const found = [...hidden, ...unused, ...bridged, ...person]
  if (found.some(f => f.status === 'warn')) return found
  const summary =
    policy.length === 0
      ? ok('no rules: a program asks the person before it calls a tool')
      : ok(`${policy.length} rules`)
  return [summary, ...found]
}

/** The file name of an OAuth store: the server key, `-`, 16 hex digits of the URL hash and `.json`. */
const STORE_FILE = /^(.+)-[0-9a-f]{16}\.json$/

/** The server keys of the OAuth store files in `files` that are not in `used`, in file order and once each. */
export const staleStoreKeys = (files: readonly string[], used: ReadonlySet<string>): string[] => [
  ...new Set(files.flatMap(f => (used.has(f) ? [] : (STORE_FILE.exec(f)?.slice(1, 2) ?? [])))),
]

/** The first line of the share check: the switch and its source. */
const shareSwitch = ({ on, source }: Config['share']): string => {
  const how = { default: ' (the default)', config: ' ("share": ' + on + ')', env: ` (TOOLSCRIPT_SHARE=${on ? 1 : 0})` }
  return `sharing is ${on ? 'on' : 'off'}${how[source]}`
}

/** The line of one server: the class that it gets when sharing is on, the rule that decided and the way out. */
const shareLine = (key: ServerKey, c: Class): string => {
  const name = shownName(key)
  if (c.class === 'shared')
    return c.rule === 4
      ? `${name}: shared by all sessions: it has a cwd`
      : `${name}: shared by all sessions: "share": true, so it starts in the home folder`
  if (c.class === 'folder')
    return c.rule === 2
      ? `${name}: one copy per folder: "share": "folder"`
      : `${name}: one copy per folder: no cwd and no "share" key. Set "share": true when it reads no file of its folder`
  if (c.rule !== 3)
    return c.rule === 1
      ? `${name}: one copy per session: it is a Claude Code bridge`
      : `${name}: one copy per session: "share": false`
  return `${name}: one copy per session: it keeps state between calls (${c.word}). Set "share": true to share it`
}

/**
 * The lazy check: one line for each lazy server, and one line when the switch is off while a server would be lazy.
 * `cached` gives the number of tools of the cached list of a server, or undefined when none is cached. No path, argument
 * or env text. Starts no server.
 */
export const lazyFindings = (config: Config, cached: (key: ServerKey) => number | undefined): Finding[] => {
  const lazy = [...config.servers].filter(([key, server]) => isLazy(key, server, config.bridges, true))
  if (!config.lazy)
    return lazy.length === 0
      ? []
      : [info('lazy start is off (TOOLSCRIPT_LAZY=0): every server starts with the session')]
  return lazy.map(([key]) => {
    const tools = cached(key)
    const list = tools === undefined ? 'not cached yet (starts once at the next session)' : `cached (${tools} tools)`
    return info(
      `${shownName(key)}: starts on first use and stops after ${LAZY_IDLE_MS / 60_000} min idle, tool list ${list}`,
    )
  })
}

/** The share check, from the config alone: nothing without a stdio server. */
export const shareFindings = (config: Config): Finding[] => {
  const lines = [...config.servers].flatMap(([key, server]) => {
    const c = classify(key, server, config.bridges)
    return c === undefined ? [] : [info(shareLine(key, c))]
  })
  return lines.length === 0 ? [] : [info(shareSwitch(config.share)), ...lines]
}

/** What a person does when something else holds the name of the broker. It names no path but the broker folder. */
export const takenNameWayOut = (platform: string): string =>
  platform === 'win32'
    ? 'Something that is not the broker may hold its pipe name. Close the sessions of toolscript-mcp, then delete the ' +
      'file "key" in the folder "broker" of the folder ".toolscript-mcp" in your home folder: a new key gives a new pipe name'
    : 'Something that is not the broker may hold its socket. Close the sessions of toolscript-mcp, then delete the ' +
      'file "key" in the folder "broker" of the folder ".toolscript-mcp" in your home folder (a new key gives a new socket name). When ' +
      'the socket is in /tmp/tsm- and your user id, remove that folder, or use a shorter home path'

/** The failures of the handshake that a squatter on the name causes: the peer is no broker, or it did not answer. */
const SQUATTER =
  /did not answer as a broker|did not prove the key|did not answer the handshake|more than 4 KB|refused the proof/

/** The `fail` line of the broker check: the reason, and for a peer that is not a broker, the way out. */
export const brokerFail = (reason: string, platform: string): Finding =>
  fail(SQUATTER.test(reason) ? `${reason}. ${takenNameWayOut(platform)}` : reason)

/** The principals that may hold the broker folder on Windows: SYSTEM and Administrators, and the user. */
const ALLOWED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544'])

/** The rights that let a principal change a folder or the files in it. */
const WRITE_RIGHTS =
  /FullControl|Modify|Write|CreateFiles|CreateDirectories|AppendData|Delete|ChangePermissions|TakeOwnership/

/**
 * The finding of the access rules of a Workspace root on Windows, from the text of `readAcl`. A principal other than the
 * user, SYSTEM and Administrators with an Allow rule that can write lets a process of that account swap a folder for a
 * link while a tool reads (the ADR names this case). The text holds no path.
 */
export const workspaceAclFinding = (text: string): Finding => {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  const user = lines[0]
  const rules = lines.slice(1).map(line => line.split('|'))
  if (
    user === undefined ||
    !/^S-1-/.test(user) ||
    rules.length === 0 ||
    rules.some(r => r.length < 3 || !/^S-1-/.test(r[0]!))
  )
    return info('the access rules of the root could not be read')
  const extra = new Set(
    rules
      .filter(
        ([sid, type, rights]) =>
          type === 'Allow' && sid !== user && !ALLOWED_SIDS.has(sid!) && WRITE_RIGHTS.test(rights!),
      )
      .map(([sid]) => sid!),
  )
  if (extra.size === 0) return ok('only you, SYSTEM and Administrators can write in the root')
  return warn(
    `${extra.size} other principal(s) can write in the root, so a process of theirs could swap a folder for a link while a tool reads. ` +
      'Look at the rules with `icacls` on the root. Give Workspace a root that only your account can write',
  )
}

/**
 * The finding of the access rules of the broker folder on Windows. `text` holds the SID of the user on the first line and
 * then one `SID|Allow or Deny|rights` line for each rule. A principal other than the user, SYSTEM and Administrators with
 * an Allow rule gives `warn`; a text that is not that gives `info`.
 */
export const aclFinding = (text: string): Finding => {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  const user = lines[0]
  const rules = lines.slice(1).map(line => line.split('|'))
  if (
    user === undefined ||
    !/^S-1-/.test(user) ||
    rules.length === 0 ||
    rules.some(r => r.length < 3 || !/^S-1-/.test(r[0]!))
  )
    return info('the access rules of the broker folder could not be read')
  const extra = new Set(
    rules.filter(([sid, type]) => type === 'Allow' && sid !== user && !ALLOWED_SIDS.has(sid!)).map(([sid]) => sid!),
  )
  if (extra.size === 0) return ok('the broker folder is open to you, SYSTEM and Administrators only')
  return warn(
    `${extra.size} other principal(s) can enter the broker folder, so they can read its key. Look at the rules with ` +
      '`icacls` on the folder "broker" of the folder ".toolscript-mcp" in your home folder. Your profile folder normally allows only you, ' +
      'SYSTEM and Administrators: remove the extra rule, or move your home folder to one that does',
  )
}
