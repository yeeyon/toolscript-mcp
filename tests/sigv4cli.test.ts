import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { connectAll } from '../src/host/downstream.ts'
import type { ServerKey } from '../src/core/config.ts'
import {
  AwsCredentialsError,
  exportCredentials,
  stderrReason,
  stopCredentialReads,
  timeoutReason,
} from '../src/host/sigv4.ts'

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

test('the usage text of a CLI with no export-credentials (version 1, and an old version 2) names the missing command, and a secret in a helper line stays out end to end', async () => {
  const v1 = fakeCli(`process.stderr.write('  USAGE: aws [options] <command> <subcommand>\\n'); process.exit(2)`)
  const oldV2 = fakeCli(
    `process.stderr.write('usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\\nTo see help text, you can run:\\n'); process.exit(252)`,
  )
  for (const cli of [v1, oldV2]) {
    const text = await messageOf(cli)
    assert.match(text, /\(this AWS CLI has no `configure export-credentials`: update to a current AWS CLI version 2\)/)
    assert.doesNotMatch(text, /needs AWS CLI version 2|subcommand|To see help/)
    assert.match(text, /profile "dev"/)
  }
  const helper = fakeCli(
    `process.stderr.write('helper: fetch failed with token=fakeToken0123456789abcdefXYZ\\n'); process.exit(1)`,
  )
  const failed = await messageOf(helper)
  assert.match(failed, /helper: fetch failed/)
  assert.ok(!failed.includes('fakeToken0123456789abcdefXYZ'))
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (what: () => boolean, ms: number): Promise<boolean> => {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    if (what()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return what()
}

test('a hung CLI in flight gets its tree ended when the host closes, inside 3 s', async () => {
  const pidFile = path.join(dir, 'hung.pid')
  const cli = fakeCli(`import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`)
  // The limit is far away: only the close can end it. No real 30 s wait.
  const read = messageOf(cli, 60_000)
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', 5000), 'it started')
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.ok(alive(pid))
  await stopCredentialReads()
  assert.ok(await until(() => !alive(pid), 3000), 'the CLI process is gone')
  assert.match(await read, /could not get AWS credentials for the profile "dev"/)
  await stopCredentialReads()
})

test('connectAll().close ends a hung AWS CLI that a sigv4 entry started, inside 3 s', async () => {
  // A shim named aws, first on PATH: the entry starts it through the real exportCredentials.
  const bin = fs.mkdtempSync(path.join(dir, 'bin-'))
  const pidFile = path.join(bin, 'aws.pid')
  const script = path.join(bin, 'aws.mjs')
  fs.writeFileSync(
    script,
    `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetTimeout(() => {}, 12_000)\n`,
  )
  if (process.platform === 'win32')
    fs.writeFileSync(path.join(bin, 'aws.cmd'), `@"${process.execPath}" "${script}" %*\r\n`)
  else fs.writeFileSync(path.join(bin, 'aws'), `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  const server = http.createServer((_req, res) => res.end('{}'))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  const realPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${realPath}`
  const entry = {
    kind: 'http',
    url,
    headers: {},
    sigv4: { profile: 'dev', region: 'us-east-1', service: 'aws-mcp' },
  } as const
  const downstream = connectAll(new Map([['aws' as ServerKey, entry]]), '0', () => {})
  try {
    assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', 8000), 'it started')
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    assert.ok(alive(pid))
    await downstream.close()
    assert.ok(await until(() => !alive(pid), 3000), 'the CLI process is gone after close')
  } finally {
    process.env.PATH = realPath
    await downstream.close()
    await new Promise<void>(r => server.close(() => r()))
  }
})
