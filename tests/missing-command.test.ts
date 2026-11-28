// A stdio server whose command cannot start names the command in its reason (the spawn error, never an argument, a
// variable or the folder): in the state, in the "Not connected" line of search_tools and in the refusal of a call.
// A command that starts and exits keeps the reason of its exit. No real MCP client or server is needed: the missing
// commands are fake names, and the working server is tests/probe-server.mjs.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { searchResult, shownStates, type DownstreamTool } from '../src/core/catalog.ts'
import { serverKey, type ServerConfig, type ServerKey, type StdioServer } from '../src/core/config.ts'
import type { CachedList } from '../src/core/lazy.ts'
import { spawnReason, trustedSpawnError } from '../src/core/spawn.ts'
import { ChildTransport } from '../src/host/childtransport.ts'
import { findCommand } from '../src/host/commandfind.ts'
import { connectAll, type Downstream, type ToolsStore } from '../src/host/downstream.ts'

const PROBE = path.join(import.meta.dirname, 'probe-server.mjs')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-missing-command-'))
const KEY = serverKey('gone')!
const GOOD = serverKey('good')!
const BAD_EXIT = serverKey('exits')!
const opened: Downstream[] = []
after(async () => {
  await Promise.all(opened.map(d => d.close()))
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 })
})

const MARK_ARG = 'MARK-ARG'
const MARK_ENV = 'MARK-ENV'
const missing = (command: string): StdioServer => ({
  kind: 'stdio',
  command,
  args: [MARK_ARG],
  env: { T: MARK_ENV },
})
const bareName = (): string => `toolscript-no-such-${randomUUID().slice(0, 8)}`

const start = (servers: [ServerKey, ServerConfig][], options = {}) => {
  const logs: string[] = []
  const downstream = connectAll(new Map(servers), '0', line => logs.push(line), options)
  opened.push(downstream)
  return { downstream, logs }
}

const reasonOf = (downstream: Downstream, key: ServerKey = KEY): string | undefined => {
  const state = downstream.states().find(s => s.key === key)
  return state?.status === 'failed' ? state.reason : state?.status
}

