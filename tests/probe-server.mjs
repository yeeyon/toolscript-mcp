// A stdio MCP server with one tool, for tests/server.e2e.mjs. At start it
// writes its pid and environment as JSON to the file in its first argument.
// With --exit-after-list, it exits once it has listed its tools.
//
//   node tests/probe-server.mjs /tmp/probe.json [--exit-after-list]

import fs from 'node:fs'
import readline from 'node:readline'

fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, env: process.env }))

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)

readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
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
    if (process.argv[3] === '--exit-after-list') setTimeout(() => process.exit(3), 200)
    return
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
})
