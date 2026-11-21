// The shapes file under several server processes at once.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shapesFile } from '../src/core/paths.ts'
import { parseShapes } from '../src/core/protocol.ts'
import { loadShapes, removeOrphans, saveShapes, within } from '../src/host/shapes.ts'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-shapes-test-'))
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }))

const WRITER = path.join(import.meta.dirname, 'shapes-writer.mjs')
const WRITERS = 6
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Reads the file as a reader that never lets a transient Windows sharing error count as a failure.
const readFile = async (file: string): Promise<string | undefined> => {
  for (let i = 0; i < 200; i++) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return undefined
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
      await sleep(5)
    }
  }
  throw new Error('the file stayed busy')
}

describe('a shapes file that cannot be read', () => {
  const entry = new Map([['mcp__x__a', { shape: '{a}', schema: '0123456789abcdef' }]])
  const prepare = () => {
    const home = fs.mkdtempSync(path.join(ROOT, 'home-'))
    fs.mkdirSync(path.dirname(shapesFile(home)), { recursive: true })
    return { home, file: shapesFile(home), lines: [] as string[] }
  }

  test('is not replaced by a write, and one line says why', async () => {
    const { home, file, lines } = prepare()
    fs.mkdirSync(file)
    await saveShapes(home, entry, line => lines.push(line))
    assert.equal(fs.statSync(file).isDirectory(), true)
    assert.equal(lines.length, 1, lines.join('\n'))
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')),
      [],
    )
  })

  test('a file that is not JSON is still replaced (S5)', async () => {
    const { home, file } = prepare()
    fs.writeFileSync(file, 'not json')
    await saveShapes(home, entry, () => {})
    assert.deepEqual(Object.keys(await loadShapes(home, () => {})), ['mcp__x__a'])
  })

  test('a FIFO at the path does not block a load or a save', { skip: process.platform === 'win32' }, async () => {
    const { home, file, lines } = prepare()
    const made = childProcess.spawnSync('mkfifo', [file], { windowsHide: true })
    if (made.status !== 0) return
    const began = Date.now()
    assert.deepEqual(await loadShapes(home, line => lines.push(line)), {})
    await saveShapes(home, entry, line => lines.push(line))
    assert.ok(Date.now() - began < 1500, 'the FIFO was not opened')
    assert.equal(fs.lstatSync(file).isFIFO(), true, 'the FIFO stays')
  })

  test('within ends a wait that is too long, and takes a fast one', async () => {
    assert.equal(await within(new Promise<string>(() => {}), 20, 'late'), 'late')
    assert.equal(await within(Promise.resolve('fast'), 1000, 'late'), 'fast')
  })

  test('removeOrphans removes only old temp files of the writer', async () => {
    const { home, file } = prepare()
    const dir = path.dirname(file)
    const old = path.join(dir, 'shapes.json.old.tmp')
    const young = path.join(dir, 'shapes.json.young.tmp')
    for (const f of [old, young, file]) fs.writeFileSync(f, 'x')
    const past = new Date(Date.now() - 3_600_000)
    fs.utimesSync(old, past, past)
    fs.utimesSync(file, past, past)
    await removeOrphans(home)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['shapes.json', 'shapes.json.young.tmp'])
  })
})

describe('the shapes file with several processes', () => {
  test('6 writers and a reader: every read parses in full, no temp file stays, one writer keeps its keys (C3)', async () => {
    const home = fs.mkdtempSync(path.join(ROOT, 'home-'))
    const file = shapesFile(home)
    const children = Array.from({ length: WRITERS }, (_, id) => {
      // Node 22.13 runs a .ts file only with this flag.
      const args = ['--experimental-strip-types', '--no-warnings', WRITER, home, String(id)]
      const child = childProcess.spawn(process.execPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
      let stderr = ''
      child.stderr.on('data', d => (stderr += d))
      const exited = new Promise<{ code: number | null; stderr: string }>(resolve =>
        child.on('close', code => resolve({ code, stderr })),
      )
      return exited
    })
    let running = true
    const done = Promise.all(children).finally(() => (running = false))
    let reads = 0
    while (running) {
      const text = await readFile(file)
      if (text !== undefined) {
        const parsed = parseShapes(text)
        assert.equal(parsed.problem, undefined, text.slice(0, 80))
        assert.equal(parsed.dropped, 0)
        reads++
      }
      await sleep(2)
    }
    const results = await done
    // A failed write logs a line and never throws: the exit code 3 marks a line, any other code a crash.
    for (const r of results) assert.ok(r.code === 0 || r.code === 3, `a writer crashed: ${r.stderr}`)
    const final = parseShapes((await readFile(file))!)
    assert.equal(final.problem, undefined)
    assert.equal(final.dropped, 0)
    const keys = new Set(Object.keys(final.shapes))
    const whole = Array.from({ length: WRITERS }, (_, id) => id).filter(id =>
      Array.from({ length: 20 }, (_, n) => `mcp__w${id}__t${n}`).every(k => keys.has(k)),
    )
    assert.ok(
      whole.length >= 1,
      `no writer keeps its 20 keys: ${[...keys].length} keys. ${results.map(r => r.stderr).join('')}`,
    )
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')),
      [],
    )
    assert.ok(reads > 0)
  })
})
