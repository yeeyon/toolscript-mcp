// A stdio MCP server with one tool, `probe`, which returns the server's pid.
// It answers a call of any tool name, also of a name it does not list.
// At start it writes its pid and environment as JSON to the file in its first
// argument. It appends each start, each call (with the tool name) and each
// cancelled request as a JSON line, with its pid and its parent's pid, to that
// file plus `.log`. The mode in the second argument:
//   --exit-after-list  exits once it has listed its tools
//   --exit-after-call  exits once it has answered one call
//   --hang-calls       never answers a call
//   --exit-on-call     exits when a call comes, with no answer
//   --write-on-call    a call of `probe` writes its `text` argument to its `path` argument
//   --requires-person  lists `probe` with _meta["anthropic/requiresUserInteraction"] = true
//   --list-changed     declares tools.listChanged. After each call it sends notifications/tools/list_changed,
//                      and its next lists mark `probe` and name the number of changes in its description. The
//                      list answers after the `listDelayMs` argument of the last call. It logs each list.
//
//   node tests/probe-server.mjs /tmp/probe.json [mode]

import fs from 'node:fs'
import readline from 'node:readline'

const [file, mode] = process.argv.slice(2)
const event = e =>
  fs.appendFileSync(`${file}.log`, `${JSON.stringify({ ...e, pid: process.pid, ppid: process.ppid })}\n`)
fs.writeFileSync(file, JSON.stringify({ pid: process.pid, env: process.env }))
event({ event: 'start' })

let changes = 0
let listDelayMs = 0

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)

readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  if (msg.method === 'notifications/cancelled') return event({ event: 'cancelled', requestId: msg.params.requestId })
  if (msg.id === undefined) return
  const reply = result => send({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize')
    return reply({
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: mode === '--list-changed' ? { listChanged: true } : {} },
      serverInfo: { name: 'probe', version: '1.0.0' },
    })
  if (msg.method === 'tools/list') {
    event({ event: 'list' })
    const marked = mode === '--requires-person' || changes > 0
    const meta = marked ? { _meta: { 'anthropic/requiresUserInteraction': true } } : {}
    const description = mode === '--list-changed' ? `Probe, ${changes} changes.` : 'Probe.'
    const tools = [{ name: 'probe', description, inputSchema: { type: 'object' }, ...meta }]
    setTimeout(() => reply({ tools }), listDelayMs)
    if (mode === '--exit-after-list') setTimeout(() => process.exit(3), 200)
    return
  }
  if (msg.method === 'tools/call') {
    event({ event: 'call', name: msg.params.name })
    if (mode === '--write-on-call' && msg.params.name === 'probe')
      fs.writeFileSync(msg.params.arguments.path, msg.params.arguments.text)
    if (mode === '--hang-calls') return
    if (mode === '--exit-on-call') process.exit(3)
    reply({ content: [{ type: 'text', text: String(process.pid) }] })
    if (mode === '--exit-after-call') setTimeout(() => process.exit(3), 50)
    if (mode === '--list-changed') {
      changes++
      listDelayMs = Number(msg.params.arguments?.listDelayMs ?? 0)
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
    return
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
})
