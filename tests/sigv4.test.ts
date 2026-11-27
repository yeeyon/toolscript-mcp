import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { awsEndpoint, parseConfig } from '../src/core/config.ts'
import { serverFetch } from '../src/host/downstream.ts'
import { parseExported, signRequest, sigv4Fetch, type AwsCredentials } from '../src/host/sigv4.ts'

test('a config Content-Type is the signed one, as serverFetch sends it after the signature', async () => {
  const now = Date.UTC(2026, 10, 23, 8)
  const server = {
    kind: 'http' as const,
    url: 'https://aws-mcp.us-east-1.api.aws/mcp',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    sigv4: { profile: 'p', region: 'us-east-1', service: 'aws-mcp' },
  }
  let sent: Headers | undefined
  const real = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sent = new Headers(init?.headers)
    return new Response('{}')
  }) as typeof fetch
  try {
    const signed = sigv4Fetch(
      server,
      serverFetch(server),
      async () => ({ accessKeyId: 'AKID', secretAccessKey: 'S' }),
      () => now,
    )
    await signed(server.url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  } finally {
    globalThis.fetch = real
  }
  assert.equal(sent!.get('content-type'), 'application/json; charset=utf-8')
  const again = signRequest(
    { method: 'POST', url: server.url, headers: sent!, body: '{}' },
    { accessKeyId: 'AKID', secretAccessKey: 'S' },
    server.sigv4,
    new Date(now),
  )
  assert.equal(sent!.get('authorization'), again.authorization, 'the sent headers match the signature')
})

test('a redirect of the signed server is not followed, so the session token reaches no other origin', async () => {
  let reached = false
  const other = http.createServer((_req, res) => {
    reached = true
    res.end('{}')
  })
  await new Promise<void>(r => other.listen(0, '127.0.0.1', r))
  const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal`
  const first = http.createServer((_req, res) => {
    res.writeHead(307, { location: otherUrl })
    res.end()
  })
  await new Promise<void>(r => first.listen(0, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${(first.address() as AddressInfo).port}/mcp`
    const signed = sigv4Fetch(
      { url, sigv4: { profile: 'p', region: 'us-east-1', service: 'aws-mcp' } },
      (u, i) => fetch(u, i),
      async () => ({ accessKeyId: 'AKID', secretAccessKey: 'S', sessionToken: 'SECRET' }),
    )
    const res = await signed(url, { method: 'POST', body: '{}' })
    assert.equal(res.status, 307)
    assert.equal(reached, false)
  } finally {
    first.close()
    other.close()
  }
})

// The example credentials of the AWS SigV4 test suite.
const EXAMPLE: AwsCredentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
}
const SUITE_DATE = new Date(Date.UTC(2015, 7, 30, 12, 36, 0))

