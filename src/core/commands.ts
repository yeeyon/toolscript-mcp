// The commands that the CLI prints for a person or an agent to run as they are: the init commands that add and
// remove a server, and the tools commands that allow a tool. A name or a path in them comes from a client file, a
// repo or a server, so each one goes in only when an allowlist says that every shell passes it as it is. No quoting
// rule makes a hostile word safe: two rounds of such rules each failed a review. Each command is alone on its line,
// indented by 4 spaces, and starts with node, npx, claude or pushd. Each label line starts with `- `.

import type { ToolLine } from './catalog.ts'
import type { Launch } from './config.ts'
import { decide, matches, printable, ruleText, shownName, type Bridges, type Policy, type Rule } from './policy.ts'

/**
 * The names that a printed command holds. A person can paste a command into any shell: sh, bash, zsh, fish, tcsh,
 * cmd.exe or PowerShell. Each of them passes these characters as they are, so the command needs no quoting rule for a
 * hostile name. Every other name gets no command.
 */
export const PLAIN_NAME = /^[A-Za-z0-9._-]+$/

export const NAME_CHANGES = 'no command: the name holds a character that a shell can change'

/**
 * A plain name as the last words of a printed command, in double quotes: PowerShell splits a bare `-a.b` at the dot.
 * A name that starts with `-` comes after `--`, so the command does not read it as an option. The `--` is in double
 * quotes too: PowerShell drops a bare `--` before a script, such as the npm shim of claude.
 */
export const nameWords = (name: string): string => `${name.startsWith('-') ? '"--" ' : ''}"${name}"`

/**
 * The paths that a printed command holds: a drive letter or none, a `/`, then ASCII letters, digits, spaces and
 * `. _ - ( ) ~ / ' @ +`. Each shell above passes them as they are in double quotes, also through the npm shim of
 * claude. `%` and `!`, which cmd.exe and bash expand in double quotes, and `$`, the backtick, `\` and `"` are out.
 * A Windows path gets forward slashes: Git Bash reads a backslash as an escape, and Node reads both.
 */
