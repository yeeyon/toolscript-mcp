// The policy of the config: ordered rules over full tool names
// (mcp__<server>__<tool>). The first rule that matches decides. A tool that no
// rule matches needs the person's approval, as an `ask` rule does. An allow
// rule decides a tool of a bridge only when its match names that server.
// parseConfig reads the rules; this file decides with them.

import type { ServerKey } from './config.ts'
import { splitToolName, type LiteralCall } from './protocol.ts'

export type Action = 'allow' | 'deny' | 'ask'

export const ACTIONS: readonly Action[] = ['allow', 'deny', 'ask']

/** One rule of the config. `index` is its place in `policy`, from 0, so a message can name it. */
export type Rule = { readonly match: string; readonly action: Action; readonly index: number }

export type Policy = readonly Rule[]

/** What the policy says of one tool, and the rule that says it. No rule: the default, ask. */
export type Verdict = { readonly action: Action; readonly rule?: Rule }

/**
 * True when the glob matches the whole name. `*` matches any characters,
 * `__` and line breaks too. No regular expression: the program picks the
 * name, and a long one must not stall the server.
 */
export const matches = (glob: string, tool: string): boolean => {
  const parts = glob.split('*')
  if (parts.length === 1) return glob === tool
  const first = parts[0]!
  const last = parts.at(-1)!
  if (tool.length < first.length + last.length || !tool.startsWith(first) || !tool.endsWith(last)) return false
  // Each middle part at its first place after the one before: the leftmost
  // place leaves the most room for the rest, so it never misses a match.
  const end = tool.length - last.length
  let at = first.length
  for (const part of parts.slice(1, -1)) {
    const found = tool.indexOf(part, at)
    if (found < 0 || found + part.length > end) return false
    at = found + part.length
  }
  return true
}

/**
 * The keys of the servers that serve the client's own tools, such as Claude
 * Code with `claude mcp serve`: `bridges` in config.ts. A program that calls
 * such a tool skips the client's permission rules and hooks.
 */
export type Bridges = ReadonlySet<ServerKey>

/** The bridge that serves `tool`, or undefined for a tool of any other server. */
const bridgeOf = (tool: string, bridges: Bridges): string | undefined => {
  const server = splitToolName(tool)?.server
  return server !== undefined && (bridges as ReadonlySet<string>).has(server) ? server : undefined
}

/**
 * False for an allow rule over a tool of `bridge` whose match does not start
 * with `mcp__<bridge>__`. So `*` or `mcp__*__Bash` never allows a tool of a
 * bridge, also one that the bridge adds later: only a rule that names the
 * server does. The next rule that matches decides. Deny and ask rules count.
 */
const counts = (rule: Rule, bridge: string | undefined): boolean =>
  rule.action !== 'allow' || bridge === undefined || rule.match.startsWith(`mcp__${bridge}__`)

export const decide = (policy: Policy, bridges: Bridges, tool: string): Verdict => {
  const bridge = bridgeOf(tool, bridges)
  const rule = policy.find(r => matches(r.match, tool) && counts(r, bridge))
  return rule === undefined ? { action: 'ask' } : { action: rule.action, rule }
}