test('signRequest gives the signature of the AWS test suite case get-vanilla', () => {
  const added = signRequest(
    { method: 'GET', url: 'https://example.amazonaws.com/', headers: new Headers(), body: '' },
    EXAMPLE,
    { region: 'us-east-1', service: 'service' },
    SUITE_DATE,
  )
  assert.equal(added['x-amz-date'], '20150830T123600Z')
  assert.equal(
    added.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, ' +
      'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  )
  assert.equal(added['x-amz-security-token'], undefined)
})

test('signRequest signs the session token and the content type, and the body changes the signature', () => {
  const sign = (body: string) =>
    signRequest(
      {
        method: 'POST',
        url: 'https://aws-mcp.us-east-1.api.aws/mcp',
        headers: new Headers({ 'content-type': 'application/json' }),
        body,
      },
      { ...EXAMPLE, sessionToken: 'TOKEN' },
      { region: 'us-east-1', service: 'aws-mcp' },
      SUITE_DATE,
    )
  const a = sign('{"jsonrpc":"2.0","id":1}')
  assert.equal(a['x-amz-security-token'], 'TOKEN')
  assert.match(a.authorization!, /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,/)
  assert.match(a.authorization!, /Credential=AKIDEXAMPLE\/20150830\/us-east-1\/aws-mcp\/aws4_request/)
  assert.notEqual(a.authorization, sign('{"jsonrpc":"2.0","id":2}').authorization)
})

test('parseExported reads the process format of the AWS CLI, and refuses a broken one', () => {
  assert.deepEqual(
    parseExported(
      '{"Version":1,"AccessKeyId":"AKID","SecretAccessKey":"S","SessionToken":"T","Expiration":"2026-11-23T10:00:00+00:00"}',
    ),
    { accessKeyId: 'AKID', secretAccessKey: 'S', sessionToken: 'T', expiresAt: Date.UTC(2026, 10, 23, 10) },
  )
  assert.deepEqual(parseExported('{"AccessKeyId":"AKID","SecretAccessKey":"S"}'), {
    accessKeyId: 'AKID',
    secretAccessKey: 'S',
  })
  assert.equal(parseExported('not json'), undefined)
  assert.equal(parseExported('{"AccessKeyId":"AKID"}'), undefined)
  assert.equal(parseExported('{"AccessKeyId":"","SecretAccessKey":"S"}'), undefined)
})

test('awsEndpoint reads the service and region of an AWS host, and nothing else', () => {
  assert.deepEqual(awsEndpoint('https://aws-mcp.us-east-1.api.aws/mcp'), { service: 'aws-mcp', region: 'us-east-1' })
  assert.deepEqual(awsEndpoint('https://bedrock.ap-southeast-1.amazonaws.com/x'), {
    service: 'bedrock',
    region: 'ap-southeast-1',
  })
  assert.equal(awsEndpoint('https://example.com/mcp'), undefined)
  assert.equal(awsEndpoint('https://aws-mcp.us-east-1.api.aws.evil.com/mcp'), undefined)
})

const entryOf = (entry: unknown) => {
  const parsed = parseConfig(JSON.stringify({ mcpServers: { aws: entry } }), {}, process.execPath, process.platform)
  assert.ok(parsed.ok)
  return parsed.config.servers.get('aws' as never)
}

test('a sigv4 entry takes the region and service from the AWS host, and takes no OAuth login', () => {
  const server = entryOf({ type: 'http', url: 'https://aws-mcp.us-east-1.api.aws/mcp', sigv4: { profile: 'dev' } })
  assert.equal(server?.kind, 'http')
  assert.ok(server?.kind === 'http')
  assert.deepEqual(server.sigv4, { profile: 'dev', region: 'us-east-1', service: 'aws-mcp' })
  assert.equal(server.oauth, undefined)
})

test('a sigv4 entry fails alone on a bad or missing field, or with oauth or an Authorization header', () => {
  const errorsOf = (entry: unknown): string => {
    const server = entryOf(entry)
    assert.equal(server?.kind, 'invalid', JSON.stringify(entry))
    return JSON.stringify(server)
  }
  const url = 'https://aws-mcp.us-east-1.api.aws/mcp'
  assert.match(errorsOf({ type: 'http', url, sigv4: {} }), /sigv4\.profile: is needed/)
  assert.match(errorsOf({ type: 'http', url, sigv4: { profile: 'a b' } }), /sigv4\.profile: is not a valid profile/)
  assert.match(errorsOf({ type: 'http', url, sigv4: { profile: 'p', region: 'mars' } }), /not a valid region/)
  assert.match(errorsOf({ type: 'http', url, sigv4: { profile: 'p', extra: 1 } }), /extra/)
  assert.match(
    errorsOf({ type: 'http', url, sigv4: { profile: 'p' }, oauth: true }),
    /does not log in: remove \\"oauth\\"/,
  )
  assert.match(
    errorsOf({ type: 'http', url, sigv4: { profile: 'p' }, headers: { Authorization: 'x' } }),
    /cannot sign with SigV4/,
  )
  assert.match(
    errorsOf({ type: 'http', url: 'https://example.com/mcp', sigv4: { profile: 'p' } }),
    /sigv4\.region: is needed, because the URL is not an AWS endpoint/,
  )
})

test('sigv4Fetch signs only the server origin, keeps credentials until near expiry, and retries a failed read', async () => {
  let now = Date.UTC(2026, 10, 23, 8)
  let loads = 0
  let fail = false
  const load = async (profile: string): Promise<AwsCredentials> => {
    assert.equal(profile, 'dev')
    loads++
    if (fail) throw new Error('expired')
    return { ...EXAMPLE, sessionToken: `T${loads}`, expiresAt: now + 60 * 60_000 }
  }
  const seen: Headers[] = []
  const base = async (_url: string | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers))
    return new Response('{}')
  }
  const signed = sigv4Fetch(
    {
      url: 'https://aws-mcp.us-east-1.api.aws/mcp',
      sigv4: { profile: 'dev', region: 'us-east-1', service: 'aws-mcp' },
    },
    base,
    load,
    () => now,
  )
  await signed('https://aws-mcp.us-east-1.api.aws/mcp', { method: 'POST', body: '{}' })
  await signed('https://aws-mcp.us-east-1.api.aws/mcp', { method: 'POST', body: '{}' })
  assert.equal(loads, 1)
  assert.match(seen[0]!.get('authorization')!, /^AWS4-HMAC-SHA256 /)
  await signed('https://us-east-1.oauth.signin.aws/x')
  assert.equal(seen[2]!.get('authorization'), null, 'another origin gets no signature')
  now += 56 * 60_000
  await signed('https://aws-mcp.us-east-1.api.aws/mcp', { method: 'POST', body: '{}' })
  assert.equal(loads, 2, 'credentials 4 minutes from expiry are read again')
  assert.equal(seen[3]!.get('x-amz-security-token'), 'T2')
  now += 60 * 60_000
  fail = true
  await assert.rejects(signed('https://aws-mcp.us-east-1.api.aws/mcp', { method: 'POST', body: '{}' }), /expired/)
  fail = false
  await signed('https://aws-mcp.us-east-1.api.aws/mcp', { method: 'POST', body: '{}' })
  assert.equal(loads, 4, 'a failed read is not kept')
  assert.deepEqual(signed.secrets(), [EXAMPLE.accessKeyId, EXAMPLE.secretAccessKey, 'T4'], 'the credentials to hide')
})

