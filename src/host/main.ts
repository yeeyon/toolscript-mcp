#!/usr/bin/env node
// The toolscript-mcp command: an MCP server over stdio. It reads the config,
// connects to the downstream servers in the background and serves at once.
// stdout carries only MCP JSON-RPC, so every log line goes to stderr.
// `toolscript-mcp init` writes the config from the configs of the clients.
// `toolscript-mcp login <server>` gets the OAuth tokens of an HTTP server.
// `toolscript-mcp tools <server>` and `toolscript-mcp runs` check a first run, and
// `toolscript-mcp allow <tool>...` allows the tools of its task.
// `toolscript-mcp doctor` checks the whole setup.
// `toolscript-mcp --version` prints the package version.

import { StdioServerTransport } from './sdk/server.ts'
import fs from 'node:fs'
import os from 'node:os'
import { parseArgs } from 'node:util'
import { configPath, nestedStart, protocolOf, unknownLegacyLine } from '../core/config.ts'
import { errorText } from '../core/protocol.ts'
import { ALLOW_USAGE, runAllow } from './allow.ts'
import { RUNS_USAGE, runRuns, runTools, TOOLS_USAGE } from './diagnose.ts'
import { DOCTOR_USAGE, runDoctor } from './doctor.ts'
import { brokerFileBeside } from './brokerlink.ts'
import { createGuard } from './childguard.ts'
import { connectAll } from './downstream.ts'
import { lazyIdleMs } from '../core/lazy.ts'
import { toolsStore } from './toolscache.ts'
import { INIT_USAGE, runInit } from './init.ts'
import { LOGIN_USAGE, runLogin } from './login.ts'
import { createServer } from './server.ts'
import { detectLaunch, loadConfig, loginFor } from './start.ts'
import type { WorkspaceConfig } from '../core/workspace.ts'
import { within } from './shapes.ts'
import { bindStep, bindWorkspace, linkOf, type Binding, type Step } from './workspace/bind.ts'
import { createRoots, type Roots } from './workspace/roots.ts'

const log = (line: string) => console.error(`toolscript-mcp: ${line}`)

function fail(lines: readonly string[]): never {
  for (const line of lines) log(line)
  process.exit(1)
}

const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string
}

const launch = detectLaunch(process.argv[1] ?? '')
const USAGE = [
  'usage: toolscript-mcp [--config <path>] [--help] [--version]',
  INIT_USAGE,
  LOGIN_USAGE,
  TOOLS_USAGE,
  ALLOW_USAGE,
  RUNS_USAGE,
  DOCTOR_USAGE,
]

// The package proof for the plugin skills: one line, no config read, no server started. It answers on stdout (owner
// decision, issue #156) and exits before any MCP transport exists, so no JSON-RPC stream can meet this line.
if (process.argv.length === 3 && (process.argv[2] === '--version' || process.argv[2] === '-v')) {
  fs.writeSync(1, `${version}\n`) // stdout-ok: --version
  process.exit(0)
}

if (process.argv[2] === 'init')
  process.exit(
    await runInit(process.argv.slice(3), process.env, process.platform, os.homedir(), t => console.error(t), launch),
  )

const io = { env: process.env, platform: process.platform, home: os.homedir(), version, launch, print: console.error }
const COMMANDS = { login: runLogin, tools: runTools, allow: runAllow, runs: runRuns, doctor: runDoctor }
const command = process.argv[2]
if (command !== undefined && Object.hasOwn(COMMANDS, command))
  process.exit(await COMMANDS[command as keyof typeof COMMANDS](process.argv.slice(3), io))

const refusal = nestedStart(process.env)
if (refusal !== undefined) {
  console.error(refusal)
  process.exit(1)
}

let flag: string | undefined
try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
  if (values.help) {
    for (const line of USAGE) console.error(line)
    process.exit(0)
  }
  flag = values.config
} catch (err) {
  fail([errorText(err), ...USAGE])
}

const file = configPath(flag, process.env, process.platform, os.homedir())
const loaded = loadConfig(file, process.env, process.platform)
if (!loaded.ok) fail(loaded.lines)
const { config } = loaded
// A launch of Claude Code that parseConfig does not see is not a bridge: this line lets the person see the miss.
log(`Claude Code bridges: ${[...config.bridges].join(', ') || 'none'}`)
// Items of TOOLSCRIPT_LEGACY_SERVERS that name no server: one line, never fatal, and only key-shaped items.
const unknownLegacy = unknownLegacyLine(config.protocol)
if (unknownLegacy !== undefined) log(unknownLegacy)

