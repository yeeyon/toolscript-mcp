// The lock of an OAuth refresh, in one process: the stale decision by table, the lock file calls that fail, and the
// removal of the lock at each ending of a refresh. tests/oauth-lock.test.ts runs the processes.

import { after, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lockStale, lockText, parseLock, silentReason } from '../src/core/lock.ts'
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

  test('the reason of a silent endpoint gives the whole time with no wait, and the time the request had after a wait', () => {
    const table: [string, number, number, number, string][] = [
      ['no wait', 20_000, 19_990, 10, 'the token endpoint did not answer in 20 s'],
      ['a wait below the naming limit', 300, 250, 499, 'the token endpoint did not answer in 0.3 s'],
      [
        'a wait of 8 s',
        20_000,
        12_000,
        8000,
        'the token endpoint did not answer in 12 s, after 8 s of waiting for another toolscript-mcp process',
      ],
      [
        'rounded to one decimal',
        2000,
        1349,
        651,
        'the token endpoint did not answer in 1.3 s, after 0.7 s of waiting for another toolscript-mcp process',
      ],
    ]
    for (const [name, total, had, waited, text] of table) assert.equal(silentReason(total, had, waited), text, name)
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
    assert.match(((await h.refresh()) as Error).message, /did not answer in 2 s\./)
    assert.equal(fs.existsSync(h.lock), false)
  })

  test('the timeout reason gives the time the request had, and names the wait for another process', async () => {
    // The clock is a frozen Date that the test moves by 800 ms when the other process lets go, so the wait is exactly
    // 0.8 s on any runner. The abort of the request stays on the real clock: it ends 1.6 s later.
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    try {
      const h = harness(
        signal =>
          new Promise<Response>((_, reject) => {
            const alive = setInterval(() => {}, 50)
            signal?.addEventListener('abort', () => (clearInterval(alive), reject(new Error('aborted'))))
          }),
        undefined,
        2400,
      )
      // Another process holds the lock and saves nothing. The half of 2.4 s is far from the end of the wait.
      fs.writeFileSync(h.lock, lockText({ pid: process.pid, id: ID, at: Date.now() }))
      setTimeout(() => {
        mock.timers.tick(800)
        fs.rmSync(h.lock)
      }, 600)
      const message = ((await h.refresh()) as Error).message
      assert.match(message, /did not answer in 1\.6 s, after 0\.8 s of waiting for another toolscript-mcp process\./)
      assert.equal(h.sent(), 1)
      assert.equal(fs.existsSync(h.lock), false)
    } finally {
      mock.timers.reset()
    }
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

  test('a holder that saves nothing: a waiter sends its own request only with half of its time left', async () => {
    // A refresh time of 6 s: the half is 3 s, at least 1 s from each case, for a busy machine.
    for (const [heldMs, sent] of [
      [4000, 0],
      [100, 1],
    ] as const) {
      const h = harness(ok, undefined, 6000)
      fs.writeFileSync(h.lock, lockText({ pid: process.pid, id: ID, at: Date.now() }))
      setTimeout(() => fs.rmSync(h.lock), heldMs)
      const out = await h.refresh()
      assert.equal(h.sent(), sent, `held ${heldMs} ms`)
      if (sent === 0) assert.match((out as Error).message, /another toolscript-mcp process is refreshing.*No login/)
      else assert.equal((out as Record<string, string>).refresh_token, NEXT.refresh_token)
    }
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

  // Two waiters over real files in a temp folder. A waiter stops at a gate (a promise that the test opens), so the order
  // of the calls is the test's, never the clock's. The clock is a frozen Date that the test moves to a deadline.
  const FAR_MS = 5000
  const STALE_MS = 15_000

  /** The calls that waiters made and finished, as `A open-create lock ok`: what ended, and what failed with which code. */
  const recorder = () => {
    const entries: string[] = []
    const waiting: [string, () => void][] = []
    return {
      entries,
      push: (entry: string) => {
        entries.push(entry)
        for (const [wanted, wake] of waiting) if (wanted === entry) wake()
      },
      until: (entry: string) =>
        entries.includes(entry) ? Promise.resolve() : new Promise<void>(resolve => waiting.push([entry, resolve])),
      count: (entry: string) => entries.filter(e => e === entry).length,
    }
  }

  /**
   * A LockFs over the real file system for the waiter `who`. It records each call. `stopBefore` gets the label of a call
   * and the labels of the calls before it: the first call for which it says true waits at the gate until `release`.
   * `reached` is true after that call came.
   */
  const traced = (
    who: string,
    log: ReturnType<typeof recorder>,
    stopBefore?: (label: string, before: string[]) => boolean,
  ) => {
    const before: string[] = []
    let release = () => {}
    let reach = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    const reached = new Promise<void>(resolve => (reach = resolve))
    let stopped = false
    const wrap =
      (name: keyof LockFs) =>
      async (...args: unknown[]) => {
        const file = String(args[0])
        const kind = file.endsWith('.claim') ? 'claim' : file.endsWith('.lock') ? 'lock' : 'other'
        const how = name === 'open' ? (args[1] === 'wx' ? 'create' : 'read') : name
        const label = `${how} ${kind}`
        if (!stopped && stopBefore?.(label, before) === true) {
          stopped = true
          reach()
          await gate
        }
        before.push(label)
        try {
          const out = await (fs.promises[name] as (...a: unknown[]) => Promise<unknown>)(...args)
          log.push(`${who} ${label} ok`)
          return out
        } catch (err) {
          log.push(`${who} ${label} ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
          throw err
        }
      }
    const io = {
      open: wrap('open'),
      readFile: wrap('readFile'),
      stat: wrap('stat'),
      unlink: wrap('unlink'),
      mkdir: wrap('mkdir'),
    } as LockFs
    return { io, reached, release: () => release() }
  }

  /** A store with the stale lock L1: a live pid, 60 s old, and the clock frozen at now. */
  const stale = () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'take-'))
    const store = path.join(dir, 'fake-0123456789abcdef.json')
    const lock = `${store}.lock`
    fs.writeFileSync(lock, lockText({ pid: process.pid, id: ID, at: 0 }))
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, old, old)
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    return { dir, store, lock, deadline: () => Date.now() + FAR_MS }
  }
  /** Fails the test, with a message, when the waiter ends before it reached its gate. */
  const stopsAt = (reached: Promise<void>, waiter: Promise<unknown>, what: string) =>
    Promise.race([reached, waiter.then(out => assert.fail(`${what}: the waiter ended with ${JSON.stringify(out)}`))])

  test(
    'a waiter held before its claim: another takes over and makes its lock, and the held waiter leaves that lock alone',
    { timeout: 10_000 },
    async () => {
      const log = recorder()
      try {
        const s = stale()
        // A stops at the first call after its look at L1: with a claim, that call is the create of the claim file.
        const a = traced('A', log, (_label, before) => before.includes('read lock'))
        const waitA = takeLock(s.store, s.deadline(), STALE_MS, a.io)
        await stopsAt(a.reached, waitA, 'A before its claim')
        // B takes over L1 and makes its live lock L2 while A is held.
        const b = traced('B', log)
        const held = await takeLock(s.store, s.deadline(), STALE_MS, b.io)
        assert.equal(typeof held, 'object', 'B takes the lock')
        const idB = (held as { id: string }).id
        assert.equal(parseLock(fs.readFileSync(s.lock, 'utf8'))?.id, idB)
        // A goes on, and its deadline comes: it must not have removed L2 or made a lock over it.
        a.release()
        mock.timers.tick(FAR_MS * 2)
        assert.equal(await waitA, 'busy')
        assert.equal(parseLock(fs.readFileSync(s.lock, 'utf8'))?.id, idB, 'L2 is still there with the id of B')
        assert.equal(log.count('A create lock ok'), 0, 'A never held the lock while B did')
        assert.equal(log.count('A create claim ok'), 1, 'A went through the claim, as the code says')
        assert.deepEqual(
          fs.readdirSync(s.dir).filter(name => name.endsWith('.claim')),
          [],
          'no claim file is left',
        )
      } finally {
        mock.timers.reset()
      }
    },
  )

  test(
    'a waiter held after its claim: the other cannot claim and polls, and exactly one waiter removes the lock',
    { timeout: 10_000 },
    async () => {
      const log = recorder()
      try {
        const s = stale()
        // A stops at its second look at the lock, after it made the claim file.
        const a = traced('A', log, (label, before) => label === 'read lock' && before.includes('create claim'))
        const waitA = takeLock(s.store, s.deadline(), STALE_MS, a.io)
        await stopsAt(a.reached, waitA, 'A after its claim')
        const b = traced('B', log)
        let bEnded = false
        const waitB = takeLock(s.store, s.deadline(), STALE_MS, b.io).finally(() => (bEnded = true))
        // B finds the claim of A, sees that it is live, and leaves L1 where it is.
        await log.until('B create claim EEXIST')
        await log.until('B read claim ok')
        assert.equal(fs.existsSync(s.lock), true, 'L1 stays while A holds the claim')
        assert.equal(parseLock(fs.readFileSync(s.lock, 'utf8'))?.id, ID)
        assert.equal(bEnded, false, 'B polls for the lock')
        a.release()
        const held = await waitA
        assert.equal(typeof held, 'object', 'A takes the lock after it removes L1')
        // B sees the new lock of A, which is young, and goes on polling to its deadline.
        mock.timers.tick(FAR_MS * 2)
        assert.equal(await waitB, 'busy')
        assert.equal(log.count('A unlink lock ok') + log.count('B unlink lock ok'), 1, 'one waiter removes L1')
        assert.equal(log.count('A unlink lock ok'), 1)
        assert.equal(log.count('B create lock ok'), 0)
        assert.equal(parseLock(fs.readFileSync(s.lock, 'utf8'))?.id, (held as { id: string }).id)
        assert.deepEqual(
          fs.readdirSync(s.dir).filter(name => name.endsWith('.claim')),
          [],
          'no claim file is left',
        )
      } finally {
        mock.timers.reset()
      }
    },
  )
})