const escape = (c: string): string => {
  const hex = c.codePointAt(0)!.toString(16)
  return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`
}

/**
 * `s` with every character outside printable ASCII as a `\u` escape: printed, the text never breaks a line, moves
 * the cursor, turns around the text after it, or hides a blank or look-alike character.
 */
export const printable = (s: string): string => s.replace(/[^\x20-\x7e]/gu, escape)

/**
 * `s` with each control, format (such as a bidi control), line or paragraph separator and lone surrogate as a `\u`
 * escape, so printed, the text never breaks a line, moves the cursor or turns around the text after it. For free text
 * such as an error: it keeps the letters of each script, such as a user folder name. Show a name with `printable`,
 * which also shows a look-alike.
 */
export const printableText = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, escape)

/** A string from the config file as JSON, printable. */
const quoted = (s: string): string => printable(JSON.stringify(s))

/**
 * A name from a file or a server as one word of printed text: bare when it is printable ASCII without a blank or a
 * double quote, else quoted. So a name never fakes a column, or the quoted form of another name.
 */
export const shownName = (s: string): string => (/^[\x21\x23-\x7e]+$/.test(s) ? s : quoted(s))

const SHOWN_MATCH = 120

/** A rule of the config file as the config writes it: `{"match": "mcp__x__*", "action": "deny"}`. A long match is cut, unless `whole`. */
const shownRule = ({ match, action }: Rule, whole = false): string => {
  const shown =
    whole || match.length <= SHOWN_MATCH
      ? quoted(match)
      : `${quoted(match.slice(0, SHOWN_MATCH))}… (${match.length - SHOWN_MATCH} more characters)`
  return `{"match": ${shown}, "action": "${action}"}`
}

/** A rule as the config writes it, with its place: `policy[2] {"match": "mcp__x__*", "action": "deny"}`. */
export const ruleText = (rule: Rule): string => `policy[${rule.index}] ${shownRule(rule)}`

const allowRule = (tool: string): string => `{"match": ${JSON.stringify(tool)}, "action": "allow"}`

/** Each step up this order lets a tool run with less from the person. */
const LOOSENESS: Record<Action, number> = { deny: 0, ask: 1, allow: 2 }

/** Above this many pairs of rules the comparison could stall the server, so the change counts as looser. */
const MAX_PAIRS = 10_000_000

/**
 * True when `next` comes from `current` by these steps alone: insert a deny
 * rule anywhere, remove an allow rule, lower the action of a rule in place.
 * No step raises the decision of any name, so `next` lets no tool run with
 * less approval. It reads the rules alone, never a tool name.
 *
 * An allow rule that a tool of a bridge skips (`counts`) can stand before a
 * deny of that tool. Lowered to ask, it would then decide that tool. So that
 * step counts only for an allow rule that no tool skips.
 *
 * The loop reads `current` from its last rule back. `fits[j]`: the rules of
 * `next` from j on come by the steps from the rules of `current` read so far.
 * The same match can repeat, so a rule of `next` does not simply pair with
 * the first rule that has its match.
 */
export const onlyTightens = (current: Policy, next: Policy, bridges: Bridges): boolean => {
  // A match whose server part has no `*` matches only the tools of that server, so no tool skips it.
  const skippable = (rule: Rule) =>
    rule.action === 'allow' && bridges.size > 0 && (splitToolName(rule.match)?.server.includes('*') ?? true)
  const lowers = (now: Rule, was: Rule) =>
    LOOSENESS[now.action] <= LOOSENESS[was.action] && !(now.action === 'ask' && skippable(was))
  if ((current.length + 1) * (next.length + 1) > MAX_PAIRS) return false
  let fits = next.map(r => r.action === 'deny').concat(true)
  for (let j = next.length - 1; j >= 0; j--) fits[j] = fits[j]! && fits[j + 1]!
  for (const was of current.toReversed()) {
    const row = fits.map((rest, j) => was.action === 'allow' && rest)
    for (let j = next.length - 1; j >= 0; j--) {
      const now = next[j]!
      row[j] =
        row[j]! ||
        (now.action === 'deny' && row[j + 1]!) ||
        (now.match === was.match && lowers(now, was) && fits[j + 1]!)
    }
    fits = row
  }
  return fits[0]!
}

const ruleKey = (r: Rule): string => JSON.stringify([r.match, r.action])

/** True when both have the same rules in the same order. */
export const samePolicy = (a: Policy, b: Policy): boolean =>
  a.length === b.length && a.every((r, i) => ruleKey(r) === ruleKey(b[i]!))

/** The rules of `a` that `b` does not have, one for one. */
const minus = (a: Policy, b: Policy): Rule[] => {
  const left = new Map<string, number>()
  for (const key of b.map(ruleKey)) left.set(key, (left.get(key) ?? 0) + 1)
  return a.filter(rule => {
    const key = ruleKey(rule)
    const count = left.get(key) ?? 0
    left.set(key, count - 1)
    return count <= 0
  })
}

const SHOWN_RULES = 10

/**
 * Where policyChange shows the change: the log, the prompt to the person, or
 * a note to the model. A note names a rule only by its place and action: a
 * program can write the config through a tool, and the note follows the
 * wrapper of an untrusted run.
 */
export type ChangeFor = 'log' | 'prompt' | 'note'

const ruleName = (r: Rule): string => `policy[${r.index}] (${r.action})`

/** The rules on one line. Except in the prompt, at most SHOWN_RULES of them, each match cut. */
const ruleList = (rules: readonly Rule[], form: ChangeFor): string => {
  if (form === 'prompt') return rules.map(r => shownRule(r, true)).join(', ')
  const shown = rules
    .slice(0, SHOWN_RULES)
    .map(r => (form === 'note' ? ruleName(r) : shownRule(r)))
    .join(', ')
  return rules.length <= SHOWN_RULES ? shown : `${shown} and ${rules.length - SHOWN_RULES} more`
}

/** Allow rules first, then ask, then deny, each in file order. */
const loosestFirst = (rules: readonly Rule[]): Rule[] =>
  rules.toSorted((a, b) => LOOSENESS[b.action] - LOOSENESS[a.action])

/** Deny rules first, then ask, then allow, each in file order. */
const tightestFirst = (rules: readonly Rule[]): Rule[] =>
  rules.toSorted((a, b) => LOOSENESS[a.action] - LOOSENESS[b.action])

/**
 * True when the `common` rules that both policies have come in the same order
 * in both: their longest common run of rules holds all of them. Above
 * MAX_PAIRS it says true, and the prompt still lists the whole policy.
 */
const keepsOrder = (current: Policy, next: Policy, common: number): boolean => {
  if ((current.length + 1) * (next.length + 1) > MAX_PAIRS) return true
  const keys = next.map(ruleKey)
  let row = new Array<number>(keys.length + 1).fill(0)
  for (const key of current.map(ruleKey)) {
    const below = [0]
    keys.forEach((k, j) => below.push(k === key ? row[j]! + 1 : Math.max(row[j + 1]!, below[j]!)))
    row = below
  }
  return row[keys.length] === common
}

/**
 * The rules added and removed, and whether the others changed order, on one
 * line. Empty when the rules are the same. The lists put first the rules whose
 * change loosens: an added allow, a removed deny. Only the prompt lists every
 * rule uncut. A removed rule has its place in `current`.
 */
export const policyChange = (current: Policy, next: Policy, form: ChangeFor = 'log'): string => {
  if (samePolicy(current, next)) return ''
  const list = (rules: readonly Rule[]) => ruleList(rules, form)
  const added = minus(next, current)
  const removed = minus(current, next)
  if (added.length + removed.length === 0)
    return form === 'note' ? 'the order of the rules changed' : `the order of the rules changed to ${list(next)}`
  return [
    ...(added.length > 0 ? [`added ${list(loosestFirst(added))}`] : []),
    ...(removed.length > 0 ? [`removed ${list(tightestFirst(removed))}`] : []),
    ...(keepsOrder(current, next, current.length - removed.length) ? [] : ['the order of the other rules changed']),
  ].join('; ')
}

const looser = (file: string, change: string): string =>
  `The toolscript-mcp policy in ${file} changed, and the change can let a tool run with less approval: ${change}.`

/**
 * The prompt before a looser policy from the config file applies. `change`
 * comes from policyChange. It lists every rule of `next` in order and uncut,
 * so no rule that the person approves hides behind a cut.
 */
export const loosenText = (file: string, change: string, next: Policy): string =>
  [
    looser(file, change),
    '',
    'The new policy. The first rule that matches a tool decides:',
    ...(next.length === 0
      ? ['No rules: each call needs the approval of the person.']
      : next.map(r => `policy[${r.index}] ${shownRule(r, true)}`)),
    '',
    'If you decline, this run uses the policy in force. The file still holds the new policy, and it applies at the next start of toolscript-mcp.',
    '',
    'Apply the new policy?',
  ].join('\n')

/** The note after a run that kept the policy in force, because the person did not approve a looser one. `change`: policyChange for a note. */
export const keptPolicyNote = (file: string, change: string, why: Refusal): string => {
  const kept =
    why === 'decline'
      ? 'The person did not approve it, so this run used the policy in force.'
      : 'A looser policy applies only after a restart, so this run used the policy in force. If the person made this change, ask them to restart toolscript-mcp.'
  return `## Policy not reloaded\n\n${looser(file, change)} ${kept} Do not change the config yourself.`
}

