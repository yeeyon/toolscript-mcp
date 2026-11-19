// A read-only demo MCP server (stdio, one JSON-RPC message per line) over the sample pull requests in data.mjs. It
// needs no account and no network, so a new setup can try one run_code task. stdout carries only JSON-RPC.
//
//   node demo/server.mjs

import readline from 'node:readline'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PULL_REQUESTS, REPOSITORY } from './data.mjs'

const STATES = ['open', 'closed', 'merged', 'all']
const READ_ONLY = { readOnlyHint: true }

const TOOLS = [
  {
    name: 'list_pull_requests',
    description: `List the pull requests of ${REPOSITORY}, newest number last. Pages of at most ${MAX_PAGE_SIZE}: pass next_cursor as cursor for the next page, until next_cursor is null.`,
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: STATES, description: 'Default "open".' },
        per_page: { type: 'number', description: `At most ${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}).` },
        cursor: { type: 'string' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_pull_request',
    description: `Get one pull request of ${REPOSITORY} by its number.`,
    inputSchema: { type: 'object', properties: { number: { type: 'number' } }, required: ['number'] },
    annotations: READ_ONLY,
  },
]

const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const fail = text => ({ content: [{ type: 'text', text }], isError: true })

// A cursor is the index of the next pull request in the filtered list, so it stays valid for the fixed data.
const handlers = {
  list_pull_requests: ({ state = 'open', per_page = DEFAULT_PAGE_SIZE, cursor }) => {
    if (!STATES.includes(state)) return fail(`state must be one of ${STATES.join(', ')}`)
    const size = Math.trunc(Number(per_page))
    if (!(size >= 1 && size <= MAX_PAGE_SIZE)) return fail(`per_page must be a whole number from 1 to ${MAX_PAGE_SIZE}`)
    const start = cursor === undefined ? 0 : Number(cursor)
    const matching = PULL_REQUESTS.filter(pr => state === 'all' || pr.state === state)
    if (!Number.isSafeInteger(start) || start < 0 || start > matching.length) return fail(`unknown cursor: ${cursor}`)
    const end = start + size
    return json({
      pull_requests: matching.slice(start, end),
      next_cursor: end < matching.length ? String(end) : null,
    })
  },
  get_pull_request: ({ number }) => {
    const pr = PULL_REQUESTS.find(p => p.number === number)
    return pr === undefined ? fail(`no pull request ${number} in ${REPOSITORY}`) : json(pr)
  },
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

readline.createInterface({ input: process.stdin }).on('line', line => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message?.id === undefined) return
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result })
  const { method, params } = message
  if (method === 'initialize')
    return reply({
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'toolscript-demo', version: '1.0.0' },
    })
  if (method === 'ping') return reply({})
  if (method === 'tools/list') return reply({ tools: TOOLS })
  if (method === 'tools/call') {
    const handler = Object.hasOwn(handlers, params?.name) ? handlers[params.name] : undefined
    return reply(handler ? handler(params.arguments ?? {}) : fail(`unknown tool: ${params?.name}`))
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${method}` } })
})
