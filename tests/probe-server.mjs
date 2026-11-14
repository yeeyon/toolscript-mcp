// A stdio MCP server with one tool, `probe`, which returns the server's pid.
// At start it writes its pid and environment as JSON to the file in its first
// argument. It appends each start and each cancelled request as a JSON line,
// with its pid and its parent's pid, to that file plus `.log`. The mode in the
// second argument:
//   --exit-after-list  exits once it has listed its tools
//   --exit-after-call  exits once it has answered one call
//   --hang-calls       never answers a call
//
//   node tests/probe-server.mjs /tmp/probe.json [mode]

import fs from 'node:fs'
import readline from 'node:readline'

const [file, mode] = process.argv.slice(2)
const event = e =>
  fs.appendFileSync(`${file}.log`, `${JSON.stringify({ ...e, pid: process.pid, ppid: process.ppid })}\n`)
fs.writeFileSync(file, JSON.stringify({ pid: process.pid, env: process.env }))
event({ event: 'start' })

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)

readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  if (msg.method === 'notifications/cancelled') return event({ event: 'cancelled', requestId: msg.params.requestId })
  if (msg.id === undefined) return
  const reply = result => send({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize')
    return reply({
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'probe', version: '1.0.0' },
    })
  if (msg.method === 'tools/list') {
    reply({ tools: [{ name: 'probe', description: 'Probe.', inputSchema: { type: 'object' } }] })
    if (mode === '--exit-after-list') setTimeout(() => process.exit(3), 200)
    return
  }
  if (msg.method === 'tools/call') {
    if (mode === '--hang-calls') return
    reply({ content: [{ type: 'text', text: String(process.pid) }] })
    if (mode === '--exit-after-call') setTimeout(() => process.exit(3), 50)
    return
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
})
