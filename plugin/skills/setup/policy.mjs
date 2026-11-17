// The policy that the policy and prepend commands of config.mjs write. No file or process access, so the tests
// import it. The Claude Code bridge serves the tools of Claude Code, such as Bash and Write, and a program that calls
// them skips the permission rules and hooks of Claude Code. So no command gives a tool of the bridge a looser decision
// than the old policy gives it, unless a new rule that starts with mcp__claude-code__ decides the tool.

export const BRIDGE = 'mcp__claude-code__'

// The tools in the tools reference of Claude Code (code.claude.com/docs/en/tools-reference), 2026-11. The guard keeps
// the decision of each of them with a rule for its name. One rule keeps the decision of the other tools.
export const BRIDGE_TOOLS = [
  'Agent',
  'Artifact',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'LSP',
  'ListAgents',
  'ListMcpResourcesTool',
  'Monitor',
  'NotebookEdit',
  'PowerShell',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'SendMessage',
  'SendUserFile',
  'ShareOnboardingGuide',
  'Skill',
  'SubagentHandback',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WaitForMcpServers',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
]

export const ACTIONS = ['allow', 'deny', 'ask']
// The match rule of parsePolicy in src/core/config.ts. A policy error stops the server at its start.
export const MATCH = /^(mcp__|\*)/
// LOOSENESS in src/core/policy.ts: each step up lets a tool run with less from the person.
const LOOSENESS = { deny: 0, ask: 1, allow: 2 }

// A rule that parsePolicy in src/core/config.ts takes. With any other entry, the server does not use the file.
const isRule = rule => typeof rule?.match === 'string' && MATCH.test(rule.match) && ACTIONS.includes(rule.action)

// matches in src/core/policy.ts: true when the glob matches the whole name, and * matches any characters.
export function matches(glob, tool) {
  const parts = glob.split('*')
  if (parts.length === 1) return glob === tool
  const first = parts[0]
  const last = parts.at(-1)
  if (tool.length < first.length + last.length || !tool.startsWith(first) || !tool.endsWith(last)) return false
  const end = tool.length - last.length
  let at = first.length
  for (const part of parts.slice(1, -1)) {
    const found = tool.indexOf(part, at)
    if (found < 0 || found + part.length > end) return false
    at = found + part.length
  }
  return true
}

// decide in src/core/policy.ts, over the rules that parsePolicy takes: the first rule that matches decides, and a tool
// that no rule matches is ask.
export function decide(policy, tool) {
  const rule = policy.find(r => isRule(r) && matches(r.match, tool))
  return rule === undefined ? { action: 'ask' } : { action: rule.action, rule }
}

/**
 * A tool name under BRIDGE that ends in a character of no match in `rules`. Only a rule that matches every name
 * under BRIDGE matches it, such as mcp__claude-code__* or *: each word of such a match is in BRIDGE, and the match
 * ends in *. So the name stands for each tool of the bridge that no other rule matches, such as a tool that a later
 * Claude Code adds.
 */
function otherTool(rules) {
  const used = new Set(rules.filter(isRule).flatMap(rule => rule.match.split('')))
  let code = 1
  while (used.has(String.fromCharCode(code))) code++
  return BRIDGE + String.fromCharCode(code)
}

/**
 * The policy `next`, with the rules that keep each tool of the bridge at least as strict as `old` keeps it. A tool can
 * get a looser decision only when `opens(rule, oldRule)` accepts the rule that decides it in `next`. `oldRule` is the
 * rule that decided it in `old`, or undefined when no rule did. The rules of `next` keep their order. It adds:
 * - one rule for all tools of the bridge, when the other tool (otherTool) would get looser. It goes just before the
 *   rule that loosens the other tool, so each rule before it stays in force, also a rule that opens a tool.
 * - at the top, a rule for each tool in BRIDGE_TOOLS that would get looser, or whose decision the rule for all tools
 *   changes.
 * `added` lists the added rules in their order in `policy`.
 */
function guardBridge(old, next, opens) {
  const verdict = name => {
    const was = decide(old, name)
    const now = decide(next, name)
    const looser = LOOSENESS[now.action] > LOOSENESS[was.action] && !opens(now.rule, was.rule)
    return { name, looser, want: looser ? was.action : now.action, at: now.rule ? next.indexOf(now.rule) : next.length }
  }
  const other = verdict(otherTool([...old, ...next]))
  const all = other.looser ? [{ match: `${BRIDGE}*`, action: other.want }] : []
  const guarded = next.toSpliced(other.at, 0, ...all)
  const pins = BRIDGE_TOOLS.map(tool => verdict(BRIDGE + tool))
    .filter(v => decide(guarded, v.name).action !== v.want)
    .map(v => ({ match: v.name, action: v.want }))
  return { policy: [...pins, ...guarded], added: [...pins, ...all] }
}

const opensBridge = rules => rules.filter(rule => rule.match.startsWith(BRIDGE))

/** The policy command: the new rules in order. Only a new rule that starts with BRIDGE loosens a tool of the bridge. */
export function setPolicy(old, rules) {
  const opening = new Set(opensBridge(rules))
  return guardBridge(old, rules, rule => opening.has(rule))
}

/**
 * The prepend command: the new rules first, then the old rules without the matches of the new rules. A new rule that
 * starts with BRIDGE loosens only a tool that no old rule decides, so a choice of the person stays. An old rule with
 * the match of an added rule goes too: the added rule comes first and matches the same tools, so a second run changes
 * nothing.
 */
export function prependPolicy(old, rules) {
  const named = new Set(rules.map(rule => rule.match))
  const rest = old.filter(rule => !named.has(rule?.match))
  const opening = new Set(opensBridge(rules))
  const { policy, added } = guardBridge(old, [...rules, ...rest], (rule, was) => was === undefined && opening.has(rule))
  const shadowed = new Set(added.map(rule => rule.match))
  return { policy: policy.filter(rule => !(rest.includes(rule) && shadowed.has(rule?.match))), added }
}
