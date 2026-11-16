// `toolscript-mcp login <server>`: the OAuth login of one HTTP server of the
// config. It listens for the callback on 127.0.0.1, opens the browser at the
// authorization URL, checks the state, gives the code to the SDK, then
// connects and counts the tools. It prints to stderr, as init does. It never
// prints a token, code, verifier or client secret.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  configPath,
  invalidReason,
  parseConfig,
  redact,
  serverKey,
  type Env,
  type HttpServer,
  type OAuth,
  type ServerKey,
} from '../core/config.ts'
import { errorText } from '../core/protocol.ts'
import { CONNECT_TIMEOUT_MS, listAll, serverFetch } from './downstream.ts'
import { isLoopbackHttp, oauthProvider, readStore, storeFile, type Stored } from './oauth.ts'

export const LOGIN_USAGE = 'usage: toolscript-mcp login <server> [--config <path>]'

/** The longest wait for the person to finish the login in the browser. */
const LOGIN_TIMEOUT_MS = 5 * 60_000

export type LoginIo = {
  readonly env: Env
  readonly platform: string
  readonly home: string
  readonly version: string
  readonly print: (text: string) => void
  /** Opens the URL in the browser. A test gives one that follows the redirect. */
  readonly open?: (url: string) => void
}

/** Opens `url` in the default browser. A failure is silent: login also prints the URL. */
const openBrowser =
  (platform: string) =>
  (url: string): void => {
    const [command, args] =
      platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  }

type Callback = { readonly ok: true; readonly code: string } | { readonly ok: false; readonly why: string }

/** `text` with each control character as `\uXXXX`, so text from the browser cannot move the cursor or fake a line. */
const escapeControls = (text: string): string =>
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** Listens on 127.0.0.1:`port` for the one callback of the login. Rejects with EADDRINUSE when the port is taken. */
const listen = async (port: number, state: string) => {
  let settle: (callback: Callback) => void = () => {}
  const answer = new Promise<Callback>(resolve => (settle = resolve))
  let done = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') return void res.writeHead(404).end()
    const reply = (status: number, text: string) =>
      void res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(`toolscript-mcp: ${text}\n`)
    if (done) return reply(409, 'this login is over. You can close this tab.')
    const q = url.searchParams
    // The state comes back only from the browser that this login opened. Any local page can send a wrong one, so it
    // gets no answer from the login, which waits on.
    if (q.get('state') !== state) return reply(400, 'login refused: wrong state.')
    done = true
    const error = q.get('error')
    const code = q.get('code')
    if (error !== null || code === null) {
      const detail = q.get('error_description')
      settle({
        ok: false,
        why: escapeControls(`the authorization server answered ${error ?? 'no code'}${detail ? `: ${detail}` : ''}`),
      })
      return reply(400, 'login failed. See the terminal.')
    }
    settle({ ok: true, code })
    reply(200, 'login done. You can close this tab.')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    port: (server.address() as AddressInfo).port,
    answer,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

const plural = (n: number) => `${n} tool${n === 1 ? '' : 's'}`

/** The port of a stored redirect URL. */
const portOf = (url: string | undefined): number | undefined => {
  const port = url === undefined ? '' : new URL(url).port
  return port === '' ? undefined : Number(port)
}

type Found = { readonly key: ServerKey; readonly server: HttpServer; readonly oauth: OAuth }

/** The HTTP server `name` of the config and its OAuth entry, or why it cannot log in. */
const serverOf = (name: string, file: string, io: LoginIo): Found | string => {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return `cannot read the config ${file}: ${errorText(err)}`
  }
  const parsed = parseConfig(text, io.env, process.execPath, io.platform)
  if (!parsed.ok) return [`the config ${file} has errors:`, ...parsed.errors.map(e => `  ${e}`)].join('\n')
  const key = serverKey(name)
  const entry = key === undefined ? undefined : parsed.config.servers.get(key)
  if (key === undefined || entry === undefined) return `the config ${file} has no server "${name}"`
  if (entry.kind === 'invalid') return `${name}: ${invalidReason(entry.errors)}`
  if (entry.kind === 'stdio') return `${name} is a stdio server. Only an HTTP server logs in with OAuth.`
  if (entry.oauth === undefined)
    return `${name} does not log in with OAuth: it has headers, or "oauth": false. To log in, remove an Authorization header and set "oauth": true.`
  return { key, server: entry, oauth: entry.oauth }
}

