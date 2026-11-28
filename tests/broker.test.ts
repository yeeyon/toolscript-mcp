// The broker (issue #63): the pure wire in src/core/broker.ts, then a real broker started in this process with a temp
// HOME, real sockets and the children of tests/pid-server.mjs. The broker bundle and the spawn are tested in
// tests/broker.integration.mjs, which needs `npm run build`.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  brokerSide,
  endpointOf,
  entryText,
  hostSide,
  idleMs,
  lineSplitter,
  parseEntry,
  PROOF_BYTES,
  PROOF_CONNECTIONS,
  resolvePath,
  SOCKET_MAX_BYTES,
  utf8Length,
  type Crypto,
  type Entry,
} from '../src/core/broker.ts'
import { brokerFolder } from '../src/core/paths.ts'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { PROBE_VERSION, startBroker, takeLock, type Broker, type BrokerOptions } from '../src/host/broker.ts'
import { BrokerError, BrokerTransport, idOf, openLink } from '../src/host/brokerlink.ts'
import { alive, serverEntry, staleSocket, text, until } from './broker-rig.ts'
import {
  buildId,
  endpointFor,
  folderProblem,
  loadKey,
  makeCrypto,
  parseStderr,
  stderrFrames,
} from '../src/host/brokerwire.ts'

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-broker-test-')))
const closers: (() => Promise<void> | void)[] = []
after(async () => {
  for (const close of closers.reverse()) await close()
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('the endpoint', () => {
  const mac = 'ab12cd34ef56'.repeat(5)
  test('a normal home keeps the socket in the broker folder, a long one moves it to a short folder of the user', () => {
    const near = endpointOf('linux', '/Users/someone', mac, 501)
    assert.equal(near, '/Users/someone/.toolscript-mcp/broker/tsm-ab12cd34ef56.sock')
    const far = endpointOf(
      'darwin',
      '/var/folders/7h/k3gr5wsx5d1ftd7rz5j0nsbr0000gn/T/toolscript-memory-test-AbCdEf/home',
      mac,
      501,
    )
    assert.equal(far, '/tmp/tsm-501/tsm-ab12cd34ef56.sock')
    assert.ok(Buffer.byteLength(far) <= SOCKET_MAX_BYTES)
    assert.equal(utf8Length('aé€😀'), Buffer.byteLength('aé€😀'))
  })
  test('Windows has a pipe whatever the home', () => {
    assert.equal(endpointOf('win32', 'C:\\x'.repeat(40), mac, 0), '\\\\.\\pipe\\toolscript-mcp-ab12cd34ef56')
  })
  test('a socket folder that is a file or a link gets a reason with no path, and a missing one none', () => {
    const base = fs.mkdtempSync(path.join(root, 'sock-'))
    const file = path.join(base, 'file')
    fs.writeFileSync(file, '')
    const link = path.join(base, 'link')
    fs.symlinkSync(base, link, 'junction')
    assert.equal(folderProblem(path.join(base, 'missing')), undefined)
    assert.equal(folderProblem(base), undefined)
    const want = process.platform === 'win32' ? undefined : 'is a link or a file, not a folder'
    assert.equal(folderProblem(file), want)
    assert.equal(folderProblem(link), want)
  })
})

describe('the pure wire', () => {
  const fake = (key: string): Crypto => {
    let n = 0
    return {
      mac: text => crypto.createHmac('sha256', key).update(text).digest('hex'),
      nonce: () => (++n).toString(16).padStart(32, '0'),
      same: (a, b) => a === b,
    }
  }
  /** Runs both sides against each other, with a hook to change a frame in flight. */
  const run = (host: Crypto, broker: Crypto, change: (frame: string, from: 'host' | 'broker') => string = f => f) => {
    const h = hostSide(host)
    const b = brokerSide(broker)
    let toBroker = change(h.start(), 'host')
    for (let i = 0; i < 6; i++) {
      const stepB = b.step(toBroker.trim())
      if (stepB.fail !== undefined) return { failed: 'broker', why: stepB.fail }
      const stepH = h.step(change(stepB.send ?? '', 'broker').trim())
      if (stepH.fail !== undefined) return { failed: 'host', why: stepH.fail }
      if (stepB.done) return { failed: undefined, hostDone: false }
      toBroker = change(stepH.send ?? '', 'host')
      if (stepH.done) return { failed: undefined, hostDone: true }
    }
    return { failed: 'loop', why: '' }
  }

  test('a host and a broker with the same key finish the handshake', () => {
    const r = run(fake('k'), fake('k'))
    assert.equal(r.failed, undefined)
  })

  test('a wrong key fails on the host side first, so the host sends no proof', () => {
    const r = run(fake('a'), fake('b'))
    assert.deepEqual(r, { failed: 'host', why: 'the peer did not prove the key' })
  })

  test('a broker proof cannot stand in for the host proof (reflection)', () => {
    const broker = brokerSide(fake('k'))
    const hello = broker.step(`{"t":"hello","v":2,"n":"${'a'.repeat(32)}"}`)
    const frame = JSON.parse(hello.send!) as { n: string; p: string }
    // The attacker sends the broker's own proof back as the host proof.
    assert.equal(broker.step(JSON.stringify({ t: 'proof', p: frame.p })).fail, 'wrong proof')
  })

  test('a recorded proof does not pass with fresh nonces (replay)', () => {
    const first = brokerSide(fake('k'))
    first.step(`{"t":"hello","v":2,"n":"${'a'.repeat(32)}"}`)
    const hostProof = fake('k').mac(`toolscript-mcp 2 host ${'a'.repeat(32)} ${'00000000000000000000000000000001'}`)
    assert.equal(first.step(JSON.stringify({ t: 'proof', p: hostProof })).done, true, 'the true proof passes once')
    const crypto2 = fake('k')
    crypto2.nonce()
    const second = brokerSide(crypto2)
    second.step(`{"t":"hello","v":2,"n":"${'a'.repeat(32)}"}`)
    assert.equal(second.step(JSON.stringify({ t: 'proof', p: hostProof })).fail, 'wrong proof')
  })

  test('a bad hello, a bad version and a proof with no hello fail', () => {
    for (const line of ['x', '{}', '{"t":"hello","v":1,"n":"' + 'a'.repeat(32) + '"}', '{"t":"proof","p":"x"}'])
      assert.ok(brokerSide(fake('k')).step(line).fail, line)
  })

  test('parseEntry takes one entry shape and gives a reason for the rest', () => {
    const good = { t: 'entry', command: 'c', args: ['a'], env: { A: '1' }, folder: '/f' }
    assert.deepEqual(parseEntry(good), { command: 'c', args: ['a'], env: { A: '1' }, folder: '/f' })
    for (const bad of [
      null,
      {},
      { ...good, t: 'x' },
      { ...good, args: [1] },
      { ...good, env: { A: 1 } },
      { ...good, folder: '' },
    ])
      assert.equal(typeof parseEntry(bad), 'string')
  })

  test('the share key text differs on env, args and folder, and not on env key order', () => {
    const e = (over: Partial<Entry> = {}): Entry => ({
      command: 'c',
      args: ['a'],
      env: { A: '1', B: '2' },
      folder: '/f',
      ...over,
    })
    assert.equal(entryText(e()), entryText(e({ env: { B: '2', A: '1' } })))
    for (const other of [e({ env: { A: '1', B: '3' } }), e({ args: ['b'] }), e({ folder: '/g' }), e({ command: 'd' })])
      assert.notEqual(entryText(e()), entryText(other))
  })

  test('the idle time reads only a number of 1000 or more', () => {
    assert.equal(idleMs('5000'), 5000)
    for (const bad of [undefined, '', '999', '-1', 'x', '1e3']) assert.equal(idleMs(bad), 600_000)
  })

  test('the line splitter joins chunks and drops empty lines', () => {
    const got: string[] = []
    const feed = lineSplitter(l => got.push(l))
    feed('a')
    feed('b\n\nc')
    feed('\n')
    assert.deepEqual(got, ['ab', 'c'])
  })

  test('the line splitter does linear work on a long line and stops at the cap', () => {
    const got: string[] = []
    const feed = lineSplitter(
      l => got.push(l),
      () => Infinity,
    )
    const chunk = 'x'.repeat(16 * 1024)
    const start = performance.now()
    for (let i = 0; i < 1280; i++) feed(chunk) // 20 MB with no newline
    feed('\n')
    assert.ok(performance.now() - start < 1000, 'a quadratic splitter takes more than a second here')
    assert.equal(got.length, 1)
    assert.equal(got[0]!.length, 1280 * chunk.length)

    let over = 0
    const capped = lineSplitter(
      l => got.push(l),
      () => 10,
      () => over++,
    )
    capped('12345\n')
    capped('abcde')
    capped('fghij')
    assert.equal(over, 0, 'a line of 10 is allowed')
    capped('k')
    capped('\nlater\n')
    assert.equal(over, 1)
    assert.equal(got.at(-1), '12345')
    assert.ok(!got.includes('later'), 'nothing is read after the overflow')
    const whole = lineSplitter(
      l => got.push(l),
      () => 3,
      () => over++,
    )
    whole('abcdefg\n')
    assert.equal(over, 2, 'a complete line over the cap also overflows')
  })

  test('PATH: each entry is resolved, repeats go, and one folder through two links is one entry', () => {
    const real = (e: string) => (e.startsWith('/shell-') ? '/real/node' : undefined)
    assert.equal(resolvePath('/shell-1:/usr/bin:/shell-2:/usr/bin', ':', real, false), '/real/node:/usr/bin')
    assert.equal(resolvePath('/shell-1:/a', ':', real, false), resolvePath('/shell-2:/a', ':', real, false))
    assert.notEqual(
      resolvePath('/node20:/a', ':', () => undefined, false),
      resolvePath('/node22:/a', ':', () => undefined, false),
    )
    assert.equal(
      resolvePath('C:\\A;c:\\a', ';', () => undefined, true),
      'C:\\A',
    )
    assert.equal(
      resolvePath('C:\\A;c:\\a', ';', () => undefined, false),
      'C:\\A;c:\\a',
    )
  })
})

type Rig = { home: string; file: string; broker: Broker; stop: () => Promise<void> }

/** A broker in this process, on a temp HOME, whose build is the content of a temp file. */
const startRig = async (
  idle = 600_000,
  build = 'build one',
  initMs?: number,
  extra: Partial<BrokerOptions> = {},
): Promise<Rig> => {
  const home = fs.mkdtempSync(path.join(root, 'h-'))
  const file = path.join(home, 'broker.js')
  fs.writeFileSync(file, build)
  const broker = await startBroker({ home, idleMs: idle, file, ...(initMs !== undefined && { initMs }), ...extra })
  assert.ok(broker, 'the broker listens')
  const stop = () => broker.stop()
  closers.push(stop)
  return { home, file, broker, stop }
}

const entryOf = (env: Record<string, string> = {}, args: string[] = [], command = process.execPath): Entry =>
  serverEntry(root, env, args, command)

const clients: Client[] = []
const connect = async (rig: Rig, entry: Entry = entryOf(), onStderr?: (chunk: Buffer) => void): Promise<Client> => {
  const client = new Client({ name: 'test', version: '0' })
  clients.push(client)
  await client.connect(
    new BrokerTransport({ home: rig.home, brokerFile: rig.file, entry, ...(onStderr && { onStderr }) }),
  )
  return client
}
after(async () => {
  for (const c of clients) await c.close().catch(() => {})
})

const closed = (socket: net.Socket): Promise<number> =>
  new Promise(resolve => {
    const start = Date.now()
    socket.on('close', () => resolve(Date.now() - start))
    socket.on('error', () => {})
  })

describe('attach and routing', () => {
  test('a link lists the tools and calls one, as it would on a direct child', async () => {
    const rig = await startRig()
    const client = await connect(rig)
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map(t => t.name),
      ['pid', 'env', 'cwd', 'sleep', 'exit', 'grow', 'flood', 'swell', 'forge', 'big', 'noise'],
    )
    assert.match(await text(client, 'pid'), /^\d+$/)
    assert.equal(await text(client, 'cwd'), root)
  })

  test('two links of one entry share one child, and another env value gets its own child', async () => {
    const rig = await startRig()
    const [a, b, c] = [await connect(rig), await connect(rig), await connect(rig, entryOf({ ZONE: 'uat' }))]
    const pids = [await text(a, 'pid'), await text(b, 'pid'), await text(c, 'pid')]
    assert.equal(pids[0], pids[1])
    assert.notEqual(pids[0], pids[2])
    assert.equal(await text(c, 'env', { name: 'ZONE' }), 'uat')
    assert.equal(await text(a, 'env', { name: 'ZONE' }), '')
  })

  test('the child gets the environment of the entry and not the one of the broker', async () => {
    process.env.BROKER_ONLY_VALUE = 'leak'
    const rig = await startRig()
    const client = await connect(rig)
    assert.equal(await text(client, 'env', { name: 'BROKER_ONLY_VALUE' }), '')
    delete process.env.BROKER_ONLY_VALUE
  })

  test('each answer reaches only its caller when two links use the same ids at once', async () => {
    const rig = await startRig()
    const [a, b] = [await connect(rig), await connect(rig)]
    const [x, y] = await Promise.all([text(a, 'sleep', { ms: 300 }), text(b, 'sleep', { ms: 50 })])
    assert.deepEqual([x, y], ['slept 300', 'slept 50'])
  })

  test('a link that closes leaves the call of another link alone', async () => {
    const rig = await startRig()
    const [a, b] = [await connect(rig), await connect(rig)]
    const slow = text(b, 'sleep', { ms: 400 })
    void text(a, 'sleep', { ms: 5000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 100))
    await a.close()
    assert.equal(await slow, 'slept 400')
  })

  test('a child that dies closes every link, and the next use starts a new child', async () => {
    const rig = await startRig()
    const [a, b] = [await connect(rig), await connect(rig)]
    const pid = Number(await text(a, 'pid'))
    const closedA = new Promise<void>(r => (a.onclose = r))
    const closedB = new Promise<void>(r => (b.onclose = r))
    await text(a, 'exit').catch(() => {})
    await Promise.all([closedA, closedB])
    const again = await connect(rig)
    assert.notEqual(Number(await text(again, 'pid')), pid)
  })

  test('a child that exits at start refuses the attach with its exit code and no stderr text', async () => {
    const rig = await startRig()
    const entry = entryOf({}, [], process.execPath)
    const bad = { ...entry, args: ['-e', 'console.error("SECRET-TEXT"); process.exit(2)'] }
    await assert.rejects(connect(rig, bad), (err: Error) => {
      assert.ok(err instanceof BrokerError)
      assert.match(err.message, /exit code 2.*by hand/)
      assert.doesNotMatch(err.message, /SECRET-TEXT/)
      return true
    })
  })

  test('a child that gives no initialize answer is refused with the wait and stopped', async () => {
    const rig = await startRig(600_000, 'build one', 700)
    const err = await connect(rig, entryOf({}, ['--noinit'])).catch((e: Error) => e)
    assert.ok(err instanceof BrokerError)
    assert.match(err.message, /no initialize answer in 1 s.*by hand/)
    await until('the stuck child is stopped', () =>
      /child \w+ stop/.test(fs.readFileSync(path.join(rig.home, '.toolscript-mcp', 'broker', 'broker.log'), 'utf8')),
    )
  })

  test('a command that does not exist refuses the attach with the command only, and the broker keeps serving', async () => {
    const rig = await startRig()
    const command = 'no-such-command-for-toolscript'
    const bad = { ...entryOf({ T: 'MARK-ENV' }, ['MARK-ARG']), command }
    const err = await connect(rig, bad).catch((e: Error) => e)
    assert.ok(err instanceof BrokerError)
    assert.match(
      err.message,
      new RegExp(`the shared server could not start: its command was not found on PATH: ${command}`),
    )
    for (const secret of ['MARK-ARG', 'MARK-ENV', 'by hand', 'Connection closed'])
      assert.ok(!err.message.includes(secret), `no ${secret}`)
    const log = fs.readFileSync(path.join(rig.home, '.toolscript-mcp', 'broker', 'broker.log'), 'utf8')
    assert.ok(!log.includes('MARK-ARG') && !log.includes('MARK-ENV'))
    assert.match(await text(await connect(rig), 'pid'), /^\d+$/, 'the broker serves another link')
  })

  test(
    "a command that cross-spawn cannot resolve but that a file exists for keeps today's reason (an alias that crashed)",
    { skip: process.platform !== 'win32' && 'the ENOENT of cross-spawn is a guess on Windows only' },
    async () => {
      // cross-spawn emits ENOENT when cmd.exe exited with 1 and it could not resolve the command. The look finds a file,
      // as it does for an app execution alias that crashed at its start: the command did start.
      const rig = await startRig(600_000, 'build one', undefined, { findCommand: () => true })
      const err = await connect(rig, { ...entryOf(), command: 'no-such-command-for-toolscript' }).catch((e: Error) => e)
      assert.ok(err instanceof BrokerError)
      assert.match(err.message, /could not start.*by hand/)
      assert.doesNotMatch(err.message, /its command was not found/)
    },
  )

  test('an entry that spawn refuses at once refuses the attach with the code, and the broker keeps serving', async () => {
    const rig = await startRig()
    // A NUL byte in an env value: spawn throws before any process starts.
    await assert.rejects(connect(rig, entryOf({ BAD: 'a\0b' })), (err: Error) => {
      assert.ok(err instanceof BrokerError)
      assert.match(err.message, /could not start \(ERR_INVALID_ARG_VALUE\).*by hand/)
      return true
    })
    assert.match(await text(await connect(rig), 'pid'), /^\d+$/)
  })

  test('a child line that grows over 10 MB when written again ends only that link, with the reason', async () => {
    const rig = await startRig()
    const [a, b] = [await connect(rig), await connect(rig)]
    const errors: string[] = []
    a.onerror = e => errors.push(e.message)
    await assert.rejects(a.callTool({ name: 'swell', arguments: {} }))
    assert.ok(
      errors.some(m => /longer than 10 MB/.test(m)),
      `the link got the reason: ${errors.join(' | ')}`,
    )
    assert.match(await text(b, 'pid'), /^\d+$/)
  })

  test('a child with no link stops at the idle time, then the broker leaves', async () => {
    const rig = await startRig(1000)
    const client = await connect(rig)
    const pid = Number(await text(client, 'pid'))
    await client.close()
    await until('the child stops', () => !alive(pid), 6000)
    await Promise.race([
      rig.broker.done,
      new Promise((_, no) => setTimeout(() => no(new Error('the broker stayed')), 6000)),
    ])
  })

  test('a build id that differs gives another endpoint and another broker', async () => {
    const one = await startRig(600_000, 'build one')
    const key = loadKey(one.home)
    const other = path.join(one.home, 'other.js')
    fs.writeFileSync(other, 'build two')
    assert.notEqual(endpointFor(one.home, key, 'a'), endpointFor(one.home, key, 'b'))
    const second = await startBroker({ home: one.home, idleMs: 600_000, file: other })
    assert.ok(second, 'a second broker listens in the same home')
    closers.push(() => second.stop())
    assert.notEqual(second.endpoint, one.broker.endpoint)
  })

  test('a broker that finds its endpoint taken does not start', async () => {
    const rig = await startRig()
    assert.equal(await startBroker({ home: rig.home, idleMs: 600_000, file: rig.file }), undefined)
  })

  describe('a stale socket file', { skip: process.platform === 'win32' && 'pipes vanish with their process' }, () => {
    const dials = (endpoint: string): Promise<boolean> =>
      new Promise(resolve => {
        const probe = net.connect(endpoint)
        probe.once('connect', () => (probe.destroy(), resolve(true)))
        probe.once('error', () => resolve(false))
      })

    test('six brokers started at once against it give exactly one that listens, and it answers', async () => {
      const home = fs.mkdtempSync(path.join(root, 'h-'))
      const file = path.join(home, 'broker.js')
      fs.writeFileSync(file, 'build stale')
      const endpoint = endpointFor(home, loadKey(home), buildId(file))
      await staleSocket(endpoint)
      const six = await Promise.all([0, 1, 2, 3, 4, 5].map(() => startBroker({ home, idleMs: 600_000, file })))
      const winners = six.filter((b): b is Broker => b !== undefined)
      closers.push(...winners.map(b => () => b.stop()))
      assert.equal(winners.length, 1, 'one broker listens')
      assert.ok(await dials(endpoint), 'the socket answers')
      assert.equal((fs.readFileSync(`${brokerFolder(home)}/broker.log`, 'utf8').match(/ listen$/gm) ?? []).length, 1)
    })

    test('six brokers against a stale socket and a stale lock (dead pid) give one that listens', async () => {
      const home = fs.mkdtempSync(path.join(root, 'h-'))
      const file = path.join(home, 'broker.js')
      fs.writeFileSync(file, 'build stale lock')
      const endpoint = endpointFor(home, loadKey(home), buildId(file))
      await staleSocket(endpoint)
      fs.writeFileSync(`${endpoint}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, id: 'dead', at: Date.now() }))
      const six = await Promise.all([0, 1, 2, 3, 4, 5].map(() => startBroker({ home, idleMs: 600_000, file })))
      const winners = six.filter((b): b is Broker => b !== undefined)
      closers.push(...winners.map(b => () => b.stop()))
      assert.equal(winners.length, 1, 'one broker listens')
      assert.ok(await dials(endpoint))
      assert.deepEqual(
        fs.readdirSync(path.dirname(endpoint)).filter(n => n.includes('.break.') || n.endsWith('.lock')),
        [],
        'no lock or aside file is left',
      )
    })

    describe('the recovery lock', () => {
      const lockFile = (): string => path.join(fs.mkdtempSync(path.join(root, 'lk-')), 'x.sock.lock')
      const write = (file: string, held: object): void => fs.writeFileSync(file, JSON.stringify(held))
      const holder = (file: string): { id?: string } => JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: string }

      test('a lock whose time is in the future is broken although its pid lives', () => {
        const file = lockFile()
        write(file, { pid: process.pid, id: 'future', at: Date.now() + 3_600_000 })
        assert.equal(takeLock(file), undefined, 'the breaker does not hold it yet')
        assert.ok(takeLock(file), 'the next try does')
      })

      test('a fresh lock of a live pid is left alone', () => {
        const file = lockFile()
        write(file, { pid: process.pid, id: 'fresh', at: Date.now() })
        assert.equal(takeLock(file), undefined)
        assert.equal(holder(file).id, 'fresh')
      })

      test('a lock that another holder replaced after the breaker read it stays, and a third contender is refused', () => {
        const file = lockFile()
        write(file, { pid: 2 ** 22 + 12345, id: 'stale', at: Date.now() })
        const breaker = takeLock(file, () => {
          // The holder C removes the stale lock and takes a fresh one, between the read of B and its rename.
          fs.rmSync(file)
          write(file, { pid: process.pid, id: 'fresh-c', at: Date.now() })
        })
        assert.equal(breaker, undefined)
        assert.equal(holder(file).id, 'fresh-c', 'the lock of C is back')
        assert.equal(takeLock(file), undefined, 'a third contender does not enter beside C')
        assert.equal(takeLock(file), undefined)
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.sock.lock'], 'no aside file is left')
      })

      test('a half written lock is broken by its mtime and not before', () => {
        const file = lockFile()
        fs.writeFileSync(file, '{"pid":')
        assert.equal(takeLock(file), undefined)
        assert.ok(fs.existsSync(file), 'a new file is a writer at work')
        const old = new Date(Date.now() - 60_000)
        fs.utimesSync(file, old, old)
        assert.equal(takeLock(file), undefined)
        assert.ok(takeLock(file))
      })
    })

    test('a broker killed inside the link-aside leaves a .keep socket that the next start links back', async () => {
      const first = await startRig()
      const endpoint = first.broker.endpoint
      const keep = `${endpoint}.keep.${2 ** 22 + 12345}`
      fs.linkSync(endpoint, keep)
      fs.rmSync(endpoint)
      assert.equal(await startBroker({ home: first.home, idleMs: 600_000, file: first.file }), undefined)
      assert.ok(fs.existsSync(endpoint), 'the socket is back at the endpoint')
      assert.ok(!fs.existsSync(keep))
      assert.ok(await dials(endpoint), 'and its broker answers')
    })

    test('the shutdown of a broker leaves a socket that another broker bound at its path', async () => {
      const first = await startRig()
      const endpoint = first.broker.endpoint
      fs.rmSync(endpoint)
      const second = await startBroker({ home: first.home, idleMs: 600_000, file: first.file })
      assert.ok(second, 'a second broker binds the freed path')
      closers.push(() => second.stop())
      await first.stop()
      assert.ok(fs.existsSync(endpoint), 'the socket file of the second broker stays')
      assert.ok(await dials(endpoint), 'and it answers')
    })

    const nap = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const stale = async (name: string) => {
      const home = fs.mkdtempSync(path.join(root, 'h-'))
      const file = path.join(home, 'broker.js')
      fs.writeFileSync(file, name)
      const endpoint = endpointFor(home, loadKey(home), buildId(file))
      await staleSocket(endpoint)
      return { home, file, endpoint }
    }

    // The state of the gap between the bind and the listen of another broker is a young file that refuses a connect.
    test('a young socket file that refuses a connect is kept until the same file has refused for the guard, then removed and listened on', async () => {
      const { home, file, endpoint } = await stale('build young')
      const guardMs = 700
      const started = Date.now()
      let result: Broker | undefined | 'pending' = 'pending'
      const run = startBroker({ home, idleMs: 600_000, file, guardMs }).then(b => (result = b))
      await nap(guardMs / 2)
      assert.equal(result, 'pending', 'the broker still waits')
      assert.ok(fs.existsSync(endpoint), 'the file is not removed before the guard')
      assert.ok(!(await dials(endpoint)), 'and it still refuses')
      const broker = await run
      assert.ok(broker, 'after the guard the broker listens')
      closers.push(() => broker.stop())
      assert.ok(Date.now() - started >= guardMs - 30, 'it waited for the guard')
      assert.ok(await dials(endpoint), 'the file that refused is replaced by one that answers')
    })

    test('a different refusing file that replaces the first one is kept for a full guard from its own first refusal', async () => {
      const { home, file, endpoint } = await stale('build replaced')
      const guardMs = 800
      // File B is made beside the path before the broker starts: making it takes as long as a child takes to start and
      // die, and that time must not count against the guard of file A.
      const spare = endpoint + '.b'
      await staleSocket(spare)
      const run = startBroker({ home, idleMs: 600_000, file, guardMs })
      await nap(guardMs / 2)
      // File B takes the path at half the guard of file A: the count starts again.
      // It is renamed over file A, so the path is never empty for the broker.
      const swapped = Date.now()
      fs.renameSync(spare, endpoint)
      // The guard of file A would end at half the guard from now. File B refuses first after that, so it is removed
      // no earlier than a full guard after it.
      const broker = await run
      assert.ok(broker, 'after its own guard the broker listens')
      closers.push(() => broker.stop())
      assert.ok(Date.now() - swapped >= guardMs - 30, 'file B refused for a full guard')
      assert.ok(await dials(endpoint))
    })

    test('a young file that turns into a live broker within the guard is left alone, and the starting broker does not start', async () => {
      const { home, file, endpoint } = await stale('build takeover')
      const run = startBroker({ home, idleMs: 600_000, file, guardMs: 3000 })
      await nap(200)
      // The broker that made the file finishes its listen: a socket that answers is at the path now.
      fs.rmSync(endpoint)
      const live = net.createServer(() => {})
      await new Promise<void>(resolve => live.listen(endpoint, resolve))
      closers.push(() => void live.close())
      assert.equal(await run, undefined)
      assert.ok(fs.existsSync(endpoint), 'the live socket file is untouched')
      assert.ok(await dials(endpoint), 'and it answers')
    })

    test('a broker whose file another broker removed right after its listen leaves, and leaves the path to the other', async () => {
      const home = fs.mkdtempSync(path.join(root, 'h-'))
      const file = path.join(home, 'broker.js')
      fs.writeFileSync(file, 'build lost name')
      const endpoint = endpointFor(home, loadKey(home), buildId(file))
      const other = net.createServer(() => {})
      closers.push(() => void other.close())
      const lost = await startBroker({
        home,
        idleMs: 600_000,
        file,
        guardMs: 0,
        afterListen: () => {
          // The other broker removes the file and binds a new one, both before this broker looks again.
          fs.rmSync(endpoint)
          other.listen(endpoint)
        },
      })
      assert.equal(lost, undefined, 'it does not serve')
      const logFile = `${brokerFolder(home)}/broker.log`
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
      assert.ok(!/start pid/.test(log), 'it logged no start')
      assert.ok(fs.existsSync(endpoint), "the path is still the other broker's")
      assert.ok(await dials(endpoint), 'and it answers')
    })

    test('a broker that lost its name ends when its links are gone, its child ends, and the broker at the path serves the next host', async () => {
      const first = await startRig(300)
      const client = await connect(first)
      const child = Number(await text(client, 'pid'))
      // Another broker removes the file and binds its own: the first one has no name now.
      fs.rmSync(first.broker.endpoint)
      const second = await startBroker({ home: first.home, idleMs: 600_000, file: first.file, guardMs: 0 })
      assert.ok(second, 'a second broker binds the path')
      closers.push(() => second.stop())
      await client.close()
      await Promise.race([
        first.broker.done,
        new Promise((_, no) => setTimeout(() => no(new Error('the first broker stayed')), 8000)),
      ])
      await until('its child ends', () => !alive(child), 8000)
      assert.ok(fs.existsSync(first.broker.endpoint), 'the file of the second broker stays')
      const next = await connect(first)
      assert.notEqual(Number(await text(next, 'pid')), child, 'the next host is served by the broker at the path')
    })
  })

  test('the log holds lifecycle lines and no argument, variable or path', async () => {
    const rig = await startRig()
    await connect(rig, entryOf({ SECRET_VALUE: 'hunter2-value' }, ['--arg-marker-xyz']))
    await rig.stop()
    const log = fs.readFileSync(path.join(rig.home, '.toolscript-mcp', 'broker', 'broker.log'), 'utf8')
    assert.match(log, /listen/)
    assert.match(log, /attach/)
    for (const secret of [
      'hunter2-value',
      'arg-marker-xyz',
      'SECRET_VALUE',
      'pid-server',
      root,
      loadKey(rig.home).toString('hex'),
    ])
      assert.ok(!log.includes(secret), `no ${secret}`)
  })
})

describe('child stderr, forged frames and the caps', () => {
  const sink = () => {
    const got: Buffer[] = []
    return { on: (chunk: Buffer) => void got.push(chunk), text: () => Buffer.concat(got).toString('utf8') }
  }
  const logOf = (rig: Rig): string =>
    fs.readFileSync(path.join(rig.home, '.toolscript-mcp', 'broker', 'broker.log'), 'utf8')

  test('a marker on stderr reaches both hosts, and no result, reason or log line holds it', async () => {
    const rig = await startRig()
    const entry = entryOf({}, ['--marker=MARK-XYZ'])
    const [first, second] = [sink(), sink()]
    const a = await connect(rig, entry, first.on)
    const b = await connect(rig, entry, second.on)
    const results = [await text(a, 'pid'), await text(b, 'pid'), JSON.stringify(await a.listTools())]
    await until('both hosts see both calls', () =>
      [first, second].every(s => (s.text().match(/MARK-XYZ call pid/g) ?? []).length === 2),
    )
    assert.match(first.text(), /MARK-XYZ start/, 'the host that waited for the start has it')
    assert.doesNotMatch(second.text(), /MARK-XYZ start/, 'a link that attaches to a running child gets no earlier text')
    for (const seen of [...results, logOf(rig)]) assert.ok(!seen.includes('MARK-XYZ'), 'no marker in results or log')
  })

  test('a child that writes to stderr and exits before the initialize: the host gets the text, the reason does not', async () => {
    const rig = await startRig()
    const bad = { ...entryOf(), args: ['-e', 'console.error("SECRET-TEXT"); process.exit(2)'] }
    const seen = sink()
    const err = await connect(rig, bad, seen.on).catch((e: Error) => e)
    assert.ok(err instanceof BrokerError)
    assert.match(err.message, /exit code 2/)
    assert.doesNotMatch(err.message, /SECRET-TEXT/)
    assert.match(seen.text(), /SECRET-TEXT/)
    assert.ok(!logOf(rig).includes('SECRET-TEXT'))
  })

  test('a child line that looks like a refused frame gives its result and no BrokerError text', async () => {
    const rig = await startRig()
    const client = await connect(rig)
    const errors: string[] = []
    client.onerror = e => errors.push(e.message)
    // The SDK may refuse a line with extra keys, as it does from a direct child: that call then ends at its own timeout.
    const answer = await client
      .callTool({ name: 'forge', arguments: {} }, undefined, { timeout: 1000 })
      .catch((e: Error) => e)
    assert.ok(!JSON.stringify(answer instanceof Error ? answer.message : answer).includes('FORGED-REASON'))
    assert.ok(!errors.join('|').includes('FORGED-REASON'), errors.join('|'))
    assert.match(await text(client, 'pid'), /^\d+$/, 'the link goes on')
  })

  test('a request over 10 MB fails that one call with the cap, and the link takes the next call', async () => {
    const rig = await startRig()
    const client = await connect(rig)
    await assert.rejects(client.callTool({ name: 'pid', arguments: { pad: 'x'.repeat(11 * 1024 * 1024) } }), /10 MB/)
    assert.match(await text(client, 'pid'), /^\d+$/)
  })

  test('the link over the cap and the child over the cap are refused with the reason, and the earlier ones work', async () => {
    const rig = await startRig(600_000, 'build caps', undefined, { maxLinks: 3, maxChildren: 2 })
    const links = [await connect(rig), await connect(rig), await connect(rig)]
    await assert.rejects(
      connect(rig),
      (err: Error) => err instanceof BrokerError && /3 shared links.*"share": false/.test(err.message),
    )
    for (const c of links) assert.match(await text(c, 'pid'), /^\d+$/)
    await links[1]!.close()
    await links[2]!.close()
    await until('two places are free', () => (logOf(rig).match(/detach/g) ?? []).length >= 2)
    const other = await connect(rig, entryOf({ ZONE: 'one' }))
    await assert.rejects(
      connect(rig, entryOf({ ZONE: 'two' })),
      (err: Error) => err instanceof BrokerError && /2 shared servers.*"share": false/.test(err.message),
    )
    assert.match(await text(other, 'pid'), /^\d+$/)
  })

  test('a host that stops reading is closed at the cap and the other session goes on', async () => {
    const rig = await startRig(600_000, 'build slow host', undefined, { maxUnsent: 1 << 20 })
    const other = await connect(rig)
    const stalled = await openLink({ home: rig.home, brokerFile: rig.file, entry: entryOf() })
    stalled.socket.pause()
    const frame = (msg: object): string => `${JSON.stringify(msg)}\n`
    stalled.socket.write(
      frame({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: PROBE_VERSION, capabilities: {}, clientInfo: { name: 'stalled', version: '1' } },
      }),
    )
    stalled.socket.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    for (let i = 1; i <= 80; i++)
      stalled.socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'big', arguments: { kb: 1024 } } })}\n`,
      )
    // The stalled socket does not read, so it sees no close: the broker's log shows that it ended the link.
    await until('the broker ends the stalled link', () => /detach/.test(logOf(rig)), 20000)
    assert.match(await text(other, 'pid'), /^\d+$/, 'the other session still calls')
  })

  test('a child that stops reading its input is treated as dead once the hosts hold the cap for it', async () => {
    const rig = await startRig(600_000, 'build stalled child', undefined, { maxUnsent: 1 << 20 })
    const client = await connect(rig, entryOf({}, ['--stall-after-init']))
    const gone = new Promise<void>(r => (client.onclose = r))
    for (let i = 0; i < 40; i++)
      void client
        .callTool({ name: 'pid', arguments: { pad: 'x'.repeat(512 * 1024) } }, undefined, { timeout: 3000 })
        .catch(() => {})
    let shut = false
    void gone.then(() => (shut = true))
    await until('the link ends', () => shut, 20000)
    assert.match(logOf(rig), /exit input over the cap/)
  })

  test('stderr over the rate is dropped and counted in one frame, and stays out of the log', async () => {
    const rig = await startRig()
    const seen = sink()
    const client = await connect(rig, entryOf(), seen.on)
    await client.callTool({ name: 'noise', arguments: { ms: 1500, mb: 2 } }, undefined, { timeout: 30000 })
    await until('the count arrives', () => /bytes of the server's stderr were dropped/.test(seen.text()), 15000)
    assert.ok(Buffer.byteLength(seen.text()) < 400 * 1024, 'about the rate and not the whole flood')
    assert.ok(!logOf(rig).includes('zzzz'))
  })

  test('frames of stderr hold at most 8 KB each, whole or in parts', () => {
    const frames = stderrFrames(Buffer.alloc(20_000, 'a'))
    assert.equal(frames.length, 4)
    for (const f of frames) assert.ok(f.length <= 8 * 1024 + 64)
    const back = Buffer.concat(
      frames.map(f =>
        'data' in parseStderr(f.trim())! ? (parseStderr(f.trim()) as { data: Buffer }).data : Buffer.alloc(0),
      ),
    )
    assert.equal(back.length, 20_000)
    assert.equal(parseStderr('{"t":"stderr","d":"YQ=="}'), undefined, 'an unmarked line is not a frame')
  })

  test(
    'a dead socket file of another build is removed by the next broker, and a live or a young one is not',
    {
      skip: process.platform === 'win32' && 'pipes vanish with their process',
    },
    async () => {
      const live = await startRig(600_000, 'build live')
      const dir = path.dirname(live.broker.endpoint)
      const old = path.join(dir, 'tsm-aaaaaaaaaaaa.sock')
      const young = path.join(dir, 'tsm-bbbbbbbbbbbb.sock')
      await staleSocket(old)
      await staleSocket(young)
      const aged = new Date(Date.now() - 60_000)
      fs.utimesSync(old, aged, aged)
      const next = path.join(live.home, 'broker-next.js')
      fs.writeFileSync(next, 'build next')
      const second = await startBroker({ home: live.home, idleMs: 600_000, file: next })
      assert.ok(second)
      closers.push(() => second.stop())
      await until('the dead file is gone', () => !fs.existsSync(old))
      assert.ok(fs.existsSync(young), 'a young file may be a broker between bind and listen')
      assert.ok(fs.existsSync(live.broker.endpoint), 'a live broker keeps its socket')
    },
  )
})

describe('the handshake limits and a peer that is not the broker', () => {
  test('a first frame over 4 KB closes the connection and nothing is answered', async () => {
    const rig = await startRig()
    const socket = net.connect(rig.broker.endpoint)
    let got = ''
    socket.on('data', d => (got += d))
    const end = closed(socket)
    await new Promise(r => socket.once('connect', r))
    socket.write('x'.repeat(PROOF_BYTES + 10))
    assert.ok((await end) < 1500)
    assert.equal(got, '')
  })

  test('a silent peer is closed after about 2 s', async () => {
    const rig = await startRig()
    const socket = net.connect(rig.broker.endpoint)
    const ms = await closed(socket)
    assert.ok(ms >= 1500 && ms < 4000, `closed after ${ms} ms`)
  })

  test('the 17th unproven connection is closed at once, and the first 16 stay', async () => {
    const rig = await startRig()
    const open: net.Socket[] = []
    for (let i = 0; i < PROOF_CONNECTIONS; i++) {
      const s = net.connect(rig.broker.endpoint)
      s.on('error', () => {})
      await new Promise(r => s.once('connect', r))
      open.push(s)
    }
    await new Promise(r => setTimeout(r, 200))
    const extra = net.connect(rig.broker.endpoint)
    assert.ok((await closed(extra)) < 1000)
    assert.ok(open.every(s => !s.destroyed))
    for (const s of open) s.destroy()
  })

  test('a wrong proof closes the connection, and a hello is answered with a proof of the broker only', async () => {
    const rig = await startRig()
    const socket = net.connect(rig.broker.endpoint)
    const lines: string[] = []
    socket.setEncoding('utf8')
    socket.on(
      'data',
      lineSplitter(l => lines.push(l)),
    )
    const end = closed(socket)
    await new Promise(r => socket.once('connect', r))
    socket.write(`{"t":"hello","v":2,"n":"${'b'.repeat(32)}"}\n`)
    await until('the broker proof', () => lines.length === 1)
    socket.write(`{"t":"proof","p":"${'0'.repeat(64)}"}\n`)
    await end
    assert.equal(lines.length, 1, 'nothing after the wrong proof')
  })

  test('a squatter on the endpoint fails the link with the reason, receives no entry and starts no child', async () => {
    const home = fs.mkdtempSync(path.join(root, 'sq-'))
    const file = path.join(home, 'broker.js')
    fs.writeFileSync(file, 'build one')
    const endpoint = endpointFor(home, loadKey(home), crypto.createHash('sha256').update('build one').digest('hex'))
    fs.mkdirSync(path.dirname(endpoint), { recursive: true })
    const received: string[] = []
    const squatter = net.createServer(socket => {
      socket.on('data', d => received.push(String(d)))
      socket.write('{"t":"hello","n":"' + 'c'.repeat(32) + '","p":"' + 'd'.repeat(64) + '"}\n')
    })
    await new Promise<void>(r => squatter.listen(endpoint, r))
    closers.push(() => void squatter.close())
    const entry = entryOf({ SECRET_VALUE: 'hunter2-value' })
    await assert.rejects(openLink({ home, brokerFile: file, entry }), (err: Error) => {
      assert.ok(err instanceof BrokerError)
      assert.match(err.message, /toolscript-mcp doctor/)
      assert.match(err.message, /"share": false/)
      assert.match(err.message, /TOOLSCRIPT_SHARE=0/)
      return true
    })
    await until('the hello arrives', () => received.length >= 1)
    assert.equal(received.length, 1, 'only the hello')
    assert.ok(!received.join('').includes('hunter2-value') && !received.join('').includes('"entry"'))
  })

  // A broker.js that leaves a line in a marker file each time it starts, so a test counts the brokers that were started.
  const markerBroker = (home: string, body: string): { file: string; marker: string; id: string; endpoint: string } => {
    const marker = path.join(home, 'started')
    const file = path.join(home, 'broker.js')
    const code = `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x\\n')\n${body}\n`
    fs.writeFileSync(file, code)
    const id = crypto.createHash('sha256').update(code).digest('hex')
    const endpoint = endpointFor(home, loadKey(home), id)
    fs.mkdirSync(path.dirname(endpoint), { recursive: true })
    return { file, marker, id, endpoint }
  }
  const started = (marker: string): number =>
    fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').length - 1 : 0

  test('a squatter that closes every connection after the hello fails the link with the closed reason, starts no broker and gets no entry', async () => {
    const home = fs.mkdtempSync(path.join(root, 'sq-'))
    const { file, marker, endpoint } = markerBroker(home, '')
    const received: string[] = []
    const squatter = net.createServer(socket => {
      socket.on('error', () => {})
      // The host writes its hello first, and an entry frame could follow only a proof: close on the first data.
      socket.on('data', d => {
        received.push(String(d))
        socket.destroy()
      })
    })
    await new Promise<void>(r => squatter.listen(endpoint, r))
    closers.push(() => void squatter.close())
    const start = Date.now()
    await assert.rejects(openLink({ home, brokerFile: file, entry: entryOf() }), /closed the connection/)
    assert.ok(Date.now() - start < 12_500)
    assert.ok(received.length > 1, 'the host dialled again after each close')
    assert.equal(started(marker), 0, 'no broker was started')
    assert.ok(!received.join('').includes('"entry"'), 'no entry frame')
  })

  test(
    'a broker that closes its first connection and ends, again and again, is started once for one link',
    { skip: process.platform === 'win32' && 'pipes vanish with their process' },
    async () => {
      const home = fs.mkdtempSync(path.join(root, 'sq-'))
      // It listens, closes the first connection and is killed, so the file stays and refuses: the next dial starts another
      // broker unless the link remembers that it started one.
      const body =
        "const s = require('net').createServer(c => { c.destroy(); process.kill(process.pid, 'SIGKILL') });" +
        's.listen(process.env.TS_TEST_ENDPOINT)'
      const { file, marker, endpoint } = markerBroker(home, body)
      process.env.TS_TEST_ENDPOINT = endpoint
      closers.push(() => void delete process.env.TS_TEST_ENDPOINT)
      const start = Date.now()
      await assert.rejects(openLink({ home, brokerFile: file, entry: entryOf() }), /none listened within 10 s/)
      assert.ok(Date.now() - start < 12_500)
      assert.equal(started(marker), 1, 'one broker was started for the whole link')
    },
  )

  test('a silent squatter fails the link within the handshake time', async () => {
    const home = fs.mkdtempSync(path.join(root, 'sq-'))
    const file = path.join(home, 'broker.js')
    fs.writeFileSync(file, 'build one')
    const endpoint = endpointFor(home, loadKey(home), crypto.createHash('sha256').update('build one').digest('hex'))
    fs.mkdirSync(path.dirname(endpoint), { recursive: true })
    const squatter = net.createServer(() => {})
    await new Promise<void>(r => squatter.listen(endpoint, r))
    closers.push(() => void squatter.close())
    const start = Date.now()
    await assert.rejects(openLink({ home, brokerFile: file, entry: entryOf() }), /did not answer the handshake/)
    assert.ok(Date.now() - start < 4000)
  })

  test('a squatter that streams a line with no newline fails the link at once, and the host reads little of it', async () => {
    const home = fs.mkdtempSync(path.join(root, 'sq-'))
    const file = path.join(home, 'broker.js')
    fs.writeFileSync(file, 'build one')
    const endpoint = endpointFor(home, loadKey(home), crypto.createHash('sha256').update('build one').digest('hex'))
    fs.mkdirSync(path.dirname(endpoint), { recursive: true })
    const piece = 'a'.repeat(1 << 20)
    let sent = 0
    const squatter = net.createServer(socket => {
      socket.on('error', () => {})
      const pump = () => {
        while (!socket.destroyed && socket.write(piece)) sent += piece.length
        if (!socket.destroyed) socket.once('drain', pump)
      }
      pump()
    })
    await new Promise<void>(r => squatter.listen(endpoint, r))
    closers.push(() => void squatter.close())
    const start = Date.now()
    await assert.rejects(
      openLink({ home, brokerFile: file, entry: entryOf() }),
      (err: Error) => err instanceof BrokerError && /more than 4 KB/.test(err.message),
    )
    assert.ok(Date.now() - start < 1500, 'it does not wait for the handshake timer')
    assert.ok(sent < 64 << 20, `the squatter could write ${sent >> 20} MB`)
  })

  test('a broker rebuilt in place after this process read its build id fails the link with "restart"', async () => {
    const home = fs.mkdtempSync(path.join(root, 'sq-'))
    const file = path.join(home, 'broker.js')
    fs.writeFileSync(file, 'build one')
    idOf(file) // this process has read the id of the file, as a running host has
    fs.writeFileSync(file, '// rebuilt')
    const start = Date.now()
    await assert.rejects(
      openLink({ home, brokerFile: file, entry: entryOf() }),
      (err: Error) => err instanceof BrokerError && /rebuilt .*Restart the session/.test(err.message),
    )
    assert.ok(Date.now() - start < 3000, 'no wait for a broker that cannot meet this host')
    assert.equal(fs.existsSync(`${brokerFolder(home)}/broker.log`), false, 'no broker started')
  })

  test('the probe of the broker asks for the latest protocol version of the SDK', () => {
    assert.equal(PROBE_VERSION, LATEST_PROTOCOL_VERSION)
  })

  test('a host does not take a frame without t "hello" as the broker first frame', () => {
    const c = makeCrypto(Buffer.alloc(32, 7))
    const side = hostSide(c)
    side.start()
    const nonce = 'e'.repeat(32)
    const frame = JSON.stringify({ n: nonce, p: c.mac(`toolscript-mcp 2 broker ${'0'.repeat(32)} ${nonce}`) })
    assert.ok(side.step(frame).fail !== undefined)
  })

  test('a run with no broker.js fails the link with the reason and starts nothing', async () => {
    await assert.rejects(openLink({ home: root, brokerFile: undefined, entry: entryOf() }), /no broker\.js beside it/)
  })

  test('makeCrypto compares in constant time and only equal texts', () => {
    const c = makeCrypto(Buffer.alloc(32, 1))
    assert.equal(c.same(c.mac('a'), c.mac('a')), true)
    assert.equal(c.same(c.mac('a'), c.mac('b')), false)
    assert.equal(c.same('a', 'ab'), false)
  })
})
