// The run log: the shape of a line, that no value leaks into it, the rotation
// and the `log` key of the config. The host writer runs against a temp HOME.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../src/core/config.ts'
import { oldRunLogFile, runLogFile } from '../src/core/paths.ts'
import {
  MAX_CALLS,
  MAX_LOG_BYTES,
  callDecision,
  rotates,
  runLine,
  runRecord,
  type CallLog,
} from '../src/core/runlog.ts'
import { appendRunLog } from '../src/host/runlog.ts'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-runlog-test-'))
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }))

const SECRET = 'sk-fake-secret-1234567890'
const call = (o: Partial<CallLog> = {}): CallLog => ({
  tool: 'mcp__f__echo',
  decision: 'allow',
  ms: 12.4,
  ok: true,
  ...o,
})
const input = (calls: CallLog[]) => ({
  now: new Date('2026-01-02T03:04:05.678Z'),
  id: 'run-1',
  ms: 250.6,
  ending: 'done' as const,
  chars: 42,
  calls,
  known: new Set(['mcp__f__echo']),
})

describe('the run record', () => {
  test('has the time, id, duration, ending, size and the calls', () => {
    const record = runRecord(input([call(), call({ ok: false, error: 'tool-error', ms: 3 })]))
    assert.deepEqual(record, {
      time: '2026-01-02T03:04:05.678Z',
      id: 'run-1',
      ms: 251,
      ending: 'done',
      chars: 42,
      calls: [
        { tool: 'mcp__f__echo', decision: 'allow', ms: 12, ok: true },
        { tool: 'mcp__f__echo', decision: 'allow', ms: 3, ok: false, error: 'tool-error' },
      ],
    })
    assert.equal(runLine(record).split('\n').length, 2, 'one line, ended by a line break')
  })

  test('a name that is not a listed tool is not written, since a program builds names and a name can hold data', () => {
    const record = runRecord(input([call({ tool: `mcp__f__${SECRET}` }), call({ tool: SECRET, decision: 'invalid' })]))
    assert.equal(runLine(record).includes(SECRET), false)
    assert.deepEqual(
      record.calls.map(c => c.tool),
      ['unknown', 'unknown'],
    )
  })

  test('no argument or result value reaches the line', () => {
    // The record holds only what runRecord copies from the typed fields: a stray field is dropped.
    const dirty = { ...call(), args: { token: SECRET }, value: SECRET, error: undefined } as unknown as CallLog
    const line = runLine(runRecord(input([dirty])))
    assert.equal(line.includes(SECRET), false, line)
    assert.equal(line.includes('args'), false, line)
  })

  test('lists at most MAX_CALLS calls and counts the rest', () => {
    const record = runRecord(input(Array.from({ length: MAX_CALLS + 5 }, () => call())))
    assert.equal(record.calls.length, MAX_CALLS)
    assert.equal(record.omitted, 5)
    assert.equal('omitted' in runRecord(input([call()])), false)
  })
})

describe('the decision of a call', () => {
  const policy = [
    { match: 'mcp__f__echo', action: 'allow' as const, index: 0 },
    { match: 'mcp__f__rm', action: 'deny' as const, index: 1 },
  ]
  test('names what the policy and the approval said', () => {
    const approved = new Set(['mcp__f__slow'])
    assert.equal(callDecision(policy, approved, 'mcp__f__echo'), 'allow')
    assert.equal(callDecision(policy, approved, 'mcp__f__rm'), 'denied')
    assert.equal(callDecision(policy, approved, 'mcp__f__slow'), 'ask-approved')
    assert.equal(callDecision(policy, approved, 'mcp__f__other'), 'unapproved')
    assert.equal(callDecision(policy, approved, 'Bash'), 'invalid')
  })
})

describe('rotation', () => {
  test('rotates only a file that has data and would pass the cap', () => {
    assert.equal(rotates(0, MAX_LOG_BYTES + 1), false)
    assert.equal(rotates(100, 50, 200), false)
    assert.equal(rotates(160, 50, 200), true)
    assert.equal(rotates(MAX_LOG_BYTES, 10), true)
  })

  test('the writer keeps one old file, with the folder 0700 and the file 0600 on POSIX', async () => {
    const home = path.join(ROOT, 'home')
    const errors: string[] = []
    const line = `${'x'.repeat(1024 * 1024)}\n`
    for (let i = 0; i < 7; i++) await appendRunLog(home, line, e => errors.push(e))
    assert.deepEqual(errors, [])
    const size = (f: string) => fs.statSync(f).size
    assert.ok(size(runLogFile(home)) <= MAX_LOG_BYTES)
    assert.ok(size(oldRunLogFile(home)) <= MAX_LOG_BYTES)
    assert.equal(size(oldRunLogFile(home)), 4 * line.length)
    assert.equal(size(runLogFile(home)), 3 * line.length)
    assert.deepEqual(fs.readdirSync(path.dirname(runLogFile(home))).sort(), ['runs.1.jsonl', 'runs.jsonl'])
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(runLogFile(home)).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.dirname(runLogFile(home))).mode & 0o777, 0o700)
    }
  })

  test('concurrent writers at the cap lose no record and log no error', async () => {
    const home = path.join(ROOT, 'busy')
    const dir = path.dirname(runLogFile(home))
    fs.mkdirSync(dir, { recursive: true })
    const filler = `${'f'.repeat(MAX_LOG_BYTES - 100)}\n`
    fs.writeFileSync(runLogFile(home), filler)
    const errors: string[] = []
    const lines = Array.from({ length: 20 }, (_, i) => `{"id":"run-${i}","pad":"${'p'.repeat(30)}"}\n`)
    await Promise.all(lines.map(line => appendRunLog(home, line, e => errors.push(e))))
    assert.deepEqual(errors, [])
    const kept = [oldRunLogFile(home), runLogFile(home)].map(f => fs.readFileSync(f, 'utf8')).join('')
    assert.equal(kept.includes(filler), true, 'the old history is kept')
    for (const line of lines) assert.equal(kept.includes(line), true, line)
  })

  test('a write failure logs one line and does not throw', async () => {
    const home = path.join(ROOT, 'blocked')
    fs.writeFileSync(home, 'a file, not a folder')
    const errors: string[] = []
    await appendRunLog(home, 'x\n', e => errors.push(e))
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /^cannot write the run log: /)
  })
})

describe('the log key of the config', () => {
  const parse = (value: unknown) =>
    parseConfig(JSON.stringify({ mcpServers: {}, ...(value as object) }), {}, '/n', 'linux')
  test('is on by default, and false turns it off', () => {
    const on = parse({})
    assert.ok(on.ok && on.config.log)
    const explicit = parse({ log: true })
    assert.ok(explicit.ok && explicit.config.log)
    const off = parse({ log: false })
    assert.ok(off.ok && !off.config.log)
  })

  test('a value that is not a boolean is an error that names the key', () => {
    const bad = parse({ log: 'no' })
    assert.deepEqual(!bad.ok && bad.errors, ['log: must be true or false, not "no"'])
  })
})
