import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClientFile } from '../src/core/init.ts'
import { NPX_LAUNCH } from '../src/core/config.ts'
import { readCodexClient, type CodexLimits, type FileRead } from '../src/host/codex.ts'
import { runInit } from '../src/host/init.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-0.172.0')
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-read-')))
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const SECRET_OUTPUT = 'fake-output-secret-xyz'

/**
 * A fake Codex CLI: a Node script behind a shim, as the real one is (codex.cmd on Windows). It answers from the JSON that
 * the real Codex 0.172.0 printed for a fake CODEX_HOME, and logs its folder, its CODEX_HOME and its arguments. It runs no
 * loop: the hang is one timer.
 */
const SCRIPT = `
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: fs.realpathSync.native(process.cwd()), home: process.env.CODEX_HOME, args }) + '\\n')
const mode = process.env.FAKE_MODE ?? 'ok'
const dir = process.env.FAKE_FIXTURES
if (mode === 'fail') process.exit(3)
if (mode === 'hang') setTimeout(() => {}, 12_000)
else if (mode === 'huge') process.stdout.write('x'.repeat(5_000_000))
else if (mode === 'garbage') process.stdout.write(process.env.FAKE_OUTPUT)
else if (args[1] === 'list') process.stdout.write(fs.readFileSync(path.join(dir, 'list.json')))
else if (mode === 'getfail') process.exit(4)
else process.stdout.write(fs.readFileSync(path.join(dir, 'get-' + args[2].replaceAll(' ', '-') + '.json')))
`

let count = 0
const fakeCodex = (): string => {
  const bin = path.join(dir, 'bin' + count++)
  fs.mkdirSync(bin)
  const script = path.join(bin, 'codex.mjs')
  fs.writeFileSync(script, SCRIPT)
  if (process.platform === 'win32')
    fs.writeFileSync(path.join(bin, 'codex.cmd'), `@"${process.execPath}" "${script}" %*\r\n`)
  else fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  return bin
}

