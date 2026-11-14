// connectAll with real stdio children (tests/probe-server.mjs): a server whose
// connection closed connects again on next use, once for all callers, at most
// 3 times in 60 s, and never after close.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerConfig, ServerKey } from '../src/core/config.ts'
import { connectAll, type Downstream } from '../src/host/downstream.ts'

const PROBE = path.join(import.meta.dirname, 'probe-server.mjs')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-downstream-test-'))
const KEY = 'p' as ServerKey
const opened: Downstream[] = []
after(async () => {
  await Promise.all(opened.map(d => d.close()))
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 })
})

/** One probe server that exits 200 ms after it lists its tools, and a clock the test sets. */
const setup = () => {
  const file = path.join(DIR, `${randomUUID()}.json`)
  const server: ServerConfig = {
    kind: 'stdio',
    command: process.execPath,
    args: [PROBE, file, '--exit-after-list'],
    env: {},
  }
  const clock = { now: 0 }
  const downstream = connectAll(
    new Map([[KEY, server]]),
    '0',
    () => {},
    () => clock.now,
  )
  opened.push(downstream)
  const starts = () =>
    fs
      .readFileSync(`${file}.log`, 'utf8')
      .split('\n')
      .filter(line => line.includes('"event":"start"')).length
  const closed = async () => {
    for (let i = 0; i < 100 && downstream.states()[0]?.status !== 'failed'; i++)
      await new Promise(r => setTimeout(r, 50))
    assert.equal(downstream.states()[0]?.status, 'failed', 'the probe server exited')
  }
  return { downstream, clock, starts, closed }
}

describe('reconnect', () => {
  test('a server whose connection closed connects again on next use, one time for all callers', async () => {
    const { downstream, starts, closed } = setup()
    await downstream.settled
    await closed()
    const links = await Promise.all([downstream.client(KEY), downstream.client(KEY), downstream.client(KEY)])
    assert.deepEqual(
      links.map(l => l.ok),
      [true, true, true],
    )
    assert.equal(starts(), 2)
  })

  test('retry connects again each failed server, as search_tools does', async () => {
    const { downstream, starts, closed } = setup()
    await downstream.settled
    await closed()
    await downstream.retry()
    assert.equal(downstream.states()[0]?.status, 'connected')
    assert.equal(starts(), 2)
  })

  test('two runs that name one failed server both wait for its one attempt', async () => {
    const { downstream, starts, closed } = setup()
    await downstream.settled
    await closed()
    const statusAfter = (keys?: ServerKey[]) => downstream.retry(keys).then(() => downstream.states()[0]?.status)
    const [first, second, search] = await Promise.all([statusAfter([KEY]), statusAfter([KEY]), statusAfter()])
    assert.deepEqual([first, second], ['connected', 'connected'])
    assert.equal(search, 'connecting', 'a search does not wait for an attempt that another caller started')
    assert.equal(starts(), 2)
  })

  test('at most 3 attempts in 60 s, then the reason gives the wait, and after 60 s one more', async () => {
    const { downstream, clock, starts, closed } = setup()
    await downstream.settled
    for (const attempt of [2, 3]) {
      await closed()
      assert.equal((await downstream.client(KEY)).ok, true)
      assert.equal(starts(), attempt)
    }
    await closed()
    clock.now = 15_000
    const refused = await downstream.client(KEY)
    assert.equal(refused.ok, false)
    assert.match(refused.ok ? '' : refused.reason, /the connection closed.*tries again on next use after 45 s$/)
    await downstream.retry()
    const state = downstream.states()[0]
    assert.match(state?.status === 'failed' ? state.reason : '', /tries again on next use after 45 s$/)
    assert.equal(starts(), 3, 'no attempt over the cap')
    clock.now = 60_000
    assert.equal((await downstream.client(KEY)).ok, true)
    assert.equal(starts(), 4)
  })

  test('no reconnect after close', async () => {
    const { downstream, starts, closed } = setup()
    await downstream.settled
    await closed()
    await downstream.close()
    const link = await downstream.client(KEY)
    assert.equal(link.ok, false)
    assert.match(link.ok ? '' : link.reason, /shutting down/)
    await downstream.retry()
    assert.equal(starts(), 1)
  })
})
