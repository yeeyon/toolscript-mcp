// Helpers for the broker tests: the entry of tests/pid-server.mjs, a tool call as text, and waits on a process.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
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

/**
 * The private bytes of a process, in bytes: the commit charge on Windows, the resident set elsewhere (the nearest figure
 * that `ps` gives). Undefined when the process cannot be read.
 */
export const privateBytes = (pid: number): number | undefined => {
  const win = process.platform === 'win32'
  const r = win
    ? spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).PrivateMemorySize64`],
        { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
      )
    : spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  const n = Number(r.stdout?.trim())
  return r.status === 0 && Number.isFinite(n) && n > 0 ? (win ? n : n * 1024) : undefined
}

export const until = async (what: string, check: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    assert.ok(Date.now() < end, `timed out: ${what}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

/** Leaves a socket file that nothing listens on: a process binds it and is killed with no cleanup. POSIX only. */
export const staleSocket = async (file: string): Promise<void> => {
  const code = "require('net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))"
  const child = spawn(process.execPath, ['-e', code, file], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  await new Promise(resolve => child.stdout.once('data', resolve))
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
  assert.ok(fs.existsSync(file), 'the socket file stays after the kill')
}