const PLAIN_PATH = /^(?:[A-Za-z]:)?\/[\w ().~\/'@+-]*$/

const PATH_CHARACTERS = "letters, digits, spaces, a drive letter and . _ - ( ) ~ / ' @ +"

/** `file` in double quotes for a printed command, or undefined when a shell can change it. */
export const commandPath = (file: string, platform: string): string | undefined => {
  const path = platform === 'win32' ? file.replaceAll('\\', '/') : file
  return PLAIN_PATH.test(path) ? `"${path}"` : undefined
}

/** The lines, indented by `indent`, that say why a command with the path `file` of `what` is not printed. */
export const pathRefusal = (indent: string, what: string, file: string, fix: string): string[] => [
  `${indent}no command: a shell can change the path of ${what}. A path in a command holds only ${PATH_CHARACTERS}.`,
  `${indent}  path: ${printable(file)}`,
  `${indent}To get a command, ${fix}.`,
]

/**
 * The words of a printed toolscript-mcp command: how it starts and the config file. Or, when a shell can change one
 * of these paths, the lines that say which path and how to get the commands.
 */
export type CommandStart =
  | { readonly ok: true; readonly run: string; readonly config: string }
  | { readonly ok: false; readonly lines: readonly string[] }

/** `command`: the CLI command that prints the commands, such as `init`, so the text says what to run again. */
export const commandStart = (configFile: string, platform: string, launch: Launch, command: string): CommandStart => {
  const main = launch.kind === 'node' ? launch.main : undefined
  if (main !== undefined && commandPath(main, platform) === undefined)
    return {
      ok: false,
      lines: pathRefusal('  ', 'toolscript-mcp', main, 'start toolscript-mcp with npx, or from a clone in such a path'),
    }
  const config = commandPath(configFile, platform)
  if (config === undefined)
    return {
      ok: false,
      lines: pathRefusal('  ', 'the config file', configFile, `run ${command} again with --config and such a path`),
    }
  const run = main === undefined ? 'npx -y toolscript-mcp' : `node ${commandPath(main, platform)}`
  return { ok: true, run, config }
}

/** A label line of a block of commands: `- ` first, which no command starts with, so it never reads as a command. */
export const label = (text: string): string => `  - ${text}`

/**
 * The tool names that `toolscript-mcp allow` takes: `mcp__<key>__<tool>` of a server key (`KEY` in config.ts) and a
 * tool name that fits PLAIN_NAME. The key ends at the first `__`, as in `splitToolName`.
 */
const ALLOWABLE = /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__[A-Za-z0-9._-]+$/

/** Why `allow` refuses the tool name `tool` of a config with the server keys `keys`, or undefined. */
export const allowRefusal = (tool: string, keys: ReadonlySet<string>): string | undefined => {
  const key = ALLOWABLE.exec(tool)?.[1]
  if (key === undefined)
    return `${shownName(tool)}: give the exact name of one tool, mcp__<server>__<tool>, with only letters, digits and . _ - in the tool part.`
  return keys.has(key) ? undefined : `${shownName(tool)}: the config has no server ${key}.`
}

/**
 * What `allow` does with one tool, so the tool is allowed after the run or not: `add` an allow rule, so it will be
 * allowed. `keep` the policy, because it is allowed already (`why` names the rule). `refuse`, because the tool is not
 * allowed and `allow` does not make it so: `why` is the reason and `edit` the hand edit of the policy that allows it.
 */
export type AllowStep = { readonly tool: string } & (
  | { readonly kind: 'add' }
  | { readonly kind: 'keep'; readonly why: string }
  | { readonly kind: 'refuse'; readonly why: string; readonly edit: string }
)

/**
 * The steps of `allow` for `tools`, and the policy it writes: an allow rule for the exact name of each added tool,
 * first, then the old rules without an old rule of the same match. A tool that the policy allows now keeps its rules.
 * `allow` never loosens a rule: it refuses a tool that a deny rule matches anywhere in the policy, also one that an
 * earlier rule hides today, and a tool that an ask rule names.
 */
export const planAllow = (
  policy: Policy,
  bridges: Bridges,
  tools: readonly string[],
): { readonly steps: readonly AllowStep[]; readonly policy: Policy } => {
  const steps = [...new Set(tools)].map((tool): AllowStep => {
    const { action, rule } = decide(policy, bridges, tool)
    if (action === 'allow' && rule !== undefined)
      return { tool, kind: 'keep', why: `allowed already by ${ruleText(rule)}` }
    // A deny or ask rule always counts, so `decide` gives a rule when one matches. An allow rule for the exact name
    // counts for a bridge tool too, so it decides the tool when it goes before that rule. The edit names each rule
    // with its text, because the printed --apply command of a mixed run moves every index.
    const before = (found: Rule) => `put an allow rule for ${tool} before the rule ${ruleText(rule ?? found)}`
    const deny = policy.find(r => r.action === 'deny' && matches(r.match, tool))
    if (deny !== undefined)
      return {
        tool,
        kind: 'refuse',
        why: `the deny rule ${ruleText(deny)} matches it. allow never loosens a deny rule`,
        edit: before(deny),
      }
    const ask = policy.find(r => r.action === 'ask' && r.match === tool)
    if (ask !== undefined)
      return {
        tool,
        kind: 'refuse',
        why: `the ask rule ${ruleText(ask)} names it. allow never loosens an ask rule`,
        edit: rule === ask ? `change the rule ${ruleText(ask)} to allow` : before(ask),
      }
    return { tool, kind: 'add' }
  })
  const added = new Set(steps.flatMap(s => (s.kind === 'add' ? [s.tool] : [])))
  const rules: Omit<Rule, 'index'>[] = [
    ...[...added].map(match => ({ match, action: 'allow' as const })),
    ...policy.filter(r => !added.has(r.match)),
  ]
  return { steps, policy: rules.map(({ match, action }, index) => ({ match, action, index })) }
}

/** The command that runs `allow` for `tools`: a dry run, or with `--apply` the run that writes the config. */
export const allowCommand = (start: Extract<CommandStart, { ok: true }>, tools: readonly string[], apply: boolean) =>
  `    ${start.run} allow ${apply ? '--apply ' : ''}--config ${start.config} ${tools.map(nameWords).join(' ')}`

/**
 * After the tools of a server, a label line and a dry-run `allow` command for each tool that the policy asks for and
 * `allow` would allow, and one command for all such read-only tools. A tool whose name is not plain gets no command.
 */
export const allowCommands = (
  lines: readonly ToolLine[],
  policy: Policy,
  bridges: Bridges,
  start: CommandStart,
): string[] => {
  const asked = lines.filter(l => l.action === 'ask')
  if (asked.length === 0) return []
  const head = ['', 'Commands that allow tools:']
  if (!start.ok) return [...head, ...start.lines]
  const plain = new Set<string>()
  const out = asked.flatMap(({ name }) => {
    if (!PLAIN_NAME.test(name)) return [label(shownName(name)), `    ${NAME_CHANGES}.`]
    const [step] = planAllow(policy, bridges, [name]).steps
    if (step?.kind === 'keep' || step?.kind === 'refuse') return [label(name), `    no command: ${step.why}.`]
    plain.add(name)
    return [label(name), allowCommand(start, [name], false)]
  })
  const readOnly = asked.filter(l => l.hint === 'read-only' && plain.has(l.name)).map(l => l.name)
  const all =
    readOnly.length > 1
      ? [label('every read-only tool above with a command'), allowCommand(start, readOnly, false)]
      : []
  return [...head, ...out, ...all]
}
