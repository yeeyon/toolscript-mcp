// Helpers for the broker tests: the entry of tests/pid-server.mjs, a tool call as text, and waits on a process.

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Entry } from '../src/core/broker.ts'

export const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pid-server.mjs')

/** The entry of the test server, run in `folder`, with the environment of a host plus `env`. */
export const serverEntry = (
  folder: string,
  env: Record<string, string> = {},
  args: string[] = [],
  command = process.execPath,
): Entry => ({ command, args: [SERVER, ...args], env: { ...getDefaultEnvironment(), ...env }, folder })

export const text = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] }
  return result.content[0]!.text
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const until = async (what: string, check: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    assert.ok(Date.now() < end, `timed out: ${what}`)
    await new Promise(r => setTimeout(r, 25))
  }
}