test('the canonical path encodes the path as sent once more, so a raw and an encoded colon sign differently', () => {
  const sign = (url: string) =>
    signRequest(
      { method: 'GET', url, headers: new Headers(), body: '' },
      EXAMPLE,
      { region: 'us-east-1', service: 's' },
      SUITE_DATE,
    ).authorization
  assert.notEqual(sign('https://h.us-east-1.api.aws/a/arn:x'), sign('https://h.us-east-1.api.aws/a/arn%3Ax'))
  assert.doesNotThrow(() => sign('https://h.us-east-1.api.aws/a%zz'))
})

test('the canonical query reads a plus sign as a plus sign, and keeps the signatures of the other queries', () => {
  const sign = (path: string) =>
    signRequest(
      { method: 'GET', url: `https://example.amazonaws.com${path}`, headers: new Headers(), body: '' },
      EXAMPLE,
      { region: 'us-east-1', service: 'service' },
      SUITE_DATE,
    )
      .authorization!.split('Signature=')
      .pop()
  const UNRESERVED = '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const cases: Record<string, string> = {
    '/?Param2=value2&Param1=value1': 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    '/?Param1=value1': 'a67d582fa61cc504c4bae71f336f98b97f1ea3c7a6bfe1b6e45aec72011b9aeb',
    [`/?${UNRESERVED}=${UNRESERVED}`]: '9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197',
    '/?ሴ=bar': '2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04',
    '/?Param1=value2&Param1=value1': '5772eed61e12b33fae39ee5e7012498b51d56abc0abb7c60486157bd471c4694',
    '/?flag': '9f9b0c928ba3d7888545d212afed3457f82dc628c584247c6a0d461202def1fb',
    '/?a=': '619ba5d08fb595f852ef4ad6f7ac2d4f66b99ca820d12b6a23a8d1e5771336bc',
    '/?a=b=c': 'bd04800977503c61a562775203fd57986d4b5209699c101d60e6dd12e4d7d457',
    '/': '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    '/?': '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    '/?q=a%20b': '87ff43fc767921116dce7f8d6f2b33a53470d1f0784a931ee9319fdc2d81e9e2',
    '/?q=a+b': 'e6944a72739df54de065943a2df52b1b1fa41d9c64bfe314bdc6d9730bbcfb13',
    '/?q=a%2Bb': 'e6944a72739df54de065943a2df52b1b1fa41d9c64bfe314bdc6d9730bbcfb13',
  }
  for (const [path, signature] of Object.entries(cases)) assert.equal(sign(path), signature, path)
  for (const path of ['/?a=%zz', '/?a=%FF', '/?a=1&&b=2', '/?a=1&', '/?=x']) assert.doesNotThrow(() => sign(path), path)
})

