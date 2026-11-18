#!/usr/bin/env node
// The toolscript-mcp command: an MCP server over stdio. It reads the config,
// connects to the downstream servers in the background and serves at once.
// stdout carries only MCP JSON-RPC, so every log line goes to stderr.
// `toolscript-mcp init` writes the config from the configs of the clients.
// `toolscript-mcp login <server>` gets the OAuth tokens of an HTTP server.
// `toolscript-mcp tools <server>` and `toolscript-mcp runs` check a first run.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import fs from 'node:fs'
import os from 'node:os'
import { parseArgs } from 'node:util'
import { configPath, nestedStart } from '../core/config.ts'
import { errorText } from '../core/protocol.ts'
import { RUNS_USAGE, runRuns, runTools, TOOLS_USAGE } from './diagnose.ts'
import { connectAll } from './downstream.ts'
import { INIT_USAGE, runInit } from './init.ts'
import { LOGIN_USAGE, runLogin } from './login.ts'
import { createServer } from './server.ts'
import { detectLaunch, loadConfig, loginFor } from './start.ts'

const log = (line: string) => console.error(`toolscript-mcp: ${line}`)

function fail(lines: readonly string[]): never {
  for (const line of lines) log(line)
  process.exit(1)
}

const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string
}

const launch = detectLaunch(process.argv[1] ?? '')
const USAGE = ['usage: toolscript-mcp [--config <path>] [--help]', INIT_USAGE, LOGIN_USAGE, TOOLS_USAGE, RUNS_USAGE]

if (process.argv[2] === 'init')
  process.exit(
    await runInit(process.argv.slice(3), process.env, process.platform, os.homedir(), t => console.error(t), launch),
  )

const io = { env: process.env, platform: process.platform, home: os.homedir(), version, launch, print: console.error }
const COMMANDS = { login: runLogin, tools: runTools, runs: runRuns }
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

const downstream = connectAll(config.servers, version, log, {
  login: loginFor(launch, file, process.env, process.platform, os.homedir()),
  stderrInReason: true,
})
const { server, stopRuns } = createServer(downstream, config, file, version, log)

// A run in flight gets its sandbox killed and its exchange dir removed before the exit.
let closing: Promise<void> | undefined
const shutdown = () =>
  (closing ??= Promise.allSettled([stopRuns(), server.close(), downstream.close()]).then(() => process.exit(0)))

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await server.connect(new StdioServerTransport())
