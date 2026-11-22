// The lock of an OAuth refresh, in one process: the stale decision by table, the lock file calls that fail, and the
// removal of the lock at each ending of a refresh. tests/oauth-lock.test.ts runs the processes.

import { after, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lockStale, lockText, parseLock } from '../src/core/lock.ts'
import { oauthProvider } from '../src/host/oauth.ts'
import { takeLock, type LockFs } from '../src/host/oauthlock.ts'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-lock-test-'))
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }))

const ID = randomUUID()
const AGE = 31_000

describe('the lock content', () => {
  test('lockText and parseLock round trip, and nothing else parses', () => {
    const content = { pid: 4242, id: ID, at: 1700000000000 }
    assert.deepEqual(parseLock(lockText(content)), content)
    for (const text of [
      '',
      'garbage',
      '[]',
      'null',
      '{}',
      JSON.stringify({ pid: 0, id: ID, at: 1 }),
      JSON.stringify({ pid: -5, id: ID, at: 1 }),
      JSON.stringify({ pid: 1.5, id: ID, at: 1 }),
      JSON.stringify({ pid: '12', id: ID, at: 1 }),
      JSON.stringify({ pid: 12, id: 'x'.repeat(36), at: 1 }),
      JSON.stringify({ pid: 12, id: 5, at: 1 }),
    ])
      assert.equal(parseLock(text), undefined, text)
  })

  test('the stale decision: a dead pid at any age, a live pid only past the age, any file past the age', () => {
    const content = { pid: 1, id: ID, at: 0 }
    const table: [string, ReturnType<typeof parseLock>, number, boolean, boolean][] = [
      ['dead pid, new', content, 0, false, true],
      ['live pid, new', content, 1000, true, false],
      ['live pid, at the age', content, AGE, true, false],
      ['live pid, past the age', content, AGE + 1, true, true],
      ['garbage, new', undefined, 1000, false, false],
      ['garbage, past the age', undefined, AGE + 1, false, true],
    ]
    for (const [name, c, ageMs, lives, stale] of table) assert.equal(lockStale(c, ageMs, lives, AGE), stale, name)
  })
})

/** A LockFs that fails the calls named in `fail` with that code and passes the others on. */
const failing = (fail: Partial<Record<keyof LockFs, string>>): LockFs => {
  const wrap =
    (name: keyof LockFs) =>
    (...args: unknown[]) => {
      const code = fail[name]
      if (code !== undefined) return Promise.reject(Object.assign(new Error(code), { code }))
      return (fs.promises[name] as (...a: unknown[]) => Promise<unknown>)(...args)
    }
  return {
    open: wrap('open'),
    readFile: wrap('readFile'),
    stat: wrap('stat'),
    unlink: wrap('unlink'),
    mkdir: wrap('mkdir'),
  } as LockFs
}

const OLD = 'fake-refresh-old'
const NEXT = { access_token: 'fake-access-next', refresh_token: 'fake-refresh-next', token_type: 'Bearer' }
const URL_ = 'http://127.0.0.1/token'

/** A store with one login, and a provider of the running server over it, with a token endpoint that `answer` plays. */
const harness = (answer: (signal: AbortSignal | undefined) => Promise<Response>, lockFs?: LockFs, timeoutMs = 3000) => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'oauth-'))
  const file = path.join(dir, 'fake-0123456789abcdef.json')
  const client = { info: { client_id: 'fake-client' }, redirectUrl: 'http://127.0.0.1:1/callback' }
  const tokens = { access_token: 'fake-access-old', refresh_token: OLD, token_type: 'Bearer' }
  fs.writeFileSync(file, JSON.stringify({ client, tokens }))
  const provider = oauthProvider(
    file,
    { scopes: [] },
    { kind: 'serve', reason: 'needs login', refreshTimeoutMs: timeoutMs },
    lockFs,
  )
  let sent = 0
  const send = provider.fetch((_url, init) => {
    if (init?.body instanceof URLSearchParams) return (sent++, answer(init.signal ?? undefined))
    return Promise.resolve(new Response(null, { status: 401 }))
  })
  /** A call that fails with the old access token, then the refresh that the SDK starts after it. */
  const refresh = async () => {
    await send(URL_, { headers: { authorization: 'Bearer fake-access-old' } })
    return send(URL_, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: OLD }),
    }).then(
      r => r.json() as Promise<Record<string, string>>,
      (err: Error) => err,
    )
  }
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens: { refresh_token: string } }
  return { file, refresh, stored, sent: () => sent, lock: `${file}.lock`, dir }
}
const ok = () => Promise.resolve(Response.json({ ...NEXT, expires_in: 3600 }))

