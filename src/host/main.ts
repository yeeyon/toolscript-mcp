#!/usr/bin/env node
// The toolscript-mcp command: an MCP server over stdio. It reads the config,
// connects to the downstream servers in the background and serves at once.
// stdout carries only MCP JSON-RPC, so every log line goes to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import fs from 'node:fs'
import os from 'node:os'
import { parseArgs } from 'node:util'
import { configPath, nestedStart, parseConfig } from '../core/config.ts'
import { errorText } from '../core/protocol.ts'
import { connectAll } from './downstream.ts'
import { createServer } from './server.ts'

const log = (line: string) => console.error(`toolscript-mcp: ${line}`)

function fail(lines: readonly string[]): never {
  for (const line of lines) log(line)
  process.exit(1)
}

const refusal = nestedStart(process.env)
if (refusal !== undefined) {
  console.error(refusal)
  process.exit(1)
}

let flag: string | undefined
try {
  flag = parseArgs({ options: { config: { type: 'string' } } }).values.config
} catch (err) {
  fail([errorText(err), 'usage: toolscript-mcp [--config <path>]'])
}

const file = configPath(flag, process.env, process.platform, os.homedir())
let text = ''
try {
  text = fs.readFileSync(file, 'utf8')
} catch (err) {
  fail([`cannot read the config ${file}: ${errorText(err)}`])
}
const parsed = parseConfig(text, process.env, process.execPath)
if (!parsed.ok) fail([`the config ${file} has errors:`, ...parsed.errors.map(e => `  ${e}`)])
const { config } = parsed

const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string
}
const downstream = connectAll(config.servers, version, log)
const server = createServer(downstream, version)

let closing: Promise<void> | undefined
const shutdown = () =>
  (closing ??= Promise.allSettled([server.close(), downstream.close()]).then(() => process.exit(0)))

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await server.connect(new StdioServerTransport())
