// AWS SigV4 signing of the requests to an HTTP server (issue #135), with no proxy process. The credentials come from
// `aws configure export-credentials --profile <name>`: the AWS CLI resolves SSO, roles and its own caches, and a new
// `aws sso login` needs no restart here. No function here logs a key, a token or a signature.

import { createHash, createHmac } from 'node:crypto'
import crossSpawn from 'cross-spawn'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { hideArgSecrets, type SigV4 } from '../core/config.ts'
import { endTree } from './broker.ts'

export type AwsCredentials = {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  /** When the credentials expire, in ms since the epoch. Undefined for long-lived keys. */
  readonly expiresAt?: number
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding, as SigV4 wants it: every byte but the unreserved characters. */
const encode = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** The canonical path: each segment as sent, encoded once more, as AWS computes it for a service other than S3. */
const canonicalPath = (pathname: string): string => pathname.split('/').map(encode).join('/') || '/'

/** A percent-decode that never reads `+` as a space. A bad escape stays as it is. */
const decode = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** The canonical query: the raw parts, split at the first `=`, decoded and encoded again. A `+` stays a plus sign. */
const canonicalQuery = (search: string): string =>
  search
    .replace(/^\?/, '')
    .split('&')
    .filter(part => part !== '')
    .map(part => {
      const at = part.indexOf('=')
      return (at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)]) as [string, string]
    })
    .map(([k, v]) => [encode(decode(k)), encode(decode(v))] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

/**
 * The headers to add to one request: `x-amz-date`, `x-amz-security-token` when the credentials have one, and
 * `authorization`. It signs `host`, those `x-amz-` headers and `content-type` when the request has one.
 */
export const signRequest = (
  request: {
    readonly method: string
    readonly url: string
    readonly headers: Headers
    readonly body: string | Uint8Array
  },
  credentials: AwsCredentials,
  scope: { readonly region: string; readonly service: string },
  now: Date,
): Record<string, string> => {
  const url = new URL(request.url)
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const added: Record<string, string> = { 'x-amz-date': amzDate }
  if (credentials.sessionToken !== undefined) added['x-amz-security-token'] = credentials.sessionToken
  const signed: Record<string, string> = { host: url.host, ...added }
  const contentType = request.headers.get('content-type')
  if (contentType !== null) signed['content-type'] = contentType
  const names = Object.keys(signed).sort()
  const canonical = [
    request.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.search),
    names.map(n => `${n}:${signed[n]!.trim().replace(/\s+/g, ' ')}\n`).join(''),
    names.join(';'),
    sha256(request.body),
  ].join('\n')
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonical)].join('\n')
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day)
  for (const part of [scope.region, scope.service, 'aws4_request']) key = hmac(key, part)
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  added.authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${names.join(';')}, Signature=${signature}`
  return added
}

/** Credentials this close to their expiry are fetched again before a request. */
const EARLY_MS = 5 * 60_000
/** The longest wait for the AWS CLI. */
const CLI_TIMEOUT_MS = 30_000
/** The most bytes of output of the AWS CLI that are read. */
const MAX_OUTPUT = 64 * 1024

/** An error whose message is the reason to show: the credentials of the profile could not be read. */
export class AwsCredentialsError extends Error {}

/** The parse of `aws configure export-credentials --format process`, or undefined. */
export const parseExported = (text: string): AwsCredentials | undefined => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = raw as Record<string, unknown>
  if (typeof AccessKeyId !== 'string' || AccessKeyId === '' || typeof SecretAccessKey !== 'string') return undefined
  if (SecretAccessKey === '') return undefined
  const expiresAt = typeof Expiration === 'string' ? Date.parse(Expiration) : NaN
  return {
    accessKeyId: AccessKeyId,
    secretAccessKey: SecretAccessKey,
    ...(typeof SessionToken === 'string' && SessionToken !== '' && { sessionToken: SessionToken }),
    ...(Number.isFinite(expiresAt) && { expiresAt }),
  }
}

/** The reason when the AWS CLI gave no credentials. It names the profile and the login command, never the output. */
const failure = (profile: string, why: string): AwsCredentialsError =>
  new AwsCredentialsError(
    `could not get AWS credentials for the profile "${profile}" (${why}). ` +
      `If it is an SSO profile, run: aws sso login --profile ${profile}`,
  )

/** The reason when the AWS CLI does not answer within `limitMs`. */
export const timeoutReason = (limitMs: number): string =>
  `the AWS CLI did not answer in ${Math.round(limitMs / 100) / 10} s`

/**
 * The reason that the first line of stderr gives (an expired SSO token, an unknown profile), or undefined for no line.
 * A credential_process helper can print a secret in its error, so the line goes through the redaction of the config
 * rules before it is cut. The usage text of a CLI that has no `export-credentials` (version 1, or a version 2 from
 * before the command) becomes a short hint that names the missing command and no version number.
 */
export const stderrReason = (stderr: string): string | undefined => {
  const line = stderr
    .split(/\r?\n/)
    .find(l => l.trim() !== '')
    ?.trim()
  if (line === undefined) return undefined
  if (/^usage:/i.test(line))
    return 'this AWS CLI has no `configure export-credentials`: update to a current AWS CLI version 2'
  return hideArgSecrets([line]).args[0]!.slice(0, 300)
}

/** The `export-credentials` children in flight, so a shutdown can end each tree (a hung CLI is in its own group). */
const inFlight = new Set<ReturnType<typeof crossSpawn>>()

/** Ends the tree of each `export-credentials` child in flight. The host calls it when it closes. */
export const stopCredentialReads = (): Promise<void> =>
  Promise.all([...inFlight].map(child => endTree(child))).then(() => {})

/** Runs `aws configure export-credentials` for a profile. `command` and `limitMs` are for tests. */
export const exportCredentials = (
  profile: string,
  command = 'aws',
  limitMs = CLI_TIMEOUT_MS,
): Promise<AwsCredentials> =>
  new Promise((resolve, reject) => {
    let child: ReturnType<typeof crossSpawn>
    try {
      child = crossSpawn(command, ['configure', 'export-credentials', '--profile', profile, '--format', 'process'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // A process group, so endTree ends a helper that the CLI started.
        detached: process.platform !== 'win32',
      })
    } catch {
      reject(failure(profile, 'the AWS CLI did not start'))
      return
    }
    inFlight.add(child)
    let out = ''
    let err = ''
    let settled = false
    const settle = (end: () => void): void => {
      if (settled) return
      settled = true
      inFlight.delete(child)
      clearTimeout(timer)
      end()
    }
    // A pipe error after the destroy would otherwise be an uncaught exception.
    for (const stream of [child.stdout, child.stderr]) stream?.on('error', () => {})
    child.stdout?.on('data', (b: Buffer) => void (!settled && out.length < MAX_OUTPUT && (out += b.toString('utf8'))))
    child.stderr?.on('data', (b: Buffer) => void (!settled && err.length < MAX_OUTPUT && (err += b.toString('utf8'))))
    const timer = setTimeout(
      () =>
        settle(() => {
          reject(failure(profile, timeoutReason(limitMs)))
          // A grandchild can keep the pipes open, so the reject does not wait for close.
          endTree(child)
          child.stdout?.destroy()
          child.stderr?.destroy()
        }),
      limitMs,
    )
    child.on('error', (e: NodeJS.ErrnoException) =>
      settle(() =>
        reject(
          failure(profile, e.code === 'ENOENT' ? 'the AWS CLI "aws" is not on PATH' : 'the AWS CLI did not start'),
        ),
      ),
    )
    child.on('close', (code, signal) =>
      settle(() => {
        const credentials = code === 0 ? parseExported(out) : undefined
        if (credentials) return resolve(credentials)
        const why =
          code === 0 ? 'the AWS CLI printed no credentials' : code === null ? `killed by ${signal}` : `exit ${code}`
        reject(failure(profile, stderrReason(err) ?? why))
      }),
    )
  })

/**
 * The body with the pairs in `params._meta`, as `mcp-proxy-for-aws` injects them (its `_inject_metadata_hook`): only
 * a JSON-RPC object that has `params`, a pair that `_meta` already holds stays as it is, and a `_meta` that is not an
 * object is replaced. Any other body comes back as it is, byte for byte.
 */
export const injectMetadata = (body: string, metadata: Readonly<Record<string, string>>): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isObject(parsed) || !('jsonrpc' in parsed) || !isObject(parsed.params)) return body
  const existing = parsed.params._meta
  parsed.params._meta = isObject(existing) ? { ...metadata, ...existing } : { ...metadata }
  return JSON.stringify(parsed)
}

/**
 * A fetch that signs each request to the origin of the server with the credentials of the profile. The credentials
 * stay in memory until 5 minutes before they expire, then the next request reads them again. A failed read is not
 * kept: the next request tries again, so a new `aws sso login` works without a restart. When the read fails before
 * the expiry, the request is signed with the credentials in use.
 */
export const sigv4Fetch = (
  server: { readonly url: string; readonly sigv4: SigV4; readonly headers?: Readonly<Record<string, string>> },
  base: FetchLike,
  load: (profile: string) => Promise<AwsCredentials> = exportCredentials,
  clock: () => number = Date.now,
): FetchLike & { readonly secrets: () => readonly string[] } => {
  const origin = new URL(server.url).origin
  let current: AwsCredentials | undefined
  let pending: Promise<AwsCredentials> | undefined
  const credentials = async (): Promise<AwsCredentials> => {
    if (current && (current.expiresAt === undefined || current.expiresAt - EARLY_MS > clock())) return current
    pending ??= load(server.sigv4.profile).finally(() => (pending = undefined))
    try {
      current = await pending
      return current
    } catch (error) {
      // Inside the last 5 minutes the credentials in use still work. A failed read keeps them until they expire.
      if (current?.expiresAt !== undefined && current.expiresAt > clock()) return current
      throw error
    }
  }
  const signed: FetchLike = async (url, init) => {
    const target = new URL(url)
    if (target.origin !== origin) return base(url, init)
    const headers = new Headers(init?.headers)
    // The config headers go on before the signature, so the base fetch that sets them again changes no signed value.
    for (const [name, value] of Object.entries(server.headers ?? {})) headers.set(name, value)
    const body = init?.body
    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array))
      throw new Error('a SigV4 request body must be a string or bytes')
    // The pairs go in before the signature, so it covers the body as sent. No pairs: the body is not touched.
    const sent = typeof body === 'string' && server.sigv4.metadata ? injectMetadata(body, server.sigv4.metadata) : body
    const added = signRequest(
      { method: init?.method ?? 'GET', url: target.href, headers, body: sent ?? '' },
      await credentials(),
      server.sigv4,
      new Date(clock()),
    )
    for (const [name, value] of Object.entries(added)) headers.set(name, value)
    // fetch would follow a redirect with the session token in x-amz-security-token, also to another origin. The 3xx
    // goes back to the SDK as an error instead.
    return base(url, { ...init, ...(sent !== body && { body: sent }), headers, redirect: 'manual' })
  }
  // A server can echo a header of a refused request in its error body, and that text reaches the model and the log.
  const secrets = (): readonly string[] =>
    current
      ? [current.accessKeyId, current.secretAccessKey, ...(current.sessionToken ? [current.sessionToken] : [])]
      : []
  return Object.assign(signed, { secrets })
}
