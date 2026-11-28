// The golden of what a client of the 2026-07-28 revision sees of the built server with `TOOLSCRIPT_PROTOCOL=auto` (issue #154,
// PR 13): the openings `modern` and `claude-code-auto` of the raw client of C0, replayed for the empty and the demo config. The
// expected texts in tests/fixtures/upstream-modern-golden.json were recorded at this head (`GOLDEN_RECORD=1`), with the version
// of toolscript-mcp masked. A difference of key order alone passes. The raw client has no SDK, so the SDK that serves can change
// and the bytes must not. Run `npm run build` first.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OPENINGS, createClient, replay, streamTransport, within } from './modern-client.mjs'

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'upstream-modern-golden.json')
const RECORD = process.env.GOLDEN_RECORD === '1'
const MAIN = path.join(import.meta.dirname, '..', 'dist', 'host', 'main.js')
const DEMO = path.join(import.meta.dirname, '..', 'demo', 'server.mjs')
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-modern-golden-')))
const children = new Set<ReturnType<typeof spawn>>()
after(async () => {
  for (const child of children) child.kill()
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 })
})

const golden: Record<string, unknown> =
  RECORD || !fs.existsSync(FIXTURE) ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const recorded: Record<string, unknown> = {}
after(() => {
  if (RECORD) fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
})

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value

const settle = (name: string, value: unknown): void => {
  const text = JSON.stringify(value)
  recorded[name] = JSON.parse(text)
  if (RECORD) return
  assert.notEqual(golden[name], undefined, `no golden value of ${name}`)
  assert.deepEqual(canonical(JSON.parse(text)), canonical(golden[name]), `the golden value of ${name} changed`)
}

const CONFIGS = {
  empty: { mcpServers: {} },
  demo: { mcpServers: { demo: { command: process.execPath, args: [DEMO] } }, policy: [] },
}

/** The version of toolscript-mcp is masked: a release changes it. */
const mask = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value).replace(
      /("io\.modelcontextprotocol\/serverInfo":\{"name":"toolscript-mcp","version":)"[^"]*"/gu,
      '$1"<version>"',
    ),
  )

const connectTo = (configName: keyof typeof CONFIGS) => (n: number) => {
  const dir = fs.mkdtempSync(path.join(ROOT, `${configName}-${n}-`))
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.join(home, 'appdata'), { recursive: true })
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify(CONFIGS[configName]))
  const child = spawn(process.execPath, [MAIN, '--config', file], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'appdata'),
      TOOLSCRIPT_SHARE: '0',
      TOOLSCRIPT_PROTOCOL: 'auto',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  child.stderr.resume()
  return createClient(streamTransport(child.stdout, child.stdin), { timeoutMs: 30_000 })
}

/** The rows of a replay, with a stream reduced to its acknowledgement. */
const rowsOf = (steps: Awaited<ReturnType<typeof replay>>) =>
  steps.map(({ conn, method, reply }) => ({
    conn,
    method,
    reply:
      reply !== undefined && 'ack' in (reply as object)
        ? { ack: (reply as any).ack, error: (reply as any).error, notifications: (reply as any).notifications() }
        : reply,
  }))

describe('the modern openings on the built server', { skip: !fs.existsSync(MAIN) && 'no build' }, () => {
  for (const configName of ['empty', 'demo'] as const)
    for (const opening of ['modern', 'claude-code-auto'] as const)
      test(`${opening}, ${configName} config`, async () => {
        const clients: ReturnType<typeof connectTo>[] = []
        const steps = await within(
          replay(OPENINGS[opening], n => {
            const c = connectTo(configName)(n)
            clients.push(c)
            return c
          }),
          60_000,
          `the replay of ${opening}`,
        )
        for (const c of clients) c.close()
        const rows = rowsOf(steps)
        // Every answer is a 2026-07-28 result or error as the server gave it: nothing of a legacy session in it.
        for (const row of rows) assert.ok(!(row.reply as any)?.failed, JSON.stringify(row))
        settle(`${opening}/${configName}`, mask(rows))
      })
})
