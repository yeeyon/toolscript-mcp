// The shapes file under several server processes at once.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shapesFile } from '../src/core/paths.ts'
import { parseShapes } from '../src/core/protocol.ts'

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

describe('the shapes file with several processes', () => {
  test('6 writers and a reader: every read parses in full, no temp file stays, one writer keeps its keys (C3)', async () => {
    const home = fs.mkdtempSync(path.join(ROOT, 'home-'))
    const file = shapesFile(home)
    const children = Array.from({ length: WRITERS }, (_, id) => {
      const child = childProcess.spawn(process.execPath, [WRITER, home, String(id)], {
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
