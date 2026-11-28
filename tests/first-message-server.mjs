// A raw stdio MCP server for tests/protocol-flag.e2e.mjs, with no SDK. It writes the first line that it receives to the
// file of `--log=FILE` (the first message of a link), and has one tool, `ask`: during the call it sends the three requests
// that a downstream server may not make of the host (roots/list, elicitation/create, sampling/createMessage), waits for
// the three answers and returns them as the text of the result.

import fs from 'node:fs'
import readline from 'node:readline'

const log = process.argv.find(a => a.startsWith('--log='))?.slice('--log='.length)
let first = true
const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)
const waiting = new Map()
const REQUESTS = [
  ['roots/list', {}],
  ['elicitation/create', { message: 'Allow?', requestedSchema: { type: 'object', properties: {} } }],
  ['sampling/createMessage', { messages: [], maxTokens: 1 }],
]

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  if (first && log !== undefined) fs.appendFileSync(log, `${line}\n`)
  first = false
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === undefined && msg.id !== undefined) return void waiting.get(msg.id)?.(msg)
  if (msg.id === undefined) return
  const reply = result => send({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize')
    return reply({
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'first-message-server', version: '1.0.0' },
    })
  if (msg.method === 'tools/list')
    return reply({
      tools: [{ name: 'ask', description: 'Asks the host three things.', inputSchema: { type: 'object' } }],
    })
  if (msg.method === 'tools/call') {
    const answers = REQUESTS.map(
      ([method, params], i) =>
        new Promise(resolve => {
          const id = `q${i}`
          waiting.set(id, resolve)
          send({ jsonrpc: '2.0', id, method, params })
        }),
    )
    return void Promise.all(answers).then(all =>
      reply({
        content: [
          {
            type: 'text',
            text: JSON.stringify(all.map((a, i) => ({ method: REQUESTS[i][0], error: a.error, result: a.result }))),
          },
        ],
      }),
    )
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
})