/** A fake home with the config.toml of the fixture, a project folder, and the env that finds the fake CLI. */
const setup = (mode: string, withCli = true) => {
  const root = fs.mkdtempSync(path.join(dir, 'case-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true })
  fs.copyFileSync(path.join(FIXTURES, 'config.toml'), path.join(home, '.codex', 'config.toml'))
  fs.writeFileSync(path.join(project, '.codex', 'config.toml'), '[mcp_servers.projectonly]\ncommand = "x"\n')
  const log = path.join(root, 'log.jsonl')
  fs.writeFileSync(log, '')
  const env = {
    PATH: withCli ? fakeCodex() : path.join(root, 'empty'),
    ...(process.platform === 'win32' && {
      SystemRoot: process.env.SystemRoot ?? '',
      ComSpec: process.env.ComSpec ?? '',
      PATHEXT: process.env.PATHEXT ?? '.CMD;.EXE',
    }),
    FAKE_LOG: log,
    FAKE_MODE: mode,
    FAKE_FIXTURES: FIXTURES,
    FAKE_OUTPUT: SECRET_OUTPUT,
  }
  const file: ClientFile = { client: 'codex', path: path.join(home, '.codex', 'config.toml') }
  const calls = () =>
    fs
      .readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { cwd: string; home: string; args: string[] })
  return { root, home, project, env, file, calls }
}

const readText = async (file: string): Promise<FileRead> =>
  fs.existsSync(file) ? { kind: 'text', text: fs.readFileSync(file, 'utf8') } : { kind: 'missing' }

const LIMITS: CodexLimits = { timeoutMs: 5000, maxBytes: 100_000, maxServers: 64 }

const read = async (s: ReturnType<typeof setup>, limits = LIMITS) => {
  const result = await readCodexClient(s.file, s.env, s.home, s.project, readText, limits)
  assert.equal(result.client, 'codex')
  return result
}

const namesOf = (r: Awaited<ReturnType<typeof read>>) => (r.kind === 'codex' ? r.servers.map(([n]) => n) : [])

describe('the Codex read of init, with a fake codex on PATH and a fake CODEX_HOME', () => {
  test('path A: list, then get for each server, in the home folder and with no shell', async () => {
    const s = setup('ok')
    const r = await read(s)
    assert.equal(r.kind, 'codex')
    assert.deepEqual(namesOf(r), ['docs', 'files', 'hdr', 'oauthy', 'off', 'with space'])
    const calls = s.calls()
    assert.deepEqual(calls[0]!.args, ['mcp', 'list', '--json'])
    assert.deepEqual(
      calls
        .slice(1)
        .map(c => c.args[2])
        .sort(),
      ['docs', 'files', 'hdr', 'oauthy', 'off', 'with space'],
    )
    for (const c of calls) {
      // The folder is the home folder, never the project, so Codex does not load the .codex/config.toml of the project.
      assert.equal(c.cwd, fs.realpathSync.native(s.home))
      assert.notEqual(c.cwd, fs.realpathSync.native(s.project))
      assert.equal(c.home, path.join(s.home, '.codex'))
    }
    const docs = r.kind === 'codex' ? r.servers.find(([n]) => n === 'docs')![1] : undefined
    assert.ok(docs && 'fields' in docs)
    assert.deepEqual(docs.fields.enabled_tools, ['a', 'b'])
    assert.equal(docs.authStatus, 'bearer_token')
    assert.equal(docs.via, 'codex')
    assert.ok(!namesOf(r).includes('projectonly'))
  })

  test('path A: the keys of config.toml that get --json does not show are listed, or one fixed line names them', async () => {
    const s = setup('ok')
    const toml = fs
      .readFileSync(s.file.path, 'utf8')
      .replace('startup_timeout_sec = 20', 'startup_timeout_sec = 20\nrequired = true\nscopes = ["a"]')
    fs.writeFileSync(s.file.path, toml + '\n[mcp_servers.docs.oauth]\nclient_id = "x"\n')
    const r = await read(s)
    assert.equal(r.kind, 'codex')
    const raw = (name: string) => (r.kind === 'codex' ? r.servers.find(([n]) => n === name)![1] : undefined)
    const docs = raw('docs')
    assert.ok(docs && 'fields' in docs)
    assert.deepEqual(docs.unseen, ['oauth', 'required', 'scopes'])
    const files = raw('files')
    assert.ok(files && 'fields' in files && files.unseen === undefined)
    assert.ok(!r.notes?.some(n => n.includes('does not show these keys')), String(r.notes))
    // No config.toml, or one that cannot be read: one fixed line that names the keys.
    for (const text of [undefined, '[mcp_servers.a]\ncommand = "x" junk\n']) {
      const t = setup('ok')
      if (text === undefined) fs.rmSync(t.file.path)
      else fs.writeFileSync(t.file.path, text)
      const none = await read(t)
      assert.equal(none.kind, 'codex')
      const line = none.notes?.find(n => n.includes('does not show these keys'))
      assert.ok(line, String(none.notes))
      for (const key of [
        'scopes',
        'oauth',
        'oauth_resource',
        'default_tools_approval_mode',
        'tools',
        'required',
        'supports_parallel_tool_calls',
        'omit_tools_from',
        'auth',
        'environment_id',
      ])
        assert.ok(line.includes(key), key)
    }
  })

  test('the report says that init did not read the project .codex/config.toml', async () => {
    const r = await read(setup('ok'))
    assert.ok(
      r.notes?.some(n => n.includes('init did not read') && n.includes('.codex')),
      String(r.notes),
    )
  })

  test('no codex on PATH: config.toml is read, with no problem line', async () => {
    const s = setup('ok', false)
    const r = await read(s)
    assert.equal(r.kind, 'codex')
    assert.deepEqual(namesOf(r).sort(), ['docs', 'files', 'hdr', 'oauthy', 'off', 'with space'])
    assert.deepEqual(s.calls(), [])
    assert.ok(r.notes?.every(n => !n.includes('codex mcp')))
    assert.ok(r.kind === 'codex' && r.servers.every(([, raw]) => 'skip' in raw || raw.via === 'config.toml'))
  })

  test('an env with no PATH starts no codex, and a missing config.toml is no file', async () => {
    const s = setup('ok')
    fs.rmSync(s.file.path)
    const r = await readCodexClient(s.file, { ...s.env, PATH: '' }, s.home, s.project, readText, LIMITS)
    assert.equal(r.kind, 'missing')
    assert.deepEqual(s.calls(), [])
  })

  for (const [mode, why] of [
    ['fail', /codex mcp list --json: exit code 3\. init read .* instead\.$/],
    ['getfail', /codex mcp get: exit code 4\. init read .* instead\.$/],
    ['garbage', /codex mcp list --json: the output is not the expected JSON\. init read .* instead\.$/],
  ] as const)
    test(`path A fails (${mode}): one note, then config.toml, and the output of codex is not echoed`, async () => {
      const s = setup(mode)
      const r = await read(s)
      assert.equal(r.kind, 'codex')
      assert.deepEqual(namesOf(r).sort(), ['docs', 'files', 'hdr', 'oauthy', 'off', 'with space'])
      const notes = (r.notes ?? []).filter(n => n.includes('codex mcp'))
      assert.equal(notes.length, 1, String(r.notes))
      assert.match(notes[0]!, why)
      assert.ok(!JSON.stringify(r.notes).includes(SECRET_OUTPUT))
    })

  test('a codex that hangs is cut at the limit and its tree ends', async () => {
    const s = setup('hang')
    const start = Date.now()
    const r = await read(s, { ...LIMITS, timeoutMs: 700 })
    assert.ok(Date.now() - start < 6000, 'init waited for the hang')
    assert.equal(r.kind, 'codex')
    assert.ok(
      r.notes?.some(n => /codex mcp list --json: no answer in 700 ms\./.test(n)),
      String(r.notes),
    )
  })

  test('a codex that prints more than the cap is cut at the cap', async () => {
    const s = setup('huge')
    const r = await read(s, { ...LIMITS, maxBytes: 100_000 })
    assert.ok(
      r.notes?.some(n => /more than 100000 bytes of output/.test(n)),
      String(r.notes),
    )
    assert.ok(!JSON.stringify(r.notes).includes('xxxx'))
  })

  test('more servers than the cap: the first ones are read, with a note', async () => {
    const r = await read(setup('ok'), { ...LIMITS, maxServers: 2 })
    assert.deepEqual(namesOf(r), ['docs', 'files'])
    assert.ok(
      r.notes?.some(n => n.includes('first 2 Codex servers')),
      String(r.notes),
    )
  })

  test('a config.toml that cannot be split gives no server, and one over 1 MB too', async () => {
    const s = setup('ok', false)
    fs.writeFileSync(s.file.path, '[mcp_servers.a]\ncommand = "x" junk\n')
    const bad = await read(s)
    assert.equal(bad.kind, 'unreadable')
    fs.writeFileSync(s.file.path, '[mcp_servers.a]\ncommand = "' + 'x'.repeat(5 * 1024 * 1024) + '"\n')
    const big = await read(s)
    assert.deepEqual(big.kind === 'unreadable' && big.error, 'the file is larger than 1 MB')
  })

  test('init imports through the fake codex: the masked dry run shows no literal value', async () => {
    const s = setup('ok')
    let out = ''
    const code = await runInit(
      ['--dry-run', '--config', path.join(s.root, 'cfg', 'config.json')],
      s.env,
      process.platform,
      s.home,
      text => (out += text + '\n'),
      NPX_LAUNCH,
    )
    assert.equal(code, 0, out)
    for (const secret of ['literal-secret-value', 'literal-header-secret', SECRET_OUTPUT])
      assert.ok(!out.includes(secret), secret)
    assert.match(out, /Codex/)
    assert.ok(s.calls().length > 0, 'init did not start the fake codex')
  })
})
