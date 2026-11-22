// One toolscript-mcp process of tests/oauth-lock.test.ts. It runs the real connect and a tool call of
// src/host/downstream.ts for each server of the config, over the store in HOME. The parent drives it on stdin:
// `go` runs one round, `exit` ends it. It answers on stdout, one JSON line each: `ready`, then for each round one
// `{ key, text, at }` line for each server and `end`. Arguments: the home folder, the config file and the refresh
// timeout in ms.

import fs from 'node:fs'
import readline from 'node:readline'
import { parseConfig } from '../src/core/config.ts'
import { connectAll } from '../src/host/downstream.ts'

const [home = '', configFile = '', refreshMs = ''] = process.argv.slice(2)
const parsed = parseConfig(fs.readFileSync(configFile, 'utf8'), {}, process.execPath, process.platform)
if (!parsed.ok) throw new Error('bad config')
const say = (value: unknown) => void process.stdout.write(`${JSON.stringify(value)}\n`)

const round = async () => {
  const downstream = connectAll(parsed.config.servers, '0', () => {}, {
    home,
    ...(refreshMs !== '' && { refreshTimeoutMs: Number(refreshMs) }),
  })
  try {
    await Promise.all(
      [...parsed.config.servers.keys()].map(async key => {
        const link = await downstream.client(key)
        let text: string
        if (!link.ok) text = link.reason
        else {
          const r = await link.client.callTool({ name: 'ping', arguments: {} }).catch((err: Error) => err)
          text = r instanceof Error ? r.message : JSON.stringify(r.content)
        }
        say({ key, text, at: Date.now() })
      }),
    )
  } finally {
    await downstream.close()
  }
  say({ end: true })
}

say({ ready: true })
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (line === 'go') await round()
  if (line === 'exit') process.exit(0)
}