test('sigv4Fetch sends the URL as it got it, with a plus sign in the query', async () => {
  let sent = ''
  const signed = sigv4Fetch(
    { url: 'https://aws-mcp.us-east-1.api.aws/mcp', sigv4: { profile: 'p', region: 'us-east-1', service: 'aws-mcp' } },
    async url => {
      sent = String(url)
      return new Response('{}')
    },
    async () => EXAMPLE,
  )
  await signed('https://aws-mcp.us-east-1.api.aws/mcp?q=a+b')
  assert.equal(sent, 'https://aws-mcp.us-east-1.api.aws/mcp?q=a+b')
})

test('sigv4Fetch keeps signing with the credentials in use when a read inside the last 5 minutes fails', async () => {
  let now = Date.UTC(2026, 10, 23, 8)
  const expiry = now + 60 * 60_000
  let step: 'ok' | 'fail' | 'new' = 'ok'
  let loads = 0
  const load = async (): Promise<AwsCredentials> => {
    loads++
    if (step === 'fail') throw 'refused'
    return { ...EXAMPLE, sessionToken: step === 'ok' ? 'OLD' : 'NEW', expiresAt: expiry }
  }
  const seen: Headers[] = []
  const signed = sigv4Fetch(
    { url: 'https://aws-mcp.us-east-1.api.aws/mcp', sigv4: { profile: 'p', region: 'us-east-1', service: 'aws-mcp' } },
    async (_url, init) => {
      seen.push(new Headers(init?.headers))
      return new Response('{}')
    },
    load,
    () => now,
  )
  const send = () => signed('https://aws-mcp.us-east-1.api.aws/mcp', { method: 'POST', body: '{}' })
  await send()
  now = expiry - 4 * 60_000
  step = 'fail'
  await send()
  assert.equal(seen[1]!.get('x-amz-security-token'), 'OLD', 'the old credentials sign it')
  assert.equal(loads, 2)
  now = expiry - 3 * 60_000
  step = 'new'
  await send()
  assert.equal(loads, 3, 'the next request reads again')
  assert.equal(seen[2]!.get('x-amz-security-token'), 'NEW')
  now = expiry
  step = 'fail'
  await assert.rejects(send(), error => error === 'refused', 'at the expiry the error of the read comes back')
  now = expiry - 1
  await send()
  assert.equal(seen[3]!.get('x-amz-security-token'), 'NEW', 'one ms before the expiry the credentials still sign')
})

const AWS_URL = 'https://aws-mcp.us-east-1.api.aws/mcp'
const metaOf = (sigv4: unknown, env: Record<string, string> = {}) => {
  const parsed = parseConfig(
    JSON.stringify({ mcpServers: { aws: { type: 'http', url: AWS_URL, sigv4 } } }),
    env,
    process.execPath,
    process.platform,
  )
  assert.ok(parsed.ok)
  return parsed.config.servers.get('aws' as never)
}

test('item 7: sigv4.metadata parses with ${VAR} expansion, and an empty object is no metadata', () => {
  const server = metaOf(
    { profile: 'dev', metadata: { AWS_REGION: 'ap-southeast-1', 'a.b-c_d': '${FAKE_TAG}' } },
    { FAKE_TAG: 'fake-tag' },
  )
  assert.ok(server?.kind === 'http')
  assert.deepEqual(server.sigv4?.metadata, { AWS_REGION: 'ap-southeast-1', 'a.b-c_d': 'fake-tag' })
  const none = metaOf({ profile: 'dev', metadata: {} })
  assert.ok(none?.kind === 'http')
  assert.deepEqual(none.sigv4, { profile: 'dev', region: 'us-east-1', service: 'aws-mcp' }, 'no metadata key at all')
})