describe('one refresh in one process', () => {
  test('the lock is made and removed, and the new tokens are saved', async () => {
    const h = harness(ok)
    const out = await h.refresh()
    assert.equal((out as Record<string, string>).refresh_token, NEXT.refresh_token)
    assert.equal(h.stored().tokens.refresh_token, NEXT.refresh_token)
    assert.equal(h.sent(), 1)
    assert.deepEqual(fs.readdirSync(h.dir), ['fake-0123456789abcdef.json'])
  })

  test('the lock never holds a token, a client or a URL', async () => {
    let text = ''
    const h = harness(() => {
      text = fs.readFileSync(`${h.file}.lock`, 'utf8')
      return ok()
    })
    await h.refresh()
    assert.deepEqual(Object.keys(JSON.parse(text) as object).sort(), ['at', 'id', 'pid'])
  })

  const endings: [string, () => Promise<Response>, RegExp][] = [
    ['an answer', ok, /^$/],
    ['a refusal', () => Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 })), /needs login/],
    ['a 503', () => Promise.resolve(new Response('down', { status: 503 })), /HTTP 503/],
    ['a thrown error', () => Promise.reject(new Error('connect ECONNREFUSED')), /ECONNREFUSED/],
    ['an answer that is not tokens', () => Promise.resolve(Response.json({ nope: 1 })), /needs login/],
  ]
  for (const [name, answer, message] of endings)
    test(`the lock is removed after ${name}`, async () => {
      const h = harness(answer)
      const out = await h.refresh()
      if (message.source !== '^$') assert.match((out as Error).message, message)
      assert.equal(fs.existsSync(h.lock), false)
    })

  test('the lock is removed after a timeout', async () => {
    const h = harness(
      signal =>
        new Promise<Response>((_, reject) => {
          // The timer of AbortSignal.timeout does not keep a process alive, so this one does.
          const alive = setInterval(() => {}, 50)
          signal?.addEventListener('abort', () => (clearInterval(alive), reject(new Error('aborted'))))
        }),
      undefined,
      2000,
    )
    assert.match(((await h.refresh()) as Error).message, /did not answer in 2 s/)
    assert.equal(fs.existsSync(h.lock), false)
  })

  test('the lock is removed when the save of the tokens fails, and the tokens work in memory', async () => {
    const lines: string[] = []
    mock.method(console, 'error', (line: string) => void lines.push(line))
    const rename = mock.method(fs.promises, 'rename', () =>
      Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })),
    )
    try {
      const h = harness(ok)
      const out = (await h.refresh()) as Record<string, string>
      assert.equal(out.refresh_token, NEXT.refresh_token)
      assert.equal(h.stored().tokens.refresh_token, OLD)
      assert.equal(fs.existsSync(h.lock), false)
      assert.equal(lines.length, 1)
      assert.match(lines[0] ?? '', /could not save the refreshed OAuth tokens/)
    } finally {
      rename.mock.restore()
      mock.restoreAll()
    }
  })

  test('ENOSPC on the create of the lock: the refresh runs as before, with one line for the store', async () => {
    const lines: string[] = []
    mock.method(console, 'error', (line: string) => void lines.push(line))
    try {
      const h = harness(ok, failing({ open: 'ENOSPC' }))
      assert.equal(((await h.refresh()) as Record<string, string>).refresh_token, NEXT.refresh_token)
      assert.equal(h.sent(), 1)
      assert.equal(h.stored().tokens.refresh_token, NEXT.refresh_token)
      assert.equal(lines.length, 1)
      assert.match(lines[0] ?? '', /cannot make .*\.lock \(ENOSPC\)\. The OAuth refresh runs without a lock\./)
      assert.equal(lines[0]?.includes('fake-access') || lines[0]?.includes('fake-refresh'), false)
      // The same store in the same process says it one time.
      await takeLock(`${h.file}`, Date.now() + 100, 1000, failing({ open: 'ENOSPC' }))
      assert.equal(lines.length, 1)
    } finally {
      mock.restoreAll()
    }
  })

  test('a lock path that cannot be made for another reason does not stop the refresh', async () => {
    mock.method(console, 'error', () => {})
    try {
      for (const code of ['EROFS', 'EACCES', 'ENOTDIR']) {
        const h = harness(ok, failing({ open: code, stat: 'ENOENT' }))
        assert.equal(((await h.refresh()) as Record<string, string>).refresh_token, NEXT.refresh_token, code)
      }
    } finally {
      mock.restoreAll()
    }
  })

  test('a lock that another process holds to the end of the time fails the refresh with no request', async () => {
    const h = harness(ok, undefined, 400)
    fs.writeFileSync(h.lock, lockText({ pid: process.pid, id: ID, at: Date.now() }))
    const out = (await h.refresh()) as Error
    assert.match(out.message, /another toolscript-mcp process is refreshing.*No login is needed/)
    assert.equal(h.sent(), 0)
    assert.equal(
      fs.readFileSync(h.lock, 'utf8').includes(ID),
      true,
      'a process that does not hold the lock never removes it',
    )
  })

  test('the store gets tokens from another process while this one waits: no request', async () => {
    const h = harness(ok, undefined, 3000)
    fs.writeFileSync(h.lock, lockText({ pid: process.pid, id: ID, at: Date.now() }))
    const stored = JSON.parse(fs.readFileSync(h.file, 'utf8')) as { tokens: object }
    setTimeout(() => {
      fs.writeFileSync(h.file, JSON.stringify({ ...stored, tokens: NEXT }))
      fs.rmSync(h.lock)
    }, 200)
    const out = (await h.refresh()) as Record<string, string>
    assert.equal(out.refresh_token, NEXT.refresh_token)
    assert.equal(h.sent(), 0)
  })
})

