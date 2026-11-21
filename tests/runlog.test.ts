// The run log: the shape of a line, that no value leaks into it, the rotation
// and the `log` key of the config. The host writer runs against a temp HOME.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig, type ServerKey } from '../src/core/config.ts'
import { oldRunLogFile, runLogFile } from '../src/core/paths.ts'
import {
  MAX_CALLS,
  MAX_LOG_BYTES,
  CALL_CLASSES,
  callDecision,
  classifyCallError,
  parseRunLine,
  parseSince,
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
  const NO_BRIDGES = new Set<ServerKey>()
  const policy = [
    { match: 'mcp__f__echo', action: 'allow' as const, index: 0 },
    { match: 'mcp__f__rm', action: 'deny' as const, index: 1 },
  ]
  test('names what the policy and the approval said', () => {
    const approved = new Set(['mcp__f__slow'])
    const none = new Set<string>()
    assert.equal(callDecision(policy, NO_BRIDGES, approved, 'mcp__f__echo', none), 'allow')
    assert.equal(callDecision(policy, NO_BRIDGES, approved, 'mcp__f__rm', none), 'denied')
    assert.equal(callDecision(policy, NO_BRIDGES, approved, 'mcp__f__slow', none), 'ask-approved')
    assert.equal(callDecision(policy, NO_BRIDGES, approved, 'mcp__f__other', none), 'unapproved')
    assert.equal(callDecision(policy, NO_BRIDGES, approved, 'Bash', none), 'invalid')
  })

  test('an allow rule does not count as approval of a tool whose server requires a person', () => {
    const marked = new Set(['mcp__f__echo', 'mcp__f__rm'])
    assert.equal(callDecision(policy, NO_BRIDGES, new Set(), 'mcp__f__echo', marked), 'unapproved')
    assert.equal(callDecision(policy, NO_BRIDGES, new Set(['mcp__f__echo']), 'mcp__f__echo', marked), 'ask-approved')
    assert.equal(callDecision(policy, NO_BRIDGES, new Set(), 'mcp__f__rm', marked), 'denied')
  })

  test('the log names a call of a bridge tool under an allow rule for every server as unapproved', () => {
    const all = [{ match: '*', action: 'allow' as const, index: 0 }]
    const bridges = new Set(['f' as ServerKey])
    assert.equal(callDecision(all, bridges, new Set(), 'mcp__f__echo', new Set()), 'unapproved')
    assert.equal(callDecision(all, NO_BRIDGES, new Set(), 'mcp__f__echo', new Set()), 'allow')
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

describe('the time of runs --since', () => {
  const now = new Date('2026-11-18T12:00:00.000Z')
  const since = (text: string) => parseSince(text, now)?.toISOString()

  test('a duration counts back from now', () => {
    assert.equal(since('30m'), '2026-11-18T11:30:00.000Z')
    assert.equal(since('2h'), '2026-11-18T10:00:00.000Z')
    assert.equal(since('1d'), '2026-11-17T12:00:00.000Z')
  })

  test('an ISO 8601 time needs a zone, and an offset moves it to UTC', () => {
    assert.equal(since('2026-11-18T09:30Z'), '2026-11-18T09:30:00.000Z')
    assert.equal(since('2026-11-18T18:30:15.5+09:00'), '2026-11-18T09:30:15.500Z')
    assert.equal(since('2024-02-29T00:00:00-05:30'), '2024-02-29T05:30:00.000Z')
  })

  test('make it fail: any other text, or a day or an hour that does not exist, is no time', () => {
    for (const text of [
      '',
      '0m',
      '30',
      '30s',
      '1w',
      ' 30m',
      '-30m',
      '1.5h',
      '2026-11-18',
      '2026-11-18T09:30:00',
      '2026-11-18 09:30:00Z',
      '2026-02-29T00:00Z',
      '2026-04-31T00:00Z',
      '2026-13-01T00:00Z',
      '2026-11-18T24:00Z',
      '2026-11-18T09:60Z',
      '2026-11-18T09:30:60Z',
      '2026-11-18T09:30+24:00',
      'yesterday',
    ])
      assert.equal(since(text), undefined, JSON.stringify(text))
  })
})

describe('the class of a call error', () => {
  // Hand-written texts in the shape of public servers, with made-up names.
  const TABLE: ReadonlyArray<[string, string, number?]> = [
    // validation
    ['validation', 'MCP error -32602: Invalid arguments for tool fake_tool'],
    ['validation', 'Input validation error: Invalid arguments for tool fake: [{"code":"invalid_type"}]'],
    ['validation', 'anything at all', -32602],
    [
      'validation',
      '[{"code":"invalid_enum_value","options":["a","b"],"message":"Invalid enum value. Expected \'a\' | \'b\'"}]',
    ],
    ['validation', 'Expected number, received string'],
    ['validation', 'Invalid input: expected string, received number'],
    ['validation', 'Invalid option: expected one of "open"|"closed"'],
    ['validation', '1 validation error for FakeToolArguments\nowner\n  Field required [type=missing, input_value={}]'],
    ['validation', "2 validation errors for FakeArgs\nstate\n  Input should be 'open' or 'closed'"],
    ['validation', 'data/count must be integer'],
    ['validation', "data must have required property 'owner'"],
    ['validation', 'data/state must be equal to one of the allowed values'],
    ['validation', 'missing required parameter: owner'],
    ['validation', 'parameter page is not of type float64, is string'],
    ['validation', 'Invalid parameter: repo'],
    ['validation', "'owner' is a required property"],
    ['validation', "'merged' is not one of ['open', 'closed']"],
    ['validation', 'failed to create issue: POST https://api.example.com/repos/o/r/issues: 422 Validation Failed []'],
    ['validation', 'request failed (HTTP 400)'],
    // rate-limit, before the status rule
    ['rate-limit', 'GET https://api.example.com/search: 403 API rate limit exceeded for user ID 1 []'],
    ['rate-limit', 'Too Many Requests'],
    ['rate-limit', 'request throttled, retry later'],
    ['rate-limit', 'status 429'],
    // status with a marker
    ['not-found', 'failed to get issue: GET https://api.example.com/repos/o/r/issues/1: 404 Not Found []'],
    ['not-found', 'status code: 410'],
    ['auth', 'transport failed (HTTP 401)'],
    ['auth', 'GET https://api.example.com/user: 403 Forbidden []'],
    ['timeout', 'HTTP 504'],
    ['timeout', '408 Request Timeout'],
    ['server', 'HTTP 502'],
    ['server', 'status 500'],
    ['not-found', 'HTTP error 404'],
    ['auth', 'statusCode: 403'],
    ['other', '409 Conflict'],
    ['other', 'a bare 404'],
    ['other', 'issue 404 was closed'],
    // the mixed sentence of Atlassian and Azure DevOps
    ['not-found', 'Issue does not exist or you do not have permission to see it.'],
    ['not-found', '{"errorMessages":["Issue does not exist or you do not have permission to see it."],"errors":{}}'],
    [
      'not-found',
      'The Git repository fake-repo does not exist or you do not have permissions for the operation you are attempting.',
    ],
    ['not-found', 'The resource does not exist, or you do not have permission to access it.'],
    // auth
    ['auth', 'TF400813: The user is not authorized to access this resource.'],
    ['auth', 'TF401027: You need the Git Read permission to perform this action.'],
    ['auth', 'Bad credentials'],
    ['auth', 'Resource not accessible by personal access token'],
    ['auth', 'access denied for this project'],
    // not-found
    ['not-found', 'Could not resolve to a Repository with the name o/r.'],
    ['not-found', 'no such file: notes.md'],
    ['not-found', 'work item 7 not found'],
    // timeout
    ['timeout', 'request timed out'],
    ['timeout', 'connect ETIMEDOUT 192.0.2.1:443'],
    // server
    ['server', 'upstream failed', -32603],
    ['server', 'Internal Server Error'],
    ['server', 'service unavailable'],
    // other
    ['other', 'mcp-remote: Incompatible auth server', -32001],
    ['other', 'something odd happened'],
    ['other', ''],
  ]

  for (const [want, text, code] of TABLE)
    test(`${want}: ${JSON.stringify(text.slice(0, 60))}${code === undefined ? '' : ` (code ${code})`}`, () => {
      assert.equal(classifyCallError(text, code), want)
    })

  test('only the first 4096 characters count, and case does not', () => {
    assert.equal(classifyCallError(`${'x'.repeat(4096)} 404 Not Found`), 'other')
    assert.equal(classifyCallError('RATE LIMIT'), 'rate-limit')
  })

  test('make it fail: a text of 1 MB and one built to backtrack classify at once', () => {
    assert.equal(classifyCallError('a'.repeat(1_000_000)), 'other')
    assert.equal(classifyCallError(`${'a'.repeat(50_000)}does not exist or`), 'other')
    assert.equal(classifyCallError(`${'a'.repeat(50_000)} http `), 'other')
    assert.equal(classifyCallError(`does not exist or ${'a'.repeat(50_000)}`), 'not-found')
  })

  test('never throws on a value that is not text', () => {
    assert.equal(classifyCallError(undefined as unknown as string), 'other')
    assert.equal(classifyCallError({ toString: () => 'rate limit' } as unknown as string), 'rate-limit')
  })

  test('make it fail: the line holds the class and none of the error text, status or code', () => {
    const text = `${SECRET}: 404 Not Found -32602`
    const cls = classifyCallError(text, -32602)
    const line = runLine(runRecord(input([call({ ok: false, error: 'tool-error', class: cls })])))
    assert.ok(line.includes('"class":"validation"'), line)
    for (const leak of [SECRET, '404', '32602', 'Not Found']) assert.equal(line.includes(leak), false, line)
  })

  test('runRecord writes a class only from the set and only beside tool-error or failed', () => {
    const cast = (o: Record<string, unknown>) => call(o as Partial<CallLog>)
    const written = (c: CallLog) => runRecord(input([c])).calls[0]!.class
    assert.equal(written(cast({ ok: false, error: 'tool-error', class: 'validation' })), 'validation')
    assert.equal(written(cast({ ok: false, error: 'failed', class: 'other' })), 'other')
    assert.equal(written(cast({ ok: false, error: 'tool-error', class: SECRET })), undefined)
    assert.equal(written(cast({ ok: false, error: 'tool-error', class: 5 })), undefined)
    for (const error of ['denied', 'timeout', 'cancelled', 'no-server', 'guarded', 'unfinished'])
      assert.equal(written(cast({ ok: false, error, class: 'auth' })), undefined, error)
    assert.equal(written(cast({ class: 'auth' })), undefined, 'an ok call')
    assert.deepEqual(Object.keys(runRecord(input([call()])).calls[0]!).sort(), ['decision', 'ms', 'ok', 'tool'])
    assert.equal(CALL_CLASSES.length, 7)
  })

  test('reads an old line as before, a later class as no class, and a wrong place as unreadable', () => {
    const line = (c: Record<string, unknown>) =>
      parseRunLine(
        JSON.stringify({ ...runRecord(input([])), calls: [{ tool: 'mcp__f__echo', decision: 'allow', ms: 1, ...c }] }),
      )
    const first = (c: Record<string, unknown>) => {
      const run = line(c)
      return run === 'unreadable' ? run : run.calls[0]
    }
    assert.deepEqual(first({ ok: false, error: 'tool-error' }), {
      tool: 'mcp__f__echo',
      decision: 'allow',
      ms: 1,
      ok: false,
      error: 'tool-error',
    })
    assert.deepEqual(first({ ok: false, error: 'failed', class: 'auth' }), {
      tool: 'mcp__f__echo',
      decision: 'allow',
      ms: 1,
      ok: false,
      error: 'failed',
      class: 'auth',
    })
    // A string outside the set is a class of a later version.
    assert.deepEqual(first({ ok: false, error: 'tool-error', class: 'quota' }), {
      tool: 'mcp__f__echo',
      decision: 'allow',
      ms: 1,
      ok: false,
      error: 'tool-error',
    })
    const unreadable = { unreadable: true, ok: false, tool: 'mcp__f__echo' }
    assert.deepEqual(first({ ok: true, class: 'auth' }), unreadable)
    assert.deepEqual(first({ ok: false, error: 'denied', class: 'auth' }), unreadable)
    assert.deepEqual(first({ ok: false, error: 'tool-error', class: 5 }), unreadable)
    assert.deepEqual(first({ ok: false, error: 'tool-error', class: null }), unreadable)
  })
})
