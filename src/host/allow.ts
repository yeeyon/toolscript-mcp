// `toolscript-mcp allow`: an allow rule for the exact name of each tool, first in the policy of the config. Without
// --apply it is a dry run: it shows the policy that it would write, and the command that writes it, so an agent only
// runs commands that the CLI printed. It prints to stderr, as init does.

import path from 'node:path'
import { parseArgs } from 'node:util'
import { allowCommand, allowRefusal, commandStart, planAllow } from '../core/commands.ts'
import { configPath } from '../core/config.ts'
import { ruleText } from '../core/policy.ts'
import { errorText } from '../core/protocol.ts'
import { writeConfig } from './configfile.ts'
import type { CheckIo } from './diagnose.ts'
import { loadConfig } from './start.ts'

export const ALLOW_USAGE = 'usage: toolscript-mcp allow [--apply] [--config <path>] <tool>... [--help]'

const RELOAD = [
  'toolscript-mcp reads the policy again at each run. It asks you to approve a new allow rule before it applies.',
  'If your client cannot ask, restart toolscript-mcp to apply a new allow rule.',
]

/** Runs `allow` with these arguments and returns the exit code. */
export const runAllow = async (args: readonly string[], io: CheckIo): Promise<number> => {
  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      options: { config: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    })
  } catch (err) {
    io.print(`${errorText(err)}\n${ALLOW_USAGE}`)
    return 2
  }
  const { values, positionals: tools } = parsed
  if (values.help) {
    io.print(ALLOW_USAGE)
    return 0
  }
  if (tools.length === 0) {
    io.print(ALLOW_USAGE)
    return 2
  }
  const file = path.resolve(configPath(values.config, io.env, io.platform, io.home))
  const loaded = loadConfig(file, io.env, io.platform)
  if (!loaded.ok) {
    io.print(loaded.lines.join('\n'))
    return 1
  }
  const keys = new Set<string>(loaded.config.servers.keys())
  const refusals = tools.flatMap(tool => allowRefusal(tool, keys) ?? [])
  if (refusals.length > 0) {
    io.print([...refusals, `allow did not change ${file}.`, ALLOW_USAGE].join('\n'))
    return 2
  }
  const plan = planAllow(loaded.config.policy, loaded.config.guards, tools)
  const steps = plan.steps.map(s => {
    switch (s.kind) {
      case 'add':
        return `add: an allow rule for ${s.tool}`
      case 'keep':
        return `keep: ${s.tool}: ${s.why}`
      case 'refuse':
        return `refused: ${s.tool}: ${s.why}.`
    }
  })
  const added = plan.steps.flatMap(s => (s.kind === 'add' ? [s.tool] : []))
  const refused = plan.steps.flatMap(s => (s.kind === 'refuse' ? [s] : []))
  const policy = plan.policy.map(rule => `  ${ruleText(rule)}`)
  if (refused.length > 0) {
    // A run that refuses a tool writes nothing, with or without --apply: a partial write behind exit 2 misleads.
    const next = refused.map(s => `next: ${s.tool}: to allow it, edit the policy of ${file}: ${s.edit}.`)
    const start = commandStart(file, io.platform, io.launch, 'allow')
    io.print(
      [
        ...steps,
        ...next,
        `allow did not change ${file}, because it refused ${refused.length === 1 ? 'a tool' : 'tools'}.`,
        ...(added.length === 0
          ? []
          : [
              'The command below adds only the tools that it names. It writes this policy:',
              ...policy,
              ...RELOAD,
              'To write this policy, run the command below.',
              ...(start.ok ? [allowCommand(start, added, true)] : start.lines),
            ]),
      ].join('\n'),
    )
    return 2
  }
  if (added.length === 0) {
    io.print([...steps, `The policy needs no change. allow did not change ${file}.`].join('\n'))
    return 0
  }
  if (!values.apply) {
    const start = commandStart(file, io.platform, io.launch, 'allow')
    io.print(
      [
        ...steps,
        `Dry run: allow did not change ${file}. The policy would be:`,
        ...policy,
        ...RELOAD,
        'To write this policy, run the command below.',
        ...(start.ok ? [allowCommand(start, added, true)] : start.lines),
      ].join('\n'),
    )
    return 0
  }
  // parseConfig read the text as a JSON object. Every key other than the policy stays as the file has it.
  const json = JSON.parse(loaded.text) as Record<string, unknown>
  const rules = plan.policy.map(({ match, action }) => ({ match, action }))
  try {
    await writeConfig(file, `${JSON.stringify({ ...json, policy: rules }, null, 2)}\n`, true)
  } catch (err) {
    io.print(`cannot write ${file}: ${errorText(err)}`)
    return 1
  }
  io.print([...steps, `Wrote ${file}. The policy is now:`, ...policy, ...RELOAD].join('\n'))
  return 0
}
