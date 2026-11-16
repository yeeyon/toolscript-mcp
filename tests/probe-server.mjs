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
//   --add-later        after n calls, its lists also have the tools `added1` to `added<n>`, with no notification
//   --endless-list     each page of its tool list names a next page
//   --list-changed     declares tools.listChanged. After each call it sends notifications/tools/list_changed, as
//                      many times as the `notifications` argument of the call (1 when absent). Its next lists mark
//                      `probe` and name the number of changes in its description. The number is kept in the file
//                      plus `.changes`, so a restarted server keeps it. A list answers after the `listDelayMs`
//                      argument of the last call. After a call with `failList`, each list of this process answers
//                      an error. It logs each list.
//   --changes-before   declares tools.listChanged and sends notifications/tools/list_changed before each list reply
//   --changes-after    the same, after each list reply
//
//   node tests/probe-server.mjs /tmp/probe.json [mode]

import fs from 'node:fs'
import readline from 'node:readline'

const [file, mode] = process.argv.slice(2)
const event = e =>
  fs.appendFileSync(`${file}.log`, `${JSON.stringify({ ...e, pid: process.pid, ppid: process.ppid })}\n`)
fs.writeFileSync(file, JSON.stringify({ pid: process.pid, env: process.env }))
event({ event: 'start' })

const changesFile = `${file}.changes`
const changes = () => (fs.existsSync(changesFile) ? Number(fs.readFileSync(changesFile, 'utf8')) : 0)
let listDelayMs = 0
let failList = false
let calls = 0

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)
const changed = () => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
const announces = ['--list-changed', '--changes-before', '--changes-after'].includes(mode)

readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  if (msg.method === 'notifications/cancelled') return event({ event: 'cancelled', requestId: msg.params.requestId })
  if (msg.id === undefined) return
  const reply = result => send({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize')
    return reply({
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: announces ? { listChanged: true } : {} },
      serverInfo: { name: 'probe', version: '1.0.0' },
    })
  if (msg.method === 'tools/list') {
    event({ event: 'list' })
    if (failList) {
      const error = { code: -32603, message: 'the tool list failed' }
      return void setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, error }), listDelayMs)
    }
    const marked = mode === '--requires-person' || changes() > 0
    const meta = marked ? { _meta: { 'anthropic/requiresUserInteraction': true } } : {}
    const description = mode === '--list-changed' ? `Probe, ${changes()} changes.` : 'Probe.'
    const tools = [{ name: 'probe', description, inputSchema: { type: 'object' }, ...meta }]
    if (mode === '--add-later')
      for (let n = 1; n <= calls; n++) tools.push({ name: `added${n}`, inputSchema: { type: 'object' } })
    if (mode === '--changes-before') changed()
    setTimeout(() => {
      reply(mode === '--endless-list' ? { tools, nextCursor: 'more' } : { tools })
      if (mode === '--changes-after') changed()
    }, listDelayMs)
    if (mode === '--exit-after-list') setTimeout(() => process.exit(3), 200)
    return
  }
  if (msg.method === 'tools/call') {
    event({ event: 'call', name: msg.params.name })
    calls++
    if (mode === '--write-on-call' && msg.params.name === 'probe')
      fs.writeFileSync(msg.params.arguments.path, msg.params.arguments.text)
    if (mode === '--hang-calls') return
    if (mode === '--exit-on-call') process.exit(3)
    reply({ content: [{ type: 'text', text: String(process.pid) }] })
    if (mode === '--exit-after-call') setTimeout(() => process.exit(3), 50)
    if (mode === '--list-changed') {
      fs.writeFileSync(changesFile, String(changes() + 1))
      listDelayMs = Number(msg.params.arguments?.listDelayMs ?? 0)
      failList = msg.params.arguments?.failList === true
      for (let i = 0; i < Number(msg.params.arguments?.notifications ?? 1); i++) changed()
    }
    return
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
})
