// The real broker, spawned from dist/host/broker.js by the host code, on a temp HOME with a short idle time. Run
// `npm run build` first, then:
//
//   node --experimental-strip-types tests/broker.integration.ts

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { brokerFolder } from '../src/core/paths.ts'
import { BrokerError, BrokerTransport, openLink } from '../src/host/brokerlink.ts'
import { endpointFor, loadKey } from '../src/host/brokerwire.ts'
import { alive, SERVER, serverEntry, staleSocket, text, until } from './broker-rig.ts'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BROKER = path.join(ROOT, 'dist', 'host', 'broker.js')
assert.ok(fs.existsSync(BROKER), 'run `npm run build` first')

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-broker-int-')))
// The spawned broker finds its folder through os.homedir(), so it reads the environment of this process.
const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  IDLE: process.env.TOOLSCRIPT_BROKER_IDLE_MS,
}
const IDLE_MS = 1500
process.env.TOOLSCRIPT_BROKER_IDLE_MS = String(IDLE_MS)

const clients: Client[] = []
const homes: string[] = []
/** A new HOME for one test: every test gets its own key, so its own broker. */
const newHome = (): string => {
  const home = fs.mkdtempSync(path.join(root, 'h-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  homes.push(home)
  return home
}
after(async () => {
  for (const c of clients) await c.close().catch(() => {})
  for (const home of homes) for (const pid of brokerPids(home)) if (alive(pid)) process.kill(pid)
  await new Promise(r => setTimeout(r, 300))
  Object.assign(process.env, { HOME: saved.HOME, USERPROFILE: saved.USERPROFILE })
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

const logOf = (home: string): string => {
  try {
    return fs.readFileSync(`${brokerFolder(home)}/broker.log`, 'utf8')
  } catch {
    return ''
  }
}
const brokerPids = (home: string): number[] => [...logOf(home).matchAll(/start pid (\d+)/g)].map(m => Number(m[1]))
const listens = (home: string): number => (logOf(home).match(/ listen$/gm) ?? []).length

const connect = async (home: string, entry = serverEntry(root), file = BROKER): Promise<Client> => {
  const client = new Client({ name: 'test', version: '0' })
  clients.push(client)
  await client.connect(new BrokerTransport({ home, brokerFile: file, entry }))
  return client
}

describe('a real broker', () => {
  test('six starts at once give one broker and one child, and all six links work', async () => {
    const home = newHome()
    const six = await Promise.all([0, 1, 2, 3, 4, 5].map(() => connect(home)))
    const pids = await Promise.all(six.map(c => text(c, 'pid')))
    assert.equal(new Set(pids).size, 1, 'one child')
    assert.equal(listens(home), 1, 'one broker')
    assert.equal(brokerPids(home).length, 1)
    assert.ok(alive(Number(pids[0])))
  })

  test(
    'six starts at once against a stale socket file give one broker and one child',
    { skip: process.platform === 'win32' },
    async () => {
      const home = newHome()
      const id = crypto.createHash('sha256').update(fs.readFileSync(BROKER)).digest('hex')
      const endpoint = endpointFor(home, loadKey(home), id)
      await staleSocket(endpoint)
      const six = await Promise.all([0, 1, 2, 3, 4, 5].map(() => connect(home)))
      const pids = await Promise.all(six.map(c => text(c, 'pid')))
      assert.equal(new Set(pids).size, 1, 'one child')
      assert.equal(listens(home), 1, 'one broker')
    },
  )

  test('idle: the child, then the broker, are gone, with no socket file left', async () => {
    const home = newHome()
    const client = await connect(home)
    const child = Number(await text(client, 'pid'))
    const [broker] = brokerPids(home)
    await client.close()
    await until('the child stops', () => !alive(child), 8000)
    await until('the broker leaves', () => !alive(broker!), 8000)
    if (process.platform !== 'win32')
      assert.ok(
        !fs.existsSync(
          endpointFor(home, loadKey(home), crypto.createHash('sha256').update(fs.readFileSync(BROKER)).digest('hex')),
        ),
      )
    assert.match(logOf(home), / exit$/m)
  })

  test('a killed broker: the links close, the next use starts a new broker, and the old child ends', async () => {
    const home = newHome()
    const client = await connect(home)
    const child = Number(await text(client, 'pid'))
    const closed = new Promise<void>(r => (client.onclose = r))
    process.kill(brokerPids(home)[0]!, 'SIGKILL')
    await closed
    const again = await connect(home)
    assert.notEqual(Number(await text(again, 'pid')), child)
    assert.equal(listens(home), 2)
    await until('the old child ends', () => !alive(child), 8000)
  })

  test('two build ids give two brokers', async () => {
    const home = newHome()
    const other = path.join(root, `broker-${path.basename(home)}.js`)
    fs.writeFileSync(other, `${fs.readFileSync(BROKER, 'utf8')}\n// another build\n`)
    const [a, b] = [await connect(home), await connect(home, serverEntry(root), other)]
    assert.notEqual(await text(a, 'pid'), await text(b, 'pid'))
    assert.equal(listens(home), 2)
    assert.equal(new Set(brokerPids(home)).size, 2)
  })

  test('a child that floods stdout with no newline dies with a reason, and another link keeps working', async () => {
    const home = newHome()
    const other = await connect(home)
    const flooder = await connect(home, serverEntry(root, {}, ['--flooder']))
    const errors: string[] = []
    flooder.onerror = e => errors.push(e.message)
    const flooderPid = Number(await text(flooder, 'pid'))
    const [broker] = brokerPids(home)
    let worst = 0
    let running = true
    const pinger = (async () => {
      while (running) {
        const at = performance.now()
        await text(other, 'pid')
        worst = Math.max(worst, performance.now() - at)
        await new Promise(r => setTimeout(r, 50))
      }
    })()
    const result = await flooder.callTool({ name: 'flood', arguments: {} }, undefined, { timeout: 20_000 }).then(
      () => 'answered',
      (e: Error) => e.message,
    )
    running = false
    await pinger
    assert.match(result, /ended|closed/i)
    assert.ok(worst < 5000, `the other link waited ${Math.round(worst)} ms`)
    assert.equal((await text(other, 'pid')).length > 0, true)
    assert.match(logOf(home), /child [0-9a-f]{8} exit line over the cap/)
    await until('the flooder is gone', () => !alive(flooderPid), 8000)
    assert.ok(alive(broker!), 'the broker lives')
    assert.ok(
      errors.some(m => /longer than 10 MB/.test(m)),
      `the link got the reason: ${errors.join(' | ')}`,
    )
  })

  test('a squatter on the endpoint fails the link, and no child starts in its place', async () => {
    const home = newHome()
    const id = crypto.createHash('sha256').update(fs.readFileSync(BROKER)).digest('hex')
    const endpoint = endpointFor(home, loadKey(home), id)
    const squatter = net.createServer(() => {})
    await new Promise<void>(r => squatter.listen(endpoint, r))
    const marker = path.join(home, 'child-started')
    const entry = serverEntry(root, {}, [], process.execPath)
    const marked = { ...entry, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] }
    await assert.rejects(openLink({ home, brokerFile: BROKER, entry: marked }), BrokerError)
    await new Promise(r => setTimeout(r, 500))
    squatter.close()
    assert.ok(!fs.existsSync(marker), 'no direct child')
  })

  test('a wrapper server and a server that ignores stdin EOF leave no process after the idle stop', async () => {
    const home = newHome()
    const wrapped =
      process.platform === 'win32'
        ? serverEntry(root, {}, ['--ignore-eof'], 'cmd')
        : serverEntry(root, {}, ['--ignore-eof'], 'sh')
    const entry =
      process.platform === 'win32'
        ? { ...wrapped, args: ['/c', 'node', SERVER, '--ignore-eof'] }
        : { ...wrapped, args: ['-c', `"${process.execPath}" "${SERVER}" --ignore-eof; true`] }
    const client = await connect(home, entry)
    const server = Number(await text(client, 'pid'))
    assert.ok(alive(server))
    await client.close()
    await until('the whole tree ends', () => !alive(server), 10_000)
  })

  // Windows has no SIGTERM handler for a process: there the broker ends by its idle time, tested above.
  test('SIGTERM stops every child first, then the broker ends', { skip: process.platform === 'win32' }, async () => {
    const home = newHome()
    const client = await connect(home)
    const child = Number(await text(client, 'pid'))
    const [broker] = brokerPids(home)
    process.kill(broker!, 'SIGTERM')
    await until('the child ends', () => !alive(child), 8000)
    await until('the broker ends', () => !alive(broker!), 8000)
  })

  test('a crash writes a line with the class and code of the error, never its message, and the broker exits 1', async () => {
    const home = newHome()
    // Loaded before broker.js: throws once the broker listens, with a path in the message.
    const preload = path.join(home, 'crash.mjs')
    fs.writeFileSync(
      preload,
      [
        "import fs from 'node:fs'",
        "import os from 'node:os'",
        'const file = `${os.homedir()}/.toolscript-mcp/broker/broker.log`',
        'const read = () => { try { return fs.readFileSync(file, "utf8") } catch { return "" } }',
        'const timer = setInterval(() => {',
        '  if (!/ listen$/m.test(read())) return',
        '  clearInterval(timer)',
        '  throw Object.assign(new Error(`message with ${file}`), { code: "EFAKE" })',
        '}, 20)',
      ].join('\n'),
    )
    const broker = spawn(process.execPath, ['--import', pathToFileURL(preload).href, BROKER], {
      stdio: 'ignore',
      windowsHide: true,
    })
    assert.equal(await new Promise(r => broker.on('exit', r)), 1)
    assert.match(logOf(home), / crash Error EFAKE$/m)
    assert.ok(!logOf(home).includes('message with'))
  })

  test('a host that is gone leaves the call of the other host alone and the child up', async () => {
    const home = newHome()
    const [a, b] = [await connect(home), await connect(home)]
    const child = await text(a, 'pid')
    void text(a, 'sleep', { ms: 4000 }).catch(() => {})
    await a.close()
    assert.equal(await text(b, 'pid'), child)
  })
})