/** Runs login with these arguments and returns the exit code. */
export const runLogin = async (args: readonly string[], io: LoginIo): Promise<number> => {
  let parsed
  try {
    parsed = parseArgs({ args: [...args], options: { config: { type: 'string' } }, allowPositionals: true })
  } catch (err) {
    io.print(`${errorText(err)}\n${LOGIN_USAGE}`)
    return 2
  }
  const [name, ...rest] = parsed.positionals
  if (name === undefined || rest.length > 0) {
    io.print(LOGIN_USAGE)
    return 2
  }
  const file = path.resolve(configPath(parsed.values.config, io.env, io.platform, io.home))
  const found = serverOf(name, file, io)
  if (typeof found === 'string') {
    io.print(found)
    return 1
  }
  const { key, server, oauth } = found
  const store = storeFile(io.home, key, server.url)
  const state = randomBytes(32).toString('base64url')
  const kept = portOf((await readStore(store).catch(() => ({}) as Stored)).client?.redirectUrl)
  const port = oauth.callbackPort ?? kept ?? 0

  let callback: Awaited<ReturnType<typeof listen>>
  try {
    callback = await listen(port, state).catch(err => {
      // A taken port of a registered client: register a new client on a free port.
      if (oauth.callbackPort === undefined && kept !== undefined) return listen(0, state)
      throw err
    })
  } catch (err) {
    io.print(`cannot listen for the login callback on 127.0.0.1:${port}: ${errorText(err)}`)
    return 1
  }

  const open = io.open ?? openBrowser(io.platform)
  const provider = oauthProvider(store, oauth, {
    kind: 'login',
    redirectUrl: `http://127.0.0.1:${callback.port}/callback`,
    state,
    open: url => {
      // The URL comes from the metadata of the server. The browser opener also runs files and custom schemes.
      if (url.protocol !== 'https:' && !isLoopbackHttp(url))
        throw new Error(
          'the authorization URL from the server is not https, or http on 127.0.0.1, ::1 or localhost, so login did not open it',
        )
      io.print(`Log in to ${key} in the browser. If the browser does not open, open this URL:\n${url.href}`)
      open(url.href)
    },
  })
  const connect = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      authProvider: provider,
      fetch: serverFetch(server),
    })
    const client = new Client({ name: 'toolscript-mcp', version: io.version })
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      return { client, transport }
    } catch (err) {
      await client.close().catch(() => {})
      if (err instanceof UnauthorizedError) return { transport }
      throw err
    }
  }

  let timer: NodeJS.Timeout | undefined
  let client: Client | undefined
  let code: string | undefined
  // A server can echo the request in an error: the state, the code, the verifier, the client secret or a token.
  const hide = (text: string) => redact(text, server, [...provider.secrets(), ...(code === undefined ? [] : [code])])
  try {
    const first = await connect()
    client = first.client
    if (client !== undefined) {
      io.print(`${key} needs no login: it answered without a token. It has ${plural((await listAll(client)).length)}.`)
      return 0
    }
    const timeout = new Promise<Callback>(resolve => {
      timer = setTimeout(() => resolve({ ok: false, why: 'no login in the browser in 5 minutes' }), LOGIN_TIMEOUT_MS)
    })
    const answer = await Promise.race([callback.answer, timeout])
    if (!answer.ok) {
      io.print(`login to ${key} failed: ${hide(answer.why)}`)
      return 1
    }
    code = answer.code
    await first.transport.finishAuth(code)
    client = (await connect()).client
    if (client === undefined) throw new Error('the server still asks for a login after the token exchange')
    const tools = await listAll(client)
    const mode = io.platform === 'win32' ? '' : ' (mode 0600)'
    io.print(`Logged in to ${key}. It has ${plural(tools.length)}. The tokens are in ${store}${mode}.`)
    return 0
  } catch (err) {
    io.print(`login to ${key} failed: ${hide(errorText(err))}`)
    return 1
  } finally {
    clearTimeout(timer)
    callback.close()
    await client?.close().catch(() => {})
  }
}
