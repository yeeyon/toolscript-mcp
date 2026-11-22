// Helpers of tests/oauth-lock.test.ts and tests/oauth-lock-stale.test.ts: N real Node processes over one store (the
// child is tests/oauth-child.ts), against the fake server of tests/fake-oauth.ts. A barrier starts their calls in the
// same moment: each child reports ready, then the parent says go. Every home is a temp folder.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { ServerKey } from '../src/core/config.ts'
import { runLogin } from '../src/host/login.ts'
import { storeFile } from '../src/host/oauth.ts'
import { servers, startFake, type Fake } from './fake-oauth.ts'

export const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-oauth-lock-test-'))
export const CHILD = path.join(import.meta.dirname, 'oauth-child.ts')
export const PONG = JSON.stringify([{ type: 'text', text: 'pong' }])
export const procs: ChildProcess[] = []
export const cleanup = () => {
  for (const p of procs) p.kill('SIGKILL')
  for (const s of servers) (s.closeAllConnections(), s.close())
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 })
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export const until = async (what: string, test: () => boolean, limitMs = 15_000) => {
  const start = Date.now()
  while (!test()) {
    if (Date.now() - start > limitMs) assert.fail(`timeout: ${what}`)
    await sleep(5)
  }
}

export type Line = { key: string; text: string; at: number }

/** One toolscript-mcp process. `go` runs one round of connect and call. */
export const startChild = (home: string, configFile: string, refreshMs: number | undefined) => {
  const proc = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      CHILD,
      home,
      configFile,
      refreshMs === undefined ? '' : String(refreshMs),
    ],
    // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
    { env: { ...process.env, HOME: home, USERPROFILE: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] },
  )
  procs.push(proc)
  let lines: Line[] = []
  let readyNow = () => {}
  let endNow = () => {}
  let ended = Promise.resolve()
  const ready = new Promise<void>(resolve => (readyNow = resolve))
  readline.createInterface({ input: proc.stdout }).on('line', text => {
    const m = JSON.parse(text) as Partial<Line> & { ready?: true; end?: true }
    if (m.ready) readyNow()
    else if (m.end) endNow()
    else lines.push(m as Line)
  })
  // A child that was killed ends its round too.
  proc.on('exit', () => (readyNow(), endNow()))
  return {
    proc,
    ready,
    go: () => {
      lines = []
      ended = new Promise<void>(resolve => (endNow = resolve))
      proc.stdin.write('go\n')
    },
    ended: () => ended,
    lines: () => lines,
    stop: async () => {
      if (proc.exitCode === null) proc.stdin.write('exit\n')
      await new Promise<void>(resolve => (proc.exitCode === null ? proc.once('exit', () => resolve()) : resolve()))
    },
  }
}
export type Child = ReturnType<typeof startChild>

/** A browser that follows the authorization redirect to the callback. */
export const browser = (url: string) =>
  void (async () => {
    const answer = await fetch(url, { redirect: 'manual' })
    await fetch(new URL(answer.headers.get('location') ?? ''))
  })()

/** A home with one login for each fake server, `a`, `b`, and so on, and a config for them. Reuse detection is on. */
export const setup = async (count = 1) => {
  const home = fs.mkdtempSync(path.join(ROOT, 'home-'))
  const keys = ['a', 'b'].slice(0, count) as ServerKey[]
  const fakes = await Promise.all(keys.map(() => startFake()))
  const configFile = path.join(home, 'config.json')
  fs.writeFileSync(
    configFile,
    JSON.stringify({ mcpServers: Object.fromEntries(keys.map((k, i) => [k, { type: 'http', url: fakes[i]?.url }])) }),
  )
  const printed: string[] = []
  for (const key of keys) {
    const code = await runLogin([key, '--config', configFile], {
      env: {},
      platform: process.platform,
      home,
      version: '0',
      print: t => void printed.push(t),
      open: browser,
    })
    assert.equal(code, 0, printed.join('\n'))
  }
  for (const f of fakes) f.change.reuseDetection = true
  const files = keys.map((key, i) => storeFile(home, key, fakes[i]?.url ?? ''))
  const dir = path.dirname(files[0] ?? '')
  return {
    home,
    configFile,
    keys,
    fakes,
    files,
    /** The files in the store folder that are not store files: locks, claims, temp files. */
    leftovers: () => fs.readdirSync(dir).filter(name => !name.endsWith('.json')),
    storedRefresh: (i = 0) =>
      (JSON.parse(fs.readFileSync(files[i] ?? '', 'utf8')) as { tokens: { refresh_token: string } }).tokens
        .refresh_token,
  }
}
export type Setup = Awaited<ReturnType<typeof setup>>

export const group = async (s: Setup, n: number, refreshMs?: number): Promise<Child[]> => {
  const children = Array.from({ length: n }, () => startChild(s.home, s.configFile, refreshMs))
  await Promise.all(children.map(c => c.ready))
  // One round with a working token loads the code of each process, so a timed round after it measures the refresh.
  for (const c of children) c.go()
  await Promise.all(children.map(c => c.ended()))
  return children
}

/** One round: the access tokens expire, then all children go at once. Gives each line and the time it took. */
export const round = async (s: Setup, children: Child[]) => {
  for (const f of s.fakes) f.expire()
  const start = Date.now()
  for (const c of children) c.go()
  await Promise.all(children.map(c => c.ended()))
  return { lines: children.flatMap(c => c.lines()), ms: Date.now() - start }
}

export const requests = (f: Fake) => f.refreshRequests()
export const revocations = (s: Setup) => s.fakes.reduce((sum, f) => sum + f.seen.revocations, 0)
export const stop = (children: Child[]) => Promise.all(children.map(c => c.stop()))

/** The lock file of store `i`, with `text` as its content, made `ageSec` seconds ago. */
export const putLock = (s: Setup, text: string, ageSec: number, i = 0) => {
  const file = `${s.files[i]}.lock`
  fs.writeFileSync(file, text)
  const then = new Date(Date.now() - ageSec * 1000)
  fs.utimesSync(file, then, then)
  return file
}
export const lockText = (pid: number) => JSON.stringify({ pid, id: randomUUID(), at: Date.now() })
/** The pid of a process that has ended. */
export const deadPid = async (): Promise<number> => {
  const p = spawn(process.execPath, ['-e', ''], { windowsHide: true })
  await new Promise(resolve => p.once('exit', resolve))
  return p.pid ?? 0
}