test('item 7: each bad sigv4.metadata is a config error that names the path and never the value', () => {
  const bad = (metadata: unknown, env: Record<string, string> = {}): string => {
    const server = metaOf({ profile: 'dev', metadata }, env)
    assert.equal(server?.kind, 'invalid', JSON.stringify(metadata))
    return JSON.stringify(server)
  }
  const pairs = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`K${i}`, 'v']))
  assert.match(bad('ap-southeast-1'), /sigv4\.metadata: must be an object of strings/)
  assert.match(bad([1]), /sigv4\.metadata: must be an object of strings/)
  assert.match(bad(pairs(17)), /sigv4\.metadata: has 17 pairs, at most 16/)
  assert.match(bad({ AWS_REGION: 5 }), /sigv4\.metadata\.AWS_REGION: must be a non-empty string/)
  assert.match(bad({ AWS_REGION: '' }), /sigv4\.metadata\.AWS_REGION: must be a non-empty string/)
  assert.match(bad({ 'bad key': 'v' }), /sigv4\.metadata\[\\"bad key\\"\]: a key must be 1 to 64 characters/)
  assert.match(bad({ ['k'.repeat(65)]: 'v' }), new RegExp(`sigv4\\.metadata\\.k{65}: a key must be 1 to 64 characters`))
  assert.match(bad({ K: 'v'.repeat(257) }), /sigv4\.metadata\.K: is longer than 256 characters/)
  assert.match(bad({ K: '${FAKE_MISSING}' }), /sigv4\.metadata\.K: the environment variable FAKE_MISSING is not set/)
  assert.match(bad({ K: '${FAKE_EMPTY}' }, { FAKE_EMPTY: '' }), /sigv4\.metadata\.K: is empty after the expansion/)
  assert.doesNotMatch(bad({ K: 'v'.repeat(257) }), /vvvvvvvv/)
  assert.equal(metaOf({ profile: 'dev', metadata: pairs(16) })?.kind, 'http', '16 pairs pass')
  assert.equal(metaOf({ profile: 'dev', metadata: { K: 'v'.repeat(256) } })?.kind, 'http', '256 characters pass')
})

/** A fake MCP server that records what each request carried. */
const recorder = async () => {
  const seen: { headers: http.IncomingHttpHeaders; body: string; url: string }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      seen.push({ headers: req.headers, body, url: req.url ?? '' })
      res.end('{}')
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { seen, origin, close: () => new Promise<void>(r => server.close(() => r())) }
}

const plainHttp = (url: string) => ({ kind: 'http', url, headers: {} }) as never

test('item 7: the pairs go into params._meta of each JSON-RPC request, and the signature covers that body', async () => {
  const fake = await recorder()
  const now = Date.UTC(2026, 10, 27, 8)
  try {
    const url = `${fake.origin}/mcp`
    const sigv4 = {
      profile: 'dev',
      region: 'us-east-1',
      service: 'aws-mcp',
      metadata: { AWS_REGION: 'ap-southeast-1', trace: 'fake-t' },
    }
    const signed = sigv4Fetch(
      { url, sigv4 },
      serverFetch(plainHttp(url)),
      async () => ({ ...EXAMPLE, sessionToken: 'fakeToken' }),
      () => now,
    )
    const post = (message: unknown) =>
      signed(url, { method: 'POST', body: JSON.stringify(message), headers: { 'content-type': 'application/json' } })
    await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: {} } })
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't', _meta: { trace: 'own', x: 1 } } })
    await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 't', _meta: 'text' } })
    const [a, b, c] = fake.seen
    assert.deepEqual(JSON.parse(a!.body).params._meta, { AWS_REGION: 'ap-southeast-1', trace: 'fake-t' })
    assert.deepEqual(JSON.parse(b!.body).params._meta, { AWS_REGION: 'ap-southeast-1', trace: 'own', x: 1 })
    assert.deepEqual(JSON.parse(c!.body).params._meta, { AWS_REGION: 'ap-southeast-1', trace: 'fake-t' })
    for (const request of fake.seen) {
      assert.match(String(request.headers.authorization), /^AWS4-HMAC-SHA256 /)
      const headers = new Headers(request.headers as Record<string, string>)
      const again = signRequest(
        { method: 'POST', url, headers, body: request.body },
        { ...EXAMPLE, sessionToken: 'fakeToken' },
        sigv4,
        new Date(now),
      )
      assert.equal(request.headers.authorization, again.authorization, 'the signature is over the body as sent')
    }
  } finally {
    await fake.close()
  }
})