/** The note after a run while the config file still holds the policy that the person declined. */
export const declinedNote = (file: string): string =>
  `## Policy not reloaded\n\nThe person declined the policy in ${file}, so this run used the policy in force. Do not change the config yourself.`

/**
 * The tools to ask the person about before a run. `ask`: no rule allows them.
 * `interactive`: their server requires a person each time, so no rule can
 * allow them. A tool is in one list at most.
 */
export type Asks = { readonly ask: readonly string[]; readonly interactive: readonly string[] }

/**
 * The decision before a run, from the tool names that the program writes as
 * string literals: refused when a deny rule matches one of them, else the
 * names that need the person's approval (none: the run starts at once).
 * `interactive` holds the tools whose server requires a person on every call.
 */
export type Plan =
  | { readonly kind: 'refused'; readonly denied: readonly { readonly call: LiteralCall; readonly rule: Rule }[] }
  | ({ readonly kind: 'run' } & Asks)

export const planRun = (
  policy: Policy,
  bridges: Bridges,
  calls: readonly LiteralCall[],
  interactive: ReadonlySet<string>,
): Plan => {
  const denied = calls.flatMap(call => {
    const { action, rule } = decide(policy, bridges, call.tool)
    return action === 'deny' && rule !== undefined ? [{ call, rule }] : []
  })
  if (denied.length > 0) return { kind: 'refused', denied }
  const tools = [...new Set(calls.map(c => c.tool))]
  return {
    kind: 'run',
    ask: tools.filter(tool => !interactive.has(tool) && decide(policy, bridges, tool).action === 'ask'),
    interactive: tools.filter(tool => interactive.has(tool)),
  }
}

