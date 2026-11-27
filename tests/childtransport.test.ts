import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChildTransport, HURRY_WAIT_MS, TERM_WAIT_MS } from '../src/host/childtransport.ts'

const CHILD = path.join(import.meta.dirname, 'sigterm-child.mjs')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-childtransport-'))
after(() => fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 }))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the stop of a child that ignores EOF', () => {
  // Windows has no SIGTERM: its tree ends at once, and the e2e test of lazy start covers it.
  test(
    'outside Windows the group gets SIGTERM first, so the child cleans up, and the stop is well inside 2 s',
    {
      skip: process.platform === 'win32',
    },
    async () => {
      const marker = path.join(DIR, 'marker')
      const transport = new ChildTransport({ command: process.execPath, args: [CHILD, marker], env: {} })
      await transport.start()
      for (let i = 0; i < 200 && !fs.existsSync(`${marker}.started`); i++) await sleep(25)
      const pid = Number(fs.readFileSync(`${marker}.started`, 'utf8'))
      assert.ok(alive(pid))
      transport.hurry()
      const began = Date.now()
      await transport.close()
      const ms = Date.now() - began
      console.error(`stop ms: ${ms}`)
      assert.equal(fs.readFileSync(marker, 'utf8'), 'cleaned up', 'the SIGTERM handler ran')
      assert.ok(!alive(pid), 'the child is gone')
      assert.ok(ms < 1500, `the stop took ${ms} ms (hurry ${HURRY_WAIT_MS} + term ${TERM_WAIT_MS})`)
    },
  )
})
