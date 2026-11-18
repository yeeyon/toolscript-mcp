// The checks of a first run. `toolscript-mcp tools <server>` connects to one server of the config as the running
// server does, then prints its tools and what the policy decides for each. `toolscript-mcp runs` reads the run log and
// says whether the newest run of a server worked, and the next step when it did not. Both print to stderr, as init and
// login do. Neither prints a description, an argument, an env or header value, or a token.

import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { toolLines, toolLineText } from '../core/catalog.ts'
import { configPath, loginReason, serverKey, toolsCommand, type Env, type Launch } from '../core/config.ts'
import { oldRunLogFile, runLogFile } from '../core/paths.ts'
import { errorText } from '../core/protocol.ts'
import { parseRunLine, runsReport } from '../core/runlog.ts'
import { connectAll } from './downstream.ts'
import { loadConfig, loginFor } from './start.ts'

export const TOOLS_USAGE = 'usage: toolscript-mcp tools <server> [--config <path>] [--help]'
export const RUNS_USAGE = 'usage: toolscript-mcp runs [--server <key>] [--last <n>] [--help]'

export type CheckIo = {
  readonly env: Env
  readonly platform: string
  readonly home: string
  readonly version: string
  /** How this process started, so a printed command starts it the same way. */
  readonly launch: Launch
  readonly print: (text: string) => void
}

/** Runs `tools` with these arguments and returns the exit code. */
export const runTools = async (args: readonly string[], io: CheckIo): Promise<number> => {
  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    })
  } catch (err) {
    io.print(`${errorText(err)}\n${TOOLS_USAGE}`)
    return 2
  }
  if (parsed.values.help) {
    io.print(TOOLS_USAGE)
    return 0
  }
  const [name, ...rest] = parsed.positionals
  if (name === undefined || rest.length > 0) {
    io.print(TOOLS_USAGE)
    return 2
  }
  const file = configPath(parsed.values.config, io.env, io.platform, io.home)
  const loaded = loadConfig(file, io.env, io.platform)
  if (!loaded.ok) {
    io.print(loaded.lines.join('\n'))
    return 1
  }
  const { config } = loaded
  const key = serverKey(name)
  const entry = key === undefined ? undefined : config.servers.get(key)
  if (key === undefined || entry === undefined) {
    io.print(
      `the config ${file} has no server "${name}". Its servers: ${[...config.servers.keys()].join(', ') || 'none'}`,
    )
    return 1
  }
  const login = loginFor(io.launch, file, io.env, io.platform, io.home)
  const downstream = connectAll(new Map([[key, entry]]), io.version, () => {}, {
    home: io.home,
    login,
    childStderr: () => {},
  })
  let state = downstream.states()[0]!
  try {
    // Each retry waits for the attempt in progress, at most a few seconds: the connect itself has its time limit.
    while (state.status === 'connecting') {
      await downstream.retry([key])
      state = downstream.states()[0]!
    }
  } finally {
    await downstream.close()
  }
  if (state.status === 'failed') {
    const command = login(key)
    io.print(
      state.reason.startsWith(loginReason(command))
        ? `${key}: needs an OAuth login. Run this command in a terminal, then run tools again: ${command}`
        : `${key}: cannot connect: ${state.reason}`,
    )
    return 1
  }
  const lines = toolLines(state, config.policy, config.bridges)
  io.print([`${key}: connected, ${lines.length} tools`, ...lines.map(toolLineText)].join('\n'))
  return 0
}

/** The text of a run log file, empty when it does not exist. */
const readLog = async (file: string): Promise<string> => {
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/** Runs `runs` with these arguments and returns the exit code. */
export const runRuns = async (args: readonly string[], io: CheckIo): Promise<number> => {
  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      options: { server: { type: 'string' }, last: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    })
  } catch (err) {
    io.print(`${errorText(err)}\n${RUNS_USAGE}`)
    return 2
  }
  const { values } = parsed
  if (values.help) {
    io.print(RUNS_USAGE)
    return 0
  }
  const last = values.last === undefined ? 1 : Number(values.last)
  const server = values.server === undefined ? undefined : serverKey(values.server)
  if (!Number.isSafeInteger(last) || last < 1 || (values.server !== undefined && server === undefined)) {
    io.print(`--last takes a whole number from 1, and --server a server key\n${RUNS_USAGE}`)
    return 2
  }
  // The old file first: right after a rotation, the newest runs are in both.
  const files = [oldRunLogFile(io.home), runLogFile(io.home)]
  let text: string
  try {
    text = (await Promise.all(files.map(readLog))).join('\n')
  } catch (err) {
    io.print(`cannot read the run log: ${errorText(err)}`)
    return 1
  }
  const records = text.split('\n').flatMap(line => parseRunLine(line) ?? [])
  const report = runsReport(records, server, last, key => toolsCommand(io.launch, io.platform, key))
  io.print(report.lines.join('\n'))
  return report.ok ? 0 : 1
}
