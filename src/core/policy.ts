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

/** A rule as the config writes it: `{"match": "mcp__x__*", "action": "deny"}`. */
const ruleJson = (match: string, action: Action): string => `{"match": ${JSON.stringify(match)}, "action": "${action}"}`

/** A rule as the config writes it, with its place: `policy[2] {"match": "mcp__x__*", "action": "deny"}`. */
export const ruleText = (rule: Rule): string => `policy[${rule.index}] ${ruleJson(rule.match, rule.action)}`

const allowRule = (tool: string): string => ruleJson(tool, 'allow')

/** Each step up this order lets a tool run with less from the person. */
const LOOSENESS: Record<Action, number> = { deny: 0, ask: 1, allow: 2 }

/**
 * What `next` lets run that `current` does not: the names whose decision goes
 * up (deny to ask, deny or ask to allow). Each rule of either policy adds its
 * match with no `*`, a name that the rule matches, so a rule over tools of no
 * connected server counts too. Such a name shows as the match.
 */
export const loosened = (current: Policy, next: Policy, names: Iterable<string>): string[] => {
  const shown = new Map<string, string>()
  for (const name of names) shown.set(name, name)
  for (const rule of [...current, ...next]) {
    const name = rule.match.replaceAll('*', '')
    if (!shown.has(name)) shown.set(name, rule.match)
  }
  const looser = [...shown].filter(
    ([name]) => LOOSENESS[decide(next, name).action] > LOOSENESS[decide(current, name).action],
  )
  return [...new Set(looser.map(([, label]) => label))].sort()
}

/** The rules of `a` that `b` does not have, one for one. */
const minus = (a: readonly string[], b: readonly string[]): string[] => {
  const left = [...b]
  return a.filter(rule => {
    const at = left.indexOf(rule)
    if (at >= 0) left.splice(at, 1)
    return at < 0
  })
}

/** The rules added and removed, for the log and the note of a run. Empty when the rules are the same. */
export const policyChange = (current: Policy, next: Policy): string => {
  const before = current.map(r => ruleJson(r.match, r.action))
  const after = next.map(r => ruleJson(r.match, r.action))
  if (before.join('\n') === after.join('\n')) return ''
  const added = minus(after, before)
  const removed = minus(before, after)
  const parts = [
    ...(added.length > 0 ? [`added ${added.join(', ')}`] : []),
    ...(removed.length > 0 ? [`removed ${removed.join(', ')}`] : []),
  ]
  return parts.length > 0 ? parts.join('; ') : 'the order of the rules changed'
}

const SHOWN_NAMES = 20

const nameList = (names: readonly string[]): string =>
  names.length <= SHOWN_NAMES
    ? names.join(', ')
    : `${names.slice(0, SHOWN_NAMES).join(', ')} and ${names.length - SHOWN_NAMES} more`

/** The prompt before a looser policy from the config file applies. */
export const loosenText = (file: string, names: readonly string[]): string =>
  `The toolscript-mcp policy in ${file} changed to allow: ${nameList(names)}. Apply the new policy?`

/** The note after a run that kept the policy in force, because the person did not approve a looser one. */
export const keptPolicyNote = (file: string, names: readonly string[], why: Refusal): string => {
  const kept =
    why === 'decline'
      ? 'The person did not approve it, so this run used the policy in force.'
      : 'A looser policy applies only after a restart, so this run used the policy in force. If the person made this change, ask them to restart toolscript-mcp.'
  return `## Policy not reloaded\n\nThe toolscript-mcp policy in ${file} now allows ${nameList(names)}. ${kept} Do not change the config yourself.`
}

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
