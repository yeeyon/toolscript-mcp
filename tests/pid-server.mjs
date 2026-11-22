// A small MCP server over stdio for the broker tests. Tools: `pid` (the process id), `env` (one variable), `cwd`,
// `sleep` (replies after `ms`, or never when its request is cancelled), `exit` (ends the process), `grow` (adds a tool `extra` and sends tools/list_changed), `flood` (writes with no newline for ever), `swell` (answers with a line under 10 MB that is longer when written again). With `--ignore-eof`
// it keeps running when stdin ends, as a server that ignores EOF does. With `--noinit` it never answers `initialize`.
// `--list-changed` sends tools/list_changed after each `tools/list`.

import readline from 'node:readline'

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)
const text = t => ({ content: [{ type: 'text', text: String(t) }] })
const object = properties => ({ type: 'object', properties })
const TOOLS = [
  { name: 'pid', description: 'The process id.', inputSchema: object({}) },
  { name: 'env', description: 'One variable.', inputSchema: object({ name: { type: 'string' } }) },
  { name: 'cwd', description: 'The folder.', inputSchema: object({}) },
  { name: 'sleep', description: 'Waits.', inputSchema: object({ ms: { type: 'number' } }) },
  { name: 'exit', description: 'Ends the process.', inputSchema: object({}) },
  { name: 'grow', description: 'Adds a tool.', inputSchema: object({}) },
  { name: 'flood', description: 'Writes to stdout for ever with no newline.', inputSchema: object({}) },
  { name: 'swell', description: 'Answers with a line that grows when it is written again.', inputSchema: object({}) },
]
const timers = new Map()

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'notifications/cancelled') {
    clearTimeout(timers.get(msg.params?.requestId))
    return void timers.delete(msg.params?.requestId)
  }
  if (msg.id === undefined) return
  const reply = result => send({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize') {
    if (process.argv.includes('--noinit')) return
    return reply({
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'pid-server', version: '1.0.0' },
    })
  }
  if (msg.method === 'ping') return reply({})
  if (msg.method === 'tools/list') {
    reply({ tools: TOOLS })
    if (process.argv.includes('--list-changed')) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    return
  }
  if (msg.method !== 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } })
  const { name, arguments: args = {} } = msg.params ?? {}
  if (name === 'pid') return reply(text(process.pid))
  if (name === 'env') return reply(text(process.env[args.name] ?? ''))
  if (name === 'cwd') return reply(text(process.cwd()))
  if (name === 'exit') return process.exit(3)
  if (name === 'flood') {
    const piece = 'y'.repeat(1 << 20)
    const pump = () => {
      while (process.stdout.write(piece));
      process.stdout.once('drain', pump)
    }
    return pump()
  }
  if (name === 'swell') {
    // A line under 10 MB whose numbers JSON.stringify writes out longer (1e9 is 1000000000): 26 MB after a parse.
    const many = Array(Math.floor(9.5 * 2 ** 18))
      .fill('1e9')
      .join(',')
    return process.stdout.write(
      `{"jsonrpc":"2.0","id":${JSON.stringify(msg.id)},"result":{"content":[],"n":[${many}]}}\n`,
    )
  }
  if (name === 'grow') {
    TOOLS.push({ name: 'extra', description: 'Added by grow.', inputSchema: object({}) })
    reply(text('grown'))
    return send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }
  if (name === 'sleep') {
    timers.set(
      msg.id,
      setTimeout(
        () => {
          timers.delete(msg.id)
          reply(text(`slept ${args.ms}`))
        },
        Number(args.ms) || 0,
      ),
    )
    return
  }
  reply({ content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true })
})
if (process.argv.includes('--ignore-eof')) setInterval(() => {}, 1000)