describe('a lock that changes while a waiter reads it', () => {
  test('the age and the id come from one file: a new live lock is never taken over with the age of the old one', async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'swap-'))
    const store = path.join(dir, 'fake-0123456789abcdef.json')
    const lock = `${store}.lock`
    const fresh = randomUUID()
    fs.writeFileSync(lock, lockText({ pid: process.pid, id: ID, at: 0 }))
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, old, old)
    // Another waiter puts a new lock at the path right after this waiter's first look at the old one.
    let swapped = false
    const swap = () => {
      if (swapped) return
      swapped = true
      fs.writeFileSync(lock, lockText({ pid: process.pid, id: fresh, at: Date.now() }))
    }
    const io = {
      ...fs.promises,
      stat: async (...args: Parameters<typeof fs.promises.stat>) => {
        const out = await fs.promises.stat(...args)
        if (args[0] === lock) swap()
        return out
      },
      open: async (...args: Parameters<typeof fs.promises.open>) => {
        const out = await fs.promises.open(...args)
        if (args[0] === lock && args[1] !== 'wx') swap()
        return out
      },
    } as LockFs
    assert.equal(await takeLock(store, Date.now() + 400, 1000, io), 'busy')
    assert.equal(parseLock(fs.readFileSync(lock, 'utf8'))?.id, fresh)
  })
})
