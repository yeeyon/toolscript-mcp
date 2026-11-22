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
import { PROBE_VERSION, startBroker, type Broker } from '../src/host/broker.ts'
import { BrokerError, BrokerTransport, idOf, openLink } from '../src/host/brokerlink.ts'
import { alive, serverEntry, text, until } from './broker-rig.ts'
import { endpointFor, loadKey, makeCrypto } from '../src/host/brokerwire.ts'

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
    const hello = broker.step(`{"t":"hello","v":1,"n":"${'a'.repeat(32)}"}`)
    const frame = JSON.parse(hello.send!) as { n: string; p: string }
    // The attacker sends the broker's own proof back as the host proof.
    assert.equal(broker.step(JSON.stringify({ t: 'proof', p: frame.p })).fail, 'wrong proof')
  })

  test('a recorded proof does not pass with fresh nonces (replay)', () => {
    const first = brokerSide(fake('k'))
    first.step(`{"t":"hello","v":1,"n":"${'a'.repeat(32)}"}`)
    const hostProof = fake('k').mac(`toolscript-mcp 1 host ${'a'.repeat(32)} ${'00000000000000000000000000000001'}`)
    assert.equal(first.step(JSON.stringify({ t: 'proof', p: hostProof })).done, true, 'the true proof passes once')
    const crypto2 = fake('k')
    crypto2.nonce()
    const second = brokerSide(crypto2)
    second.step(`{"t":"hello","v":1,"n":"${'a'.repeat(32)}"}`)
    assert.equal(second.step(JSON.stringify({ t: 'proof', p: hostProof })).fail, 'wrong proof')
  })

  test('a bad hello, a bad version and a proof with no hello fail', () => {
    for (const line of ['x', '{}', '{"t":"hello","v":2,"n":"' + 'a'.repeat(32) + '"}', '{"t":"proof","p":"x"}'])
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
const startRig = async (idle = 600_000, build = 'build one', initMs?: number): Promise<Rig> => {
  const home = fs.mkdtempSync(path.join(root, 'h-'))
  const file = path.join(home, 'broker.js')
  fs.writeFileSync(file, build)
  const broker = await startBroker({ home, idleMs: idle, file, ...(initMs !== undefined && { initMs }) })
  assert.ok(broker, 'the broker listens')
  const stop = () => broker.stop()
  closers.push(stop)
  return { home, file, broker, stop }
}

const entryOf = (env: Record<string, string> = {}, args: string[] = [], command = process.execPath): Entry =>
  serverEntry(root, env, args, command)

const clients: Client[] = []
const connect = async (rig: Rig, entry: Entry = entryOf()): Promise<Client> => {
  const client = new Client({ name: 'test', version: '0' })
  clients.push(client)
  await client.connect(new BrokerTransport({ home: rig.home, brokerFile: rig.file, entry }))
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
      ['pid', 'env', 'cwd', 'sleep', 'exit', 'grow', 'flood'],
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

  test('a command that does not exist refuses the attach', async () => {
    const rig = await startRig()
    await assert.rejects(
      connect(rig, { ...entryOf(), command: 'no-such-command-for-toolscript' }),
      /could not start|exit code/,
    )
  })

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
    socket.write(`{"t":"hello","v":1,"n":"${'b'.repeat(32)}"}\n`)
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
    const frame = JSON.stringify({ n: nonce, p: c.mac(`toolscript-mcp 1 broker ${'0'.repeat(32)} ${nonce}`) })
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
