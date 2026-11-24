// One toolscript-mcp process of tests/workspace-lock.test.ts. It binds the real Workspace provider to a root, with the
// write grant, over the HOME of the parent, and runs commands that the parent sends on stdin, one JSON line each:
//   { id, edit: args }   runs the edit tool and answers { id, ok: true, result } or { id, ok: false, text }
//   { id, hold: path }   takes the lock of a file of the root and keeps it until `release`
//   { id, release: true }
//   { exit: true }
// It answers on stdout, one JSON line each: `{ ready: true }` first. Arguments: the root and the HOME.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import path from 'node:path'
import readline from 'node:readline'
import { bindWorkspace } from '../src/host/workspace/bind.ts'
import { createLocker, lockKey, type Hold } from '../src/host/workspace/write.ts'

const [root = '', home = ''] = process.argv.slice(2)
const say = (value: unknown) => void process.stdout.write(`${JSON.stringify(value)}\n`)

const binding = await bindWorkspace({
  workspace: { roots: [{ path: root, write: true }], exclude: [], skip: [] },
  start: root,
  home,
  configFile: path.join(home, 'toolscript.json'),
  log: () => {},
})
if (!binding.ok) throw new Error(binding.reason)
const client = new Client({ name: 'lock-child', version: '0' })
await client.connect(await binding.bound.provider.serve())
const locker = createLocker(home)
let held: Hold | undefined

say({ ready: true })
for await (const line of readline.createInterface({ input: process.stdin })) {
  const cmd = JSON.parse(line) as {
    id?: number
    edit?: Record<string, unknown>
    hold?: string
    release?: true
    exit?: true
  }
  if (cmd.exit) process.exit(0)
  if (cmd.edit !== undefined) {
    const r = await client.callTool({ name: 'edit', arguments: cmd.edit })
    const text = (r.content as { text: string }[])[0]?.text ?? ''
    say(r.isError === true ? { id: cmd.id, ok: false, text } : { id: cmd.id, ok: true, result: r.structuredContent })
  } else if (cmd.hold !== undefined) {
    held = await locker.hold(lockKey(binding.bound.root, [cmd.hold]), new AbortController().signal)
    say({ id: cmd.id, held: true })
  } else if (cmd.release) {
    await held?.release()
    say({ id: cmd.id, released: true })
  }
}
