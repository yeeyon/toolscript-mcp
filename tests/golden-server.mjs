// A stdio MCP server that writes raw JSON-RPC lines and imports no SDK, so the golden test of the error texts
// (tests/errors-golden.test.ts) depends on no SDK version. It lists one tool for each case and answers a call by the
// tool name. The first argument is the file that it appends one line to for each message that it receives (the method,
// and for `initialize` the whole params), so a test can see what the client sent.
//
// A second argument `nocaps` makes it declare no capabilities and answer `tools/list` with -32601.
//
//   node tests/golden-server.mjs /tmp/log.jsonl [nocaps]

import fs from 'node:fs'
import readline from 'node:readline'

const [log, mode] = process.argv.slice(2)
const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)
const OBJECT = { type: 'object', properties: {} }
const TOOLS = [
  { name: 'ok', inputSchema: OBJECT },
  { name: 'bad_result', inputSchema: OBJECT },
  { name: 'invalid_params', inputSchema: OBJECT },
  { name: 'no_method', inputSchema: OBJECT },
  { name: 'internal', inputSchema: OBJECT },
  { name: 'custom', inputSchema: OBJECT },
  { name: 'stall', inputSchema: OBJECT },
  { name: 'die', inputSchema: OBJECT },
  { name: 'is_error', inputSchema: OBJECT },
  {
    name: 'no_structured',
    inputSchema: OBJECT,
    outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
  },
  {
    name: 'bad_output',
    inputSchema: OBJECT,
    outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
  },
]
const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data && { data }) } })

readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  if (log)
    fs.appendFileSync(
      log,
      `${JSON.stringify({ method: msg.method, ...(msg.method === 'initialize' && { params: msg.params }) })}\n`,
    )
  if (msg.method === 'initialize')
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: mode === 'nocaps' ? {} : { tools: {} },
        serverInfo: { name: 'golden', version: '1' },
      },
    })
  if (msg.id === undefined) return
  if (msg.method === 'tools/list' && mode === 'nocaps') return fail(msg.id, -32601, 'golden: no tools here')
  // A list that breaks the result schema of the SDK: a tool with no inputSchema.
  if (msg.method === 'tools/list' && mode === 'badlist')
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'x' }] } })
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
  if (msg.method !== 'tools/call') return fail(msg.id, -32601, `method not found: ${msg.method}`)
  const text = (t, extra) =>
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: t }], ...extra } })
  switch (msg.params.name) {
    case 'ok':
      return text('fine')
    case 'invalid_params':
      return fail(msg.id, -32602, 'golden: invalid params text')
    case 'no_method':
      return fail(msg.id, -32601, 'golden: method not found text')
    case 'internal':
      return fail(msg.id, -32603, 'golden: internal error text')
    case 'custom':
      return fail(msg.id, -31001, 'golden: custom error text', { detail: 'x' })
    case 'stall':
      return
    case 'die':
      return void process.stderr.write('golden: dying\n', () => process.exit(3))
    case 'is_error':
      return text('golden: the tool failed', { isError: true })
    case 'bad_result':
      // A result that breaks the result schema of the SDK: a text block with no text.
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text' }] } })
    case 'no_structured':
      return text('plain text only')
    case 'bad_output':
      return text('{"n":"x"}', { structuredContent: { n: 'x' } })
    default:
      return fail(msg.id, -32602, `unknown tool: ${msg.params.name}`)
  }
})
