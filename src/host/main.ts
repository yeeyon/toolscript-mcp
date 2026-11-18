#!/usr/bin/env node
// The toolscript-mcp command: an MCP server over stdio. It reads the config,
// connects to the downstream servers in the background and serves at once.
// stdout carries only MCP JSON-RPC, so every log line goes to stderr.
// `toolscript-mcp init` writes the config from the configs of the clients.
// `toolscript-mcp login <server>` gets the OAuth tokens of an HTTP server.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { configPath, loginCommand, nestedStart, parseConfig } from '../core/config.ts'
import { errorText } from '../core/protocol.ts'
import { connectAll } from './downstream.ts'
import { INIT_USAGE, runInit } from './init.ts'
import { LOGIN_USAGE, runLogin } from './login.ts'
import { createServer } from './server.ts'
import { detectLaunch } from './start.ts'

const log = (line: string) => console.error(`toolscript-mcp: ${line}`)

function fail(lines: readonly string[]): never {
  for (const line of lines) log(line)
  process.exit(1)
}

const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string
}

const launch = detectLaunch(process.argv[1] ?? '')
const USAGE = ['usage: toolscript-mcp [--config <path>] [--help]', INIT_USAGE, LOGIN_USAGE]

if (process.argv[2] === 'init')
  process.exit(
    await runInit(process.argv.slice(3), process.env, process.platform, os.homedir(), t => console.error(t), launch),
  )

if (process.argv[2] === 'login') {
  const io = { env: process.env, platform: process.platform, home: os.homedir(), version, print: console.error }
  process.exit(await runLogin(process.argv.slice(3), io))
}

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
let text = ''
try {
  text = fs.readFileSync(file, 'utf8')
} catch (err) {
  fail([`cannot read the config ${file}: ${errorText(err)}`])
}
const parsed = parseConfig(text, process.env, process.execPath, process.platform)
if (!parsed.ok) fail([`the config ${file} has errors:`, ...parsed.errors.map(e => `  ${e}`)])
const { config } = parsed

// The person runs login in a terminal, without the flag or the TOOLSCRIPT_CONFIG of this server.
const usual = configPath(undefined, { ...process.env, TOOLSCRIPT_CONFIG: undefined }, process.platform, os.homedir())
const other = path.resolve(file) === path.resolve(usual) ? undefined : path.resolve(file)
const downstream = connectAll(config.servers, version, log, {
  login: key => loginCommand(launch, process.platform, key, other),
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
