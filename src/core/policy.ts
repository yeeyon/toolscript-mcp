// The policy of the config: ordered rules over full tool names
// (mcp__<server>__<tool>). The first rule that matches decides. A tool that no
// rule matches needs the person's approval, as an `ask` rule does.
// parseConfig reads the rules; this file decides with them.

import type { LiteralCall } from './protocol.ts'

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

export const decide = (policy: Policy, tool: string): Verdict => {
  const rule = policy.find(r => matches(r.match, tool))
  return rule === undefined ? { action: 'ask' } : { action: rule.action, rule }
}

/**
 * A string from the config file as JSON, with every control, format and line
 * separator character escaped too: the text never breaks a line or turns
 * around the text after it in a prompt.
 */
const quoted = (s: string): string =>
  JSON.stringify(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, c => {
    const hex = c.codePointAt(0)!.toString(16)
    return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`
  })

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
 * The loop reads `current` from its last rule back. `fits[j]`: the rules of
 * `next` from j on come by the steps from the rules of `current` read so far.
 * The same match can repeat, so a rule of `next` does not simply pair with
 * the first rule that has its match.
 */
export const onlyTightens = (current: Policy, next: Policy): boolean => {
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
        (now.match === was.match && LOOSENESS[now.action] <= LOOSENESS[was.action] && fits[j + 1]!)
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

const ruleList = (rules: readonly Rule[]): string => {
  const shown = rules
    .slice(0, SHOWN_RULES)
    .map(r => shownRule(r))
    .join(', ')
  return rules.length <= SHOWN_RULES ? shown : `${shown} and ${rules.length - SHOWN_RULES} more`
}

/** Allow rules first, then ask, then deny, so a cut list never hides a looser rule behind a deny. */
const loosestFirst = (rules: readonly Rule[]): Rule[] =>
  rules.toSorted((a, b) => LOOSENESS[b.action] - LOOSENESS[a.action])

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
 * The rules added and removed, and whether the others changed order, for the
 * log, the note of a run and the prompt, on one line. Empty when the rules are the same.
 */
export const policyChange = (current: Policy, next: Policy): string => {
  if (samePolicy(current, next)) return ''
  const added = minus(next, current)
  const removed = minus(current, next)
  if (added.length + removed.length === 0) return `the order of the rules changed to ${ruleList(next)}`
  return [
    ...(added.length > 0 ? [`added ${ruleList(loosestFirst(added))}`] : []),
    ...(removed.length > 0 ? [`removed ${ruleList(loosestFirst(removed))}`] : []),
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

/** The note after a run that kept the policy in force, because the person did not approve a looser one. */
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
 * The decision before a run, from the tool names that the program writes as
 * string literals: refused when a deny rule matches one of them, else the
 * names that need the person's approval (none: the run starts at once).
 */
export type Plan =
  | { readonly kind: 'refused'; readonly denied: readonly { readonly call: LiteralCall; readonly rule: Rule }[] }
  | { readonly kind: 'run'; readonly ask: readonly string[] }

export const planRun = (policy: Policy, calls: readonly LiteralCall[]): Plan => {
  const denied = calls.flatMap(call => {
    const { action, rule } = decide(policy, call.tool)
    return action === 'deny' && rule !== undefined ? [{ call, rule }] : []
  })
  if (denied.length > 0) return { kind: 'refused', denied }
  const ask = [...new Set(calls.map(c => c.tool).filter(tool => decide(policy, tool).action === 'ask'))]
  return { kind: 'run', ask }
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
 * program builds at run time was never asked, so only an allow rule lets it run.
 */
export type CallCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly needsRule: boolean }

export const checkCall = (policy: Policy, approved: ReadonlySet<string>, tool: string): CallCheck => {
  const { action, rule } = decide(policy, tool)
  if (action === 'allow' || (action === 'ask' && approved.has(tool))) return { ok: true }
  if (action === 'deny' && rule !== undefined)
    return { ok: false, error: `denied by ${ruleText(rule)}`, needsRule: false }
  return {
    ok: false,
    error: `not approved: no policy rule allows ${tool}, and the person did not approve it for this run`,
    needsRule: true,
  }
}

/** Why the tools that need approval did not get it. */
export type Refusal = 'decline' | 'unsupported'

/** The message of the approval prompt: the tools, and the program they run in. */
export const askText = (tools: readonly string[], code: string): string => {
  const program = code.length <= 4000 ? code : `${code.slice(0, 4000)}\n… [${code.length - 4000} more characters]`
  return [
    `A toolscript program wants to call ${tools.length === 1 ? 'this tool' : 'these tools'}, which no policy rule allows:`,
    ...tools.map(t => `- ${t}`),
    '',
    'Approve for this run only?',
    '',
    'The program:',
    program,
  ].join('\n')
}

/** The note after a run whose fresh read of the policy failed, so the run used the last good policy. */
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
export const refusedReport = (tools: readonly string[], why: Refusal): string => {
  const head =
    why === 'decline'
      ? 'Error: the program did not run, because the person did not approve the tools that need approval. No call was made.'
      : 'Error: the program did not run, because some tools need approval and this MCP client cannot ask the person. No call was made.'
  return `${head}\n\n${approvalNote(tools, false)}`
}

/**
 * The note after calls that the policy did not allow and nobody approved.
 * Only the person can add the allow rule. With a client that can ask, a tool
 * name written as a string in call() gets asked before the next run.
 */
export const approvalNote = (tools: readonly string[], canAsk: boolean): string => {
  if (tools.length === 0) return ''
  const one = tools.length === 1
  const ask = canAsk
    ? ` A tool name written as a string in call("…") is asked before the run; a name built while the program runs is not.`
    : ''
  return `## No allow rule\n\nNo policy rule allows ${tools.join(', ')}.${ask} If the person wants programs to call ${one ? 'this tool' : 'these tools'} with no prompt, ask them to add ${tools.map(allowRule).join(', ')} to "policy" in the toolscript-mcp config. Do not change the config yourself.`
}