describe('a command that cannot start', () => {
  test('a bare name: the state, the search line and the refusal name the command, and no argument or variable shows', async () => {
    const command = bareName()
    const reason = `its command was not found on PATH: ${command}`
    const { downstream, logs } = start([[KEY, missing(command)]])
    await downstream.settled
    assert.equal(reasonOf(downstream), reason)
    const search = searchResult(shownStates(downstream.states()), 'zzzqq', 10)
    assert.ok(search.includes(`\n- ${KEY}: ${reason}`), search)
    const link = await downstream.client(KEY)
    assert.deepEqual(link, { ok: false, reason: `the MCP server "${KEY}" is not connected: ${reason}` })
    const text = [JSON.stringify(downstream.states()), search, JSON.stringify(link), ...logs].join('\n')
    for (const secret of [MARK_ARG, MARK_ENV]) assert.ok(!text.includes(secret), `no ${secret}`)
    assert.ok(!text.includes('Connection closed'))
  })

  test('the same reason 20 times, whichever of the error and the close comes first', async () => {
    for (let i = 0; i < 20; i++) {
      const command = bareName()
      const { downstream } = start([[KEY, missing(command)]])
      await downstream.settled
      assert.equal(reasonOf(downstream), `its command was not found on PATH: ${command}`)
      await downstream.close()
    }
  })

  test('an absolute path that does not exist says that the file was not found', async () => {
    const command = path.join(DIR, 'no', 'such', 'tool')
    const { downstream } = start([[KEY, missing(command)]])
    await downstream.settled
    assert.equal(reasonOf(downstream), `its command file was not found: ${command}`)
  })

  test('the reason shows only the command: a long one is cut, and a control character is escaped', () => {
    assert.equal(spawnReason('bad\nname', 'ENOENT'), 'its command was not found on PATH: bad\\u000aname')
    const long = spawnReason(`x${'a'.repeat(300)}`, 'ENOENT')
    assert.equal(long.length, 'its command was not found on PATH: '.length + 200)
    assert.equal(spawnReason('/bin/x', 'EACCES'), 'its command could not start (EACCES): /bin/x')
    assert.equal(spawnReason('x', 'E$C'), 'its command could not start (EC): x')
  })

  test('a lazy server shows no reason in a search and starts nothing; the first call that names it gets the refusal', async () => {
    const command = bareName()
    const reason = `its command was not found on PATH: ${command}`
    const tool: DownstreamTool = { name: 'probe', description: 'x', inputSchema: { type: 'object', properties: {} } }
    const cached = new Map<string, CachedList>()
    const store: ToolsStore = {
      key: s => JSON.stringify([s.command, s.args]),
      load: async () => new Map(cached),
      save: async () => {},
    }
    cached.set(JSON.stringify([command, [MARK_ARG]]), { at: 1, tools: [tool] })
    const { downstream, logs } = start([[KEY, { ...missing(command), lazy: true }]], {
      lazy: { bridges: new Set<ServerKey>(), idleMs: 500, cache: store },
    })
    await downstream.settled
    assert.equal(downstream.states()[0]?.status, 'asleep')
    const search = searchResult(shownStates(downstream.states()), 'zzzqq', 10)
    assert.ok(!search.includes('Not connected') && !search.includes(command), 'a search shows no reason')
    const refusal = `the MCP server "${KEY}" is not connected: ${reason}`
    for (let call = 1; call <= 2; call++) assert.deepEqual(await downstream.client(KEY), { ok: false, reason: refusal })
    // The 3rd start reaches the cap of 3 in 60 s, and says when the next one may come. The 4th call starts nothing, and
    // its refusal still names the command.
    for (let call = 3; call <= 4; call++) {
      const capped = await downstream.client(KEY)
      assert.ok(
        !capped.ok && capped.reason.startsWith(`${refusal}. toolscript-mcp tries again`),
        JSON.stringify(capped),
      )
    }
    const text = logs.join('\n')
    assert.ok(!text.includes(MARK_ARG) && !text.includes(MARK_ENV))
  })

  test('a working server answers in the same run, and a command that starts and exits keeps the reason of its exit', async () => {
    const file = path.join(DIR, `${randomUUID()}.json`)
    const good: StdioServer = { kind: 'stdio', command: process.execPath, args: [PROBE, file], env: {} }
    const exits: StdioServer = { kind: 'stdio', command: process.execPath, args: ['-e', 'process.exit(1)'], env: {} }
    const { downstream } = start([
      [GOOD, good],
      [KEY, missing(bareName())],
      [BAD_EXIT, exits],
    ])
    await downstream.settled
    assert.equal(reasonOf(downstream, GOOD), 'connected')
    const link = await downstream.client(GOOD)
    assert.ok(link.ok)
    assert.ok(reasonOf(downstream)?.startsWith('its command was not found on PATH: '))
    const exited = reasonOf(downstream, BAD_EXIT)
    assert.ok(exited !== 'connected' && !exited?.includes('its command'), `an exit is not a spawn error: ${exited}`)
  })

  test('on Windows the ENOENT of cross-spawn is trusted only when no file for the command is found', () => {
    const guess = Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT', errno: 'ENOENT', syscall: 'spawn x' })
    const own = Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT', errno: -4058, syscall: 'spawn x' })
    assert.equal(
      trustedSpawnError(guess, 'win32', () => false),
      true,
      'no file: not found',
    )
    assert.equal(
      trustedSpawnError(guess, 'win32', () => true),
      false,
      'a file: the command started',
    )
    assert.equal(
      trustedSpawnError(own, 'win32', () => true),
      true,
      'the OS said it',
    )
    assert.equal(
      trustedSpawnError(guess, 'linux', () => true),
      true,
      'cross-spawn guesses on Windows only',
    )
  })

  test('the look finds a file with a PATHEXT extension in a PATH folder, a path as it is, and nothing else', () => {
    const dir = fs.mkdtempSync(path.join(DIR, 'look-'))
    fs.writeFileSync(path.join(dir, 'alias.CMD'), '')
    const env = { Path: dir, PATHEXT: '.EXE;.CMD' }
    assert.equal(findCommand('alias', env, DIR), true)
    assert.equal(findCommand(path.join(dir, 'alias'), env, DIR), true)
    assert.equal(findCommand('other', env, DIR), false)
    assert.equal(findCommand('alias', { PATH: '' }, DIR), false)
  })

  test(
    'a command that cross-spawn cannot resolve but a file exists for keeps no spawn reason',
    { skip: process.platform !== 'win32' && 'the ENOENT of cross-spawn is a guess on Windows only' },
    async () => {
      const transport = (find: () => boolean) => {
        const t = new ChildTransport({ command: bareName(), args: [], env: {}, find })
        const ended = new Promise<void>(resolve => (t.onclose = resolve))
        return { t, ended }
      }
      const found = transport(() => true)
      await found.t.start().catch(() => {})
      await found.ended
      assert.equal(found.t.spawnReason, undefined, 'the command may have started')
      const none = transport(() => false)
      await none.t.start().catch(() => {})
      await none.ended
      assert.ok(none.t.spawnReason?.startsWith('its command was not found on PATH: '))
    },
  )

  // A Windows app execution alias that exits with 1 (a Python that crashed at its start) is what cross-spawn calls ENOENT.
  const alias = process.platform === 'win32' && findCommand('python3', process.env as Record<string, string>)
  test(
    'a real app execution alias that exits with 1 keeps the reason of its exit',
    { skip: alias !== true && 'no python3 alias on this machine' },
    async () => {
      const server: StdioServer = {
        kind: 'stdio',
        command: 'python3',
        args: ['-c', 'import toolscript_no_such_module'],
        env: {},
      }
      const { downstream } = start([[KEY, server]])
      await downstream.settled
      const reason = reasonOf(downstream)
      assert.ok(reason !== 'connected' && !reason?.includes('its command was not found'), String(reason))
      // The traceback of the crashed Python is on stderr: today's hint to read it stays.
      assert.ok(reason?.includes('Its stderr is not shown here'), String(reason))
    },
  )
})
