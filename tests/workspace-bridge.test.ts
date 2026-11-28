// The helpers of bench/workspace-bridge.mjs, with no host and no Claude: the outcome of a call and the leftovers.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { outcomeOf, survivors } from '../bench/workspace-bridge.mjs'
import { readTable } from '../bench/memory.mjs'

const toChild = (code: string) =>
  spawn(process.execPath, ['-e', code], { stdio: 'ignore', windowsHide: true, detached: true })
const kids: number[] = []
after(() => {
  for (const pid of kids)
    try {
      process.kill(pid)
    } catch {}
})

test('a JSON-RPC error answer is a failed call with no timing, and so is a result with no content', () => {
  const failed = { ms: 5, chars: 0, ok: false, answered: false }
  assert.deepEqual(outcomeOf({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } }, 5), failed)
  assert.deepEqual(outcomeOf({ jsonrpc: '2.0', id: 1 }, 5), failed)
  assert.deepEqual(outcomeOf({ jsonrpc: '2.0', id: 1, result: 'x' }, 5), failed)
  assert.deepEqual(outcomeOf({ jsonrpc: '2.0', id: 1, result: { content: 'x' } }, 5), failed)
  assert.deepEqual(outcomeOf(undefined, 5), failed)
})

test('a result counts its text, and an error result or an error text is a failed program with a timing', () => {
  const ok = {
    content: [
      { type: 'text', text: 'abc' },
      { type: 'text', text: 'de' },
    ],
  }
  assert.deepEqual(outcomeOf({ result: ok }, 7), { ms: 7, chars: 5, ok: true, answered: true })
  assert.deepEqual(outcomeOf({ result: { ...ok, isError: true } }, 7), { ms: 7, chars: 5, ok: false, answered: true })
  const refused = { content: [{ type: 'text', text: 'Refused: no rule' }] }
  assert.deepEqual(outcomeOf({ result: refused }, 7), { ms: 7, chars: 16, ok: false, answered: true })
})

test('survivors: an observed process stays found after its host left, and a reused pid is not', () => {
  const seen = new Set(['10:100', '11:105'])
  // The host 10 is gone from the table. Its child 11 is still there, and the pid 12 is a new process.
  const table = [
    { pid: 11, ppid: 10, t: 105, name: 'bridge' },
    { pid: 12, ppid: 1, t: 300, name: 'other' },
    { pid: 10, ppid: 1, t: 900, name: 'reused pid' },
  ]
  assert.deepEqual(survivors(table, seen), [table[0]])
  assert.deepEqual(survivors([], seen), [])
})

test('survivors find the child that a real host left behind when it exited', async () => {
  const child = toChild('setTimeout(() => {}, 20000)')
  const pid = child.pid!
  kids.push(pid)
  child.unref()
  let row
  for (let i = 0; i < 40 && row === undefined; i++) {
    row = (await readTable()).find(e => e.pid === pid)
    if (row === undefined) await new Promise(r => setTimeout(r, 100))
  }
  assert.ok(row, 'the table shows the child')
  const seen = new Set([pid + ':' + row.t])
  // The "host" is not in the table at all: the child is found by its own pid and creation time.
  assert.deepEqual(
    survivors(await readTable(), seen).map(e => e.pid),
    [pid],
  )
  process.kill(pid)
  for (let i = 0; i < 40 && (await readTable()).some(e => e.pid === pid); i++)
    await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(survivors(await readTable(), seen), [])
})
