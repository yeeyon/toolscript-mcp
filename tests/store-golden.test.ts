// The store of an OAuth login, read at the base of the SDK move and read again after it (issue #154, PR 6). The parse of a
// store file keeps a part that the schemas of the SDK accept and drops the rest, so a login that the SDK stored stays
// valid. The expected values in tests/fixtures/store-golden.json were recorded with `GOLDEN_RECORD=1`.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStore } from '../src/host/oauth.ts'

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'store-golden.json')
const RECORD = process.env.GOLDEN_RECORD === '1'
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-store-golden-'))
after(() => fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 }))

const REDIRECT = 'http://127.0.0.1:5555/callback'
const TOKENS = { access_token: 'a1', token_type: 'Bearer', refresh_token: 'r1', expires_in: 3600, scope: 'x y' }
const CLIENT = { client_id: 'c1', redirect_uris: [REDIRECT] }
const SECRET = {
  ...CLIENT,
  client_secret: 's1',
  client_secret_expires_at: 0,
  token_endpoint_auth_method: 'client_secret_post',
}

const CASES: Record<string, unknown> = {
  valid: { client: { info: CLIENT, redirectUrl: REDIRECT }, tokens: TOKENS },
  'a client with a secret': { client: { info: SECRET, redirectUrl: REDIRECT }, tokens: TOKENS },
  'a client of the config (id only)': { client: { info: { client_id: 'c2' }, redirectUrl: REDIRECT } },
  'a client with an issuer': { client: { info: { ...CLIENT, issuer: 'http://as.example/' }, redirectUrl: REDIRECT } },
  'a client with a non-string issuer': { client: { info: { ...CLIENT, issuer: 7 }, redirectUrl: REDIRECT } },
  'no access_token': { tokens: { token_type: 'Bearer', refresh_token: 'r1' } },
  'no token_type': { tokens: { access_token: 'a1', refresh_token: 'r1' } },
  'a lower-case token_type': { tokens: { access_token: 'a1', token_type: 'bearer', refresh_token: 'r1' } },
  'a dpop token_type': { tokens: { access_token: 'a1', token_type: 'DPoP' } },
  'tokens with no refresh token': { tokens: { access_token: 'a1', token_type: 'Bearer' } },
  'tokens with an issuer, no slash': { tokens: { ...TOKENS, issuer: 'http://as.example' } },
  'tokens with an issuer, a slash': { tokens: { ...TOKENS, issuer: 'http://as.example/' } },
  'tokens with a non-string issuer': { tokens: { ...TOKENS, issuer: 7 } },
  'tokens with a bad expires_in': { tokens: { ...TOKENS, expires_in: 'soon' } },
  'tokens with a non-string scope': { tokens: { ...TOKENS, scope: 7 } },
  'a client that is not an object': { client: 'x', tokens: TOKENS },
  'a client with another redirect host': {
    client: { info: CLIENT, redirectUrl: 'https://example.com/callback' },
    tokens: TOKENS,
  },
  'a client with no client_id': { client: { info: { redirect_uris: [REDIRECT] }, redirectUrl: REDIRECT } },
  'text that is not JSON': 'nope',
}

const golden: Record<string, unknown> =
  RECORD || !fs.existsSync(FIXTURE) ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const recorded: Record<string, unknown> = {}
after(() => {
  if (RECORD) fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
})

for (const [name, content] of Object.entries(CASES)) {
  test(`the store keeps and drops the same parts: ${name}`, async () => {
    const file = path.join(DIR, `${Object.keys(CASES).indexOf(name)}.json`)
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
    const stored = JSON.parse(JSON.stringify(await readStore(file)))
    recorded[name] = stored
    if (!RECORD) assert.deepEqual(stored, golden[name], `the stored value of "${name}" changed`)
  })
}