/** The result of a program that did not run because a deny rule matches a tool it calls. */
export const deniedReport = (denied: Extract<Plan, { kind: 'refused' }>['denied']): string =>
  [
    'Error: the program did not run, because the toolscript-mcp policy denies a tool that it calls. No call was made.',
    ...denied.map(d => `- line ${d.call.line}: ${d.call.tool} is denied by ${ruleText(d.rule)}`),
  ].join('\n')

/**
 * The check of one nested call while the program runs, against the same
 * policy and the tools the person approved for this run. A name that the
 * program builds at run time was never asked, so only an allow rule lets it
 * run, and never for a tool in `interactive`. `needs` says what a refused
 * call lacks: an allow rule, or the person, whom only the prompt before a run
 * can ask. A denied call lacks neither.
 */
export type CallCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly needs?: 'rule' | 'person' }

export const checkCall = (
  policy: Policy,
  bridges: Bridges,
  approved: ReadonlySet<string>,
  tool: string,
  interactive: ReadonlySet<string>,
): CallCheck => {
  const { action, rule } = decide(policy, bridges, tool)
  if (action === 'deny' && rule !== undefined) return { ok: false, error: `denied by ${ruleText(rule)}` }
  if (approved.has(tool) || (action === 'allow' && !interactive.has(tool))) return { ok: true }
  if (interactive.has(tool))
    return {
      ok: false,
      error: `not approved: ${tool} needs the person's approval at each run, and an allow rule does not replace it`,
      needs: 'person',
    }
  const bridge = bridgeOf(tool, bridges)
  const missing =
    bridge === undefined ? `no policy rule allows ${tool}` : `an ${bridgeRule(bridge)}, such as ${allowRule(tool)}`
  return { ok: false, error: `not approved: ${missing}, and the person did not approve it for this run`, needs: 'rule' }
}

// Why `*` or `mcp__*__Bash` does not allow a tool of the bridge `bridge`.
const bridgeRule = (bridge: string): string =>
  `allow rule for a tool of the Claude Code bridge ${bridge} must start with mcp__${bridge}__`

/** Why the tools that need approval did not get it. */
export type Refusal = 'decline' | 'unsupported'

const these = (tools: readonly unknown[]): string => (tools.length === 1 ? 'this tool' : 'these tools')

/** The message of the approval prompt: the tools, and the program they run in. */
export const askText = ({ ask, interactive }: Asks, code: string, bridges: Bridges): string => {
  const program = code.length <= 4000 ? code : `${code.slice(0, 4000)}\n… [${code.length - 4000} more characters]`
  const one = interactive.length === 1
  const bridged = [...new Set(ask.flatMap(t => bridgeOf(t, bridges) ?? []))]
  return [
    ...(ask.length > 0
      ? [
          `A toolscript program wants to call ${these(ask)}, which no policy rule allows:`,
          ...ask.map(t => `- ${t}`),
          ...bridged.map(b => `An ${bridgeRule(b)}.`),
          '',
        ]
      : []),
    ...(interactive.length > 0
      ? [
          `${ask.length > 0 ? 'It also wants to call' : 'A toolscript program wants to call'} ${these(interactive)}. ${one ? 'Its server requires' : 'Their servers require'} your approval each time, so a policy rule cannot allow ${one ? 'it' : 'them'}:`,
          ...interactive.map(t => `- ${t}`),
          '',
        ]
      : []),
    `Approve for this run only? The approval covers each call of ${these([...ask, ...interactive])} in the program.`,
    '',
    'The program:',
    program,
  ].join('\n')
}