test('item 7: with no metadata the body is sent byte for byte, and a body that is not a JSON-RPC object with params is not touched', async () => {
  const fake = await recorder()
  try {
    const url = `${fake.origin}/mcp`
    const base = serverFetch(plainHttp(url))
    const scope = { profile: 'dev', region: 'us-east-1', service: 'aws-mcp' }
    const plain = sigv4Fetch({ url, sigv4: scope }, base, async () => EXAMPLE)
    const withMeta = sigv4Fetch({ url, sigv4: { ...scope, metadata: { K: 'v' } } }, base, async () => EXAMPLE)
    const spaced = '{ "jsonrpc": "2.0",  "id": 1, "method": "tools/list", "params": {} }'
    await plain(url, { method: 'POST', body: spaced })
    assert.equal(fake.seen[0]!.body, spaced, 'no metadata: not even a space changes')
    const odd = [
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '[{"jsonrpc":"2.0","id":1,"method":"x","params":{}}]',
      '{"hello":"world","params":{}}',
      'not json',
      '{"jsonrpc":"2.0","id":1,"method":"x","params":[1]}',
    ]
    for (const body of odd) await withMeta(url, { method: 'POST', body })
    assert.deepEqual(
      fake.seen.slice(1).map(r => r.body),
      odd,
      'the same bytes',
    )
    await withMeta(url, { method: 'GET' })
    assert.equal(fake.seen.at(-1)!.body, '', 'a GET has no body')
  } finally {
    await fake.close()
  }
})

test('item 7: a request to another origin gets no pairs and no signature', async () => {
  const fake = await recorder()
  const other = await recorder()
  try {
    const url = `${fake.origin}/mcp`
    const signed = sigv4Fetch(
      { url, sigv4: { profile: 'dev', region: 'us-east-1', service: 'aws-mcp', metadata: { K: 'v' } } },
      serverFetch(plainHttp(url)),
      async () => EXAMPLE,
    )
    const body = '{"jsonrpc":"2.0","id":1,"method":"x","params":{}}'
    await signed(`${other.origin}/token`, { method: 'POST', body })
    assert.equal(other.seen[0]!.body, body)
    assert.equal(other.seen[0]!.headers.authorization, undefined)
  } finally {
    await fake.close()
    await other.close()
  }
})

test('a request whose signal is aborted (after the close) starts no credential read', async () => {
  let loads = 0
  let sent = 0
  const signed = sigv4Fetch(
    { url: AWS_URL, sigv4: { profile: 'dev', region: 'us-east-1', service: 'aws-mcp' } },
    async () => (sent++, new Response('{}')),
    async () => (loads++, EXAMPLE),
  )
  await signed(AWS_URL, { method: 'POST', body: '{}', signal: AbortSignal.abort() })
  assert.equal(loads, 0)
  assert.equal(sent, 1, 'the base fetch gets it, and fails it as it does for any aborted request')
})

test('item 1: long-lived keys (no expiry) are read one time and never again', async () => {
  let loads = 0
  const now = Date.UTC(2026, 10, 27, 8)
  const signed = sigv4Fetch(
    { url: AWS_URL, sigv4: { profile: 'dev', region: 'us-east-1', service: 'aws-mcp' } },
    async () => new Response('{}'),
    async () => (loads++, EXAMPLE),
    () => now + loads * 365 * 24 * 3600_000,
  )
  for (let i = 0; i < 3; i++) await signed(AWS_URL, { method: 'POST', body: '{}' })
  assert.equal(loads, 1)
})