// The built-in Workspace binds its root one time, after the client roots settle (issue #150): at the answer to
// roots/list, or ROOTS_WAIT_MS after the client initialized. The section is never read again. The server starts at once,
// and a call to the Workspace waits for the bind.
// A config with no workspace section never asks the client for its roots.
const roots = config.workspace === undefined ? undefined : createRoots({ log })
// The part of the bind that reads the config alone runs first: when it failed, the instructions at `initialize` say
// that Workspace is not available (issue #163). A step that takes over 2 s (a dead network share) is not waited for.
const step: Promise<Step> | undefined =
  config.workspace === undefined
    ? undefined
    : bindStep({ workspace: config.workspace, start: process.cwd(), home: os.homedir(), configFile: file })
const bindOf = async (section: WorkspaceConfig, clientRoots: Roots, stepped: Promise<Step>): Promise<Binding> => {
  const workspace = await bindWorkspace({
    workspace: section,
    start: process.cwd(),
    home: os.homedir(),
    configFile: file,
    log,
    clientRoots: clientRoots.read,
    callSeconds: config.sandbox.callTimeoutSeconds,
    step: await stepped,
  })
  log(
    workspace.ok
      ? `Workspace: root ${workspace.bound.root}, ${workspace.bound.write ? 'read and write' : 'read-only'}, confined by ${workspace.bound.method}${workspace.bound.tasks.names.length > 0 ? `, tasks: ${workspace.bound.tasks.names.join(', ')}` : ''}`
      : `Workspace: unavailable: ${workspace.reason}`,
  )
  if (workspace.ok)
    for (const { name, reason } of workspace.bound.tasks.invalid) log(`Workspace: task ${name} is invalid: ${reason}`)
  return workspace
}
const workspace =
  config.workspace === undefined || roots === undefined || step === undefined
    ? undefined
    : bindOf(config.workspace, roots, step)

// The guard of the stdio children (decision: a killed host leaves none). It starts at the first child.
const guard = createGuard({ home: os.homedir(), log })
const downstream = connectAll(config.servers, version, log, {
  guard,
  login: loginFor(launch, file, process.env, process.platform, os.homedir()),
  ...(workspace !== undefined && { workspace: workspace.then(linkOf) }),
  // Lazy start (decision 028): the bridge starts on its first call and stops when idle. TOOLSCRIPT_LAZY=0 turns it off.
  ...(config.lazy && {
    lazy: {
      bridges: config.bridges,
      idleMs: lazyIdleMs(process.env.TOOLSCRIPT_LAZY_IDLE_MS),
      cache: toolsStore(os.homedir(), log),
    },
  }),
  ...(config.share.on && {
    share: {
      bridges: config.bridges,
      home: os.homedir(),
      folder: process.cwd(),
      brokerFile: brokerFileBeside(import.meta.url),
      protocol: key => protocolOf(config.protocol, key),
    },
  }),
})
// The downstream servers have started: only now does the server wait for the step, at most 2 s.
const workspaceDown = step !== undefined && (await within<Step | undefined>(step, 2000, undefined))?.ok === false
const { server, stopRuns } = createServer(
  downstream,
  config,
  file,
  version,
  log,
  workspace?.then(w => (w.ok ? { root: w.bound.root, tasks: w.bound.tasks.names } : undefined)),
  workspaceDown,
)
roots?.attach(server.server)

// A run in flight gets its sandbox killed and its exchange dir removed before the exit.
let closing: Promise<void> | undefined
const shutdown = () => {
  // A shutdown before the client answered settles the roots, so the bind ends and its provider can close.
  roots?.close()
  return (closing ??= Promise.allSettled([
    stopRuns(),
    server.close(),
    downstream.close(),
    // A task ends with its tree before the exit, whatever the other closes wait for.
    workspace?.then(w => (w.ok ? w.bound.provider.stopTasks() : undefined)),
  ])
    .then(() => workspace)
    .then(w => (w?.ok ? w.bound.provider.close() : undefined))
    // Every child is stopped: the guard ends with nothing left in its list.
    .then(() => guard.close())
    .then(() => process.exit(0)))
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// A direct child runs in its own process group outside Windows, so the SIGHUP of a closed terminal no longer reaches it.
process.on('SIGHUP', shutdown)

await server.connect(new StdioServerTransport())
