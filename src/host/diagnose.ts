// The checks of a first run. `toolscript-mcp tools <server>` connects to one server of the config as the running
// server does, then prints its tools, what the policy decides for each, and a dry-run allow command for each tool that
// the policy asks for and whose name every shell passes as it is. `toolscript-mcp runs` reads the run log and
// says whether the newest run of a server worked, and the next step when it did not. Both print to stderr, as init and
// login do. Neither prints a description, an argument, an env or header value, a token or the stderr of a child.

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { toolLines, toolLineText, type SettledState } from '../core/catalog.ts'
import { allowCommands, commandStart } from '../core/commands.ts'
import {
  configPath,
  loginReason,
  serverKey,
  toolsCommand,
  type Env,
  type Launch,
  type ServerEntry,
  type ServerKey,
} from '../core/config.ts'
import { oldRunLogFile, runLogFile } from '../core/paths.ts'
import { printableText } from '../core/policy.ts'
import { errorText } from '../core/protocol.ts'
import { parseRunLine, parseSince, runsReport, type LogEntry } from '../core/runlog.ts'
import { connectAll } from './downstream.ts'
import { loadConfig, loginFor, otherConfig } from './start.ts'

export const TOOLS_USAGE = 'usage: toolscript-mcp tools <server> [--config <path>] [--help]'
export const RUNS_USAGE =
  'usage: toolscript-mcp runs [--server <key>] [--last <n>] [--since <time>] [--config <path>] [--help]'
const RUNS_ARGS =
  '--last takes a whole number from 1, --server a server key, and --since a time with a zone, such as 2026-11-18T09:30:00Z, or 30m, 2h or 1d back from now'

// An agent can read what a command prints, and the command logs nothing: only a running server writes the text to its log.
const unshown = (command: string): string =>
  `${command} does not show its error text, because the text of this server is untrusted. When the client starts toolscript-mcp, its log holds the text`

export type CheckIo = {
  readonly env: Env
  readonly platform: string
  readonly home: string
  readonly version: string
  /** How this process started, so a printed command starts it the same way. */
  readonly launch: Launch
  readonly print: (text: string) => void
}

/**
 * Connects to `servers` of the config `file` in parallel, as the running server does, and returns their states once
 * none is connecting. It starts no login, drops the stderr of each child and logs nothing. Each attempt has the time
 * limit of a connect. `command` names the command in the reason of an untrusted server.
 */
export const connectStates = async (
  servers: ReadonlyMap<ServerKey, ServerEntry>,
  io: CheckIo,
  file: string,
  command: string,
): Promise<readonly SettledState[]> => {
  const downstream = connectAll(servers, io.version, () => {}, {
    home: io.home,
    login: loginFor(io.launch, file, io.env, io.platform, io.home),
    childStderr: () => {},
    unshown: unshown(command),
  })
  try {
    // Each retry waits for the attempts in progress, at most a few seconds: the connect itself has its time limit.
    for (;;) {
      const states = downstream.states()
      if (states.every((s): s is SettledState => s.status === 'connected' || s.status === 'failed')) return states
      await downstream.retry(states.filter(s => s.status === 'connecting').map(s => s.key))
    }
  } finally {
    await downstream.close()
  }
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
  const state = (await connectStates(new Map([[key, entry]]), io, file, 'tools'))[0]!
  if (state.status === 'failed') {
    const command = loginFor(io.launch, file, io.env, io.platform, io.home)(key)
    io.print(
      state.reason.startsWith(loginReason(command))
        ? `${key}: needs an OAuth login. Run this command in a terminal, then run tools again: ${command}`
        : `${key}: cannot connect: ${printableText(state.reason)}`,
    )
    return 1
  }
  const lines = toolLines(state, config.policy, config.bridges)
  const start = commandStart(path.resolve(file), io.platform, io.launch, 'tools')
  io.print(
    [
      `${key}: connected, ${lines.length} tools`,
      ...lines.map(toolLineText),
      ...allowCommands(lines, config.policy, config.bridges, start),
    ].join('\n'),
  )
  return 0
}

/** The text of a run log file, empty when it does not exist. */
const readLog = async (file: string): Promise<string> => {
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    // POSIX gives ENOTDIR when a file is where the folder of the log goes, Windows ENOENT. No folder holds no log.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return ''
    throw err
  }
}

/** The lines of the run log, oldest first. Throws when a file exists and cannot be read. */
export const readRunLog = async (home: string): Promise<LogEntry[]> => {
  // The old file first: right after a rotation, the newest runs are in both.
  const text = (await Promise.all([oldRunLogFile(home), runLogFile(home)].map(readLog))).join('\n')
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(parseRunLine)
}

/** The tools command of a server of the config `file`. */
export const toolsFor =
  (io: CheckIo, file: string) =>
  (key: ServerKey): string =>
    toolsCommand(io.launch, io.platform, key, otherConfig(file, io.env, io.platform, io.home))

/** Runs `runs` with these arguments and returns the exit code. */
export const runRuns = async (args: readonly string[], io: CheckIo): Promise<number> => {
  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        server: { type: 'string' },
        last: { type: 'string' },
        since: { type: 'string' },
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
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
  const now = new Date()
  const since = values.since === undefined ? undefined : parseSince(values.since, now)
  if (
    !Number.isSafeInteger(last) ||
    last < 1 ||
    (values.server !== undefined && server === undefined) ||
    (values.since !== undefined && since === undefined)
  ) {
    io.print(`${RUNS_ARGS}\n${RUNS_USAGE}`)
    return 2
  }
  // The run log does not depend on the config. The config only turns the log off, and its path goes into the printed
  // tools command. So only a config that the person names must be readable.
  const file = configPath(values.config, io.env, io.platform, io.home)
  const loaded = loadConfig(file, io.env, io.platform)
  if (!loaded.ok && values.config !== undefined) {
    io.print(loaded.lines.join('\n'))
    return 1
  }
  const off = loaded.ok && !loaded.config.log
  let entries: LogEntry[]
  try {
    entries = await readRunLog(io.home)
  } catch (err) {
    io.print(`cannot read the run log: ${errorText(err)}`)
    return 1
  }
  const report = runsReport(entries, { server, last, since, now }, toolsFor(io, file))
  // With the log off, the newest run in the file is not a run of this config.
  const note = off
    ? [
        `the config ${file} sets "log": false, so toolscript-mcp writes no run log with it. Remove the key to check runs.`,
      ]
    : []
  io.print([...note, ...report.lines].join('\n'))
  return report.ok && !off ? 0 : 1
}
