import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awsEndpoint, parseConfig } from '../src/core/config.ts'
import { parseExported, signRequest, sigv4Fetch, type AwsCredentials } from '../src/host/sigv4.ts'

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
  const server = entryOf({ type: 'http', url: 'https://aws-mcp.us-east-1.api.aws/mcp', sigv4: { profile: 'cx-sit' } })
  assert.equal(server?.kind, 'http')
  assert.ok(server?.kind === 'http')
  assert.deepEqual(server.sigv4, { profile: 'cx-sit', region: 'us-east-1', service: 'aws-mcp' })
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
    assert.equal(profile, 'cx-sit')
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
      sigv4: { profile: 'cx-sit', region: 'us-east-1', service: 'aws-mcp' },
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
})
