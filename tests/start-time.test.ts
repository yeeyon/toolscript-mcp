// The part of scripts/start-time.mjs that ends a broker: it must end the broker it started and no other process.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, test } from 'node:test'
import { isBroker, lastLiveStart, processInfo } from '../scripts/broker-proc.mjs'

describe('lastLiveStart', () => {
  const line = (t: string, text: string): string => `2026-11-22T10:00:0${t}.000Z ${text}`
  test('the last start with no exit after it', () => {
    const log = [line('1', 'start pid 11'), line('2', 'listen'), line('3', 'exit'), line('4', 'start pid 22')].join(
      '\n',
    )
    assert.deepEqual(lastLiveStart(`${log}\n`), { pid: 22, at: Date.parse('2026-11-22T10:00:04.000Z') })
  })
  test('none when the last start has its exit line, and none for an empty log', () => {
    assert.equal(lastLiveStart([line('1', 'start pid 11'), line('2', 'exit')].join('\n')), undefined)
    assert.equal(lastLiveStart(''), undefined)
  })
})

describe('isBroker', () => {
  const at = Date.parse('2026-11-22T10:00:00.000Z')
  const info = (start: number, command: string) => ({ start, command })
  test('the broker file in the command line, created just before the log line', () => {
    assert.equal(isBroker(info(at - 300, 'node C:\\x\\dist\\host\\broker.js'), at, 'broker.js', true), true)
    assert.equal(isBroker(info(at - 300, '/usr/bin/node /x/dist/host/broker.js'), at, 'broker.js', false), true)
  })
  test('another command line, a process created after the log line, or one far older, is not it', () => {
    assert.equal(isBroker(info(at - 300, 'node other.js'), at, 'broker.js', false), false)
    assert.equal(isBroker(info(at + 60_000, 'node /x/broker.js'), at, 'broker.js', false), false)
    assert.equal(isBroker(info(at - 3_600_000, 'node /x/broker.js'), at, 'broker.js', false), false)
    assert.equal(isBroker(undefined, at, 'broker.js'), false)
  })
})

describe('processInfo on a real process', () => {
  test('reads the command line and the creation time of a process that this test started', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'broker.js'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    try {
      await new Promise(r => child.once('spawn', r))
      const before = Date.now()
      const read = processInfo(child.pid!)
      assert.ok(read, 'the process can be read')
      assert.match(read.command, /broker\.js/)
      assert.ok(Math.abs(read.start - before) < 60_000, 'created a moment ago')
      assert.equal(isBroker(read, Date.now(), 'broker.js'), true)
      assert.equal(isBroker(read, read.start - 10_000, 'broker.js'), false, 'a pid reused after that log line')
    } finally {
      child.kill()
    }
  })
  test('a pid that is gone gives undefined', () => {
    assert.equal(processInfo(2 ** 22 + 54321), undefined)
  })
})