/** The note after a run whose fresh read of the policy failed, so the run used the last good policy. The errors hold no text of the file. */
export const stalePolicyNote = (errors: readonly string[]): string =>
  [
    '## Policy not reloaded',
    '',
    'The toolscript-mcp config has errors, so this run used the last policy that toolscript-mcp could read:',
    ...errors.map(e => `- ${e}`),
    '',
    'Ask the person to fix the config. Do not change the config yourself.',
  ].join('\n')

/** The result of a program that did not run because the person was not asked or said no. */
export const refusedReport = ({ ask, interactive }: Asks, why: Refusal): string => {
  const head =
    why === 'decline'
      ? 'Error: the program did not run, because the person did not approve the tools that need approval. No call was made.'
      : 'Error: the program did not run, because some tools need approval and this MCP client cannot ask the person. No call was made.'
  const canAsk = why === 'decline'
  return [head, approvalNote(ask, canAsk), interactiveNote(interactive, canAsk ? 'declined' : 'cannot-ask')]
    .filter(t => t !== '')
    .join('\n\n')
}

/**
 * Why calls of tools whose server requires a person were refused: the client
 * cannot ask, the person declined, or the prompt before the run did not name
 * them. `written` holds the names that the program writes as strings: one of
 * them got its mark during the run. Any other name was built at run time.
 */
export type NoPerson = 'cannot-ask' | 'declined' | { readonly written: ReadonlySet<string> }

/**
 * The note after calls of tools whose server requires a person on every call.
 * No rule can allow them: only the prompt before a run can, and only for a
 * name that the program writes as a string.
 */
export const interactiveNote = (tools: readonly string[], why: NoPerson): string => {
  if (tools.length === 0) return ''
  const one = tools.length === 1
  const how =
    why === 'cannot-ask'
      ? ` This MCP client cannot ask the person, so a program cannot call ${one ? 'it' : 'them'}.`
      : why === 'declined'
        ? ''
        : askNextRun(tools, why.written)
  return `## A person must approve\n\n${tools.join(', ')} ${one ? 'needs' : 'need'} the person's approval at each run, because ${one ? 'its server marks it' : 'their servers mark them'} so. An allow rule does not replace that approval.${how}`
}

// A name built at run time is asked only as a string. A written name got its mark after the prompt: the next run asks.
const askNextRun = (tools: readonly string[], written: ReadonlySet<string>): string => {
  const built = tools.filter(t => !written.has(t))
  const late = tools.filter(t => written.has(t))
  const write =
    built.length === 0
      ? ''
      : ` Write ${built.length === tools.length ? 'the tool name' : built.join(', ')} as a string in call("…"), so the person is asked before the run.`
  const again =
    late.length === 0
      ? ''
      : ` The mark of ${late.join(', ')} came during the run. Run the program again, so the person is asked before the run.`
  return write + again
}

/**
 * The note after calls that the policy did not allow and nobody approved.
 * Only the person can add the allow rule. With a client that can ask, a tool
 * name written as a string in call() gets asked before the next run, and the
 * person approves the new rule in a prompt. Without one, the new rule is a
 * looser policy that waits for a restart.
 */
export const approvalNote = (tools: readonly string[], canAsk: boolean): string => {
  if (tools.length === 0) return ''
  const one = tools.length === 1
  const ask = canAsk
    ? ` A tool name written as a string in call("…") is asked before the run. A name built while the program runs is not.`
    : ''
  const restart = canAsk
    ? ''
    : ' This MCP client cannot ask the person, so the new rule applies only after they restart toolscript-mcp.'
  return `## No allow rule\n\nNo policy rule allows ${tools.join(', ')}.${ask} If the person wants programs to call ${one ? 'this tool' : 'these tools'} with no prompt, ask them to add ${tools.map(allowRule).join(', ')} to "policy" in the toolscript-mcp config.${restart} Do not change the config yourself.`
}
