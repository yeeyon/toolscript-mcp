import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AwsCredentialsError, exportCredentials, stderrReason, timeoutReason } from '../src/host/sigv4.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigv4cli-'))
after(() => fs.rmSync(dir, { recursive: true, force: true }))

let count = 0
/**
 * A fake AWS CLI: a Node script behind a shim, so the CLI starts a grandchild as `aws` does on Windows (a .cmd) and on
 * POSIX (a shell script with no exec). The script ends by itself after 15 s at most. It runs no loop.
 */
const fakeCli = (body: string): string => {
  const script = path.join(dir, `fake${count++}.mjs`)
  fs.writeFileSync(script, `${body}\nsetTimeout(() => {}, 12_000)\n`)
  if (process.platform === 'win32') {
    const shim = script.replace(/\.mjs$/, '.cmd')
    fs.writeFileSync(shim, `@"${process.execPath}" "${script}" %*\r\n`)
    return shim
  }
  const shim = script.replace(/\.mjs$/, '.sh')
  fs.writeFileSync(shim, `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  return shim
}

const messageOf = async (command: string, limitMs?: number): Promise<string> => {
  try {
    await exportCredentials('dev', command, limitMs)
  } catch (error) {
    assert.ok(error instanceof AwsCredentialsError)
    return error.message
  }
  throw new Error('it resolved')
}

test('a CLI that gives valid JSON resolves through the shim', async () => {
  const json = '{"Version":1,"AccessKeyId":"AKIDEXAMPLE","SecretAccessKey":"fakeSecret","SessionToken":"fakeToken"}'
  const cli = fakeCli(`process.stdout.write(${JSON.stringify(json)}); process.exit(0)`)
  assert.deepEqual(await exportCredentials('dev', cli), {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'fakeSecret',
    sessionToken: 'fakeToken',
  })
})

test('a CLI that never answers is cut at the limit, also when a grandchild holds the pipes', async () => {
  const cli = fakeCli('')
  const start = Date.now()
  const text = await messageOf(cli, 500)
  assert.ok(Date.now() - start < 5000, 'the reject does not wait for the CLI to end')
  assert.match(text, /\(the AWS CLI did not answer in 0\.5 s\)/)
  assert.match(text, /aws sso login --profile dev/)
  assert.doesNotMatch(text, /exit null/)
})

test('the default limit prints 30 s', () => {
  assert.equal(timeoutReason(30_000), 'the AWS CLI did not answer in 30 s')
})

test('a command that is not on PATH gives the PATH reason, and an exit with no output gives the code', async () => {
  assert.match(await messageOf('fake-aws-not-on-path-0123'), /the AWS CLI "aws" is not on PATH/)
  assert.match(await messageOf(fakeCli('process.exit(3)')), /\(exit 3\)/)
})

const LINES: readonly (readonly [string, readonly string[]])[] = [
  ['helper: request to https://user:fakePass0rd123@vault.example.com/creds failed', ['user:', 'fakePass0rd123']],
  ['helper: fetch failed with token=fakeToken0123456789abcdefXYZ', ['fakeToken0123456789abcdefXYZ']],
  ['helper: Authorization: Bearer fakeBearer0123456789abcdefXYZ rejected', ['fakeBearer0123456789abcdefXYZ']],
  [
    'helper: key AKIAFAKEFAKEFAKE1234 secret wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY refused',
    ['AKIAFAKEFAKEFAKE1234', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'],
  ],
  ['helper: --password hunter2hunter2 was wrong', ['hunter2hunter2']],
]

test('the stderr line of a helper shows no secret', () => {
  for (const [line, secrets] of LINES) {
    const reason = stderrReason(`\n${line}\nsecond line\n`)
    assert.ok(reason !== undefined && reason.startsWith('helper:'), line)
    for (const secret of secrets) assert.ok(!reason.includes(secret), `${secret} in ${reason}`)
  }
})

test('the stderr lines of the AWS CLI stay readable', () => {
  assert.match(
    stderrReason('Error loading SSO Token: Token for dev does not exist')!,
    /^Error loading SSO .*for dev does not exist$/,
  )
  const expired = 'The SSO session associated with this profile has expired or is otherwise invalid.'
  assert.equal(stderrReason(`${expired} To refresh this SSO session run aws sso login.`)?.startsWith(expired), true)
  assert.equal(
    stderrReason('The config profile (dev) could not be found'),
    'The config profile (dev) could not be found',
  )
  const none = 'Unable to locate credentials. You can configure credentials by running "aws configure".'
  assert.equal(stderrReason(none), none)
  assert.equal(stderrReason('x'.repeat(500))?.length, 300)
  assert.equal(stderrReason(' \n\n'), undefined)
})

test('the usage text of AWS CLI version 1 becomes a hint, and a secret in a helper line stays out end to end', async () => {
  const v1 = fakeCli(`process.stderr.write('  USAGE: aws [options] <command> <subcommand>\\n'); process.exit(2)`)
  const text = await messageOf(v1)
  assert.match(text, /\(needs AWS CLI version 2\)/)
  assert.doesNotMatch(text, /subcommand/)
  assert.match(text, /profile "dev"/)
  const helper = fakeCli(
    `process.stderr.write('helper: fetch failed with token=fakeToken0123456789abcdefXYZ\\n'); process.exit(1)`,
  )
  const failed = await messageOf(helper)
  assert.match(failed, /helper: fetch failed/)
  assert.ok(!failed.includes('fakeToken0123456789abcdefXYZ'))
})
