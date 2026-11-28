// The framing of src/core/codec.ts against the SDK's ReadBuffer (1.32.2) on the same bytes: the same messages, the same
// error names and texts, in the same order. A new SDK is compared with the codec by this file (issue #154).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ReadBuffer, deserializeMessage, deserializeMessageV2, serializeMessage } from './sdk.mjs'
import { FRAME_MAX, FrameReader, frameOf } from '../src/core/codec.ts'

type Outcome = { message: unknown } | { error: string; text: string }

const utf8 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
const failure = (e: unknown): Outcome => ({ error: (e as Error).name, text: (e as Error).message })

type Reader = { append: (chunk: Buffer) => void; read: () => unknown; clear: () => void }
const sdk = (max?: number): Reader => {
  const b = new ReadBuffer(max === undefined ? undefined : { maxBufferSize: max })
  return { append: c => b.append(c), read: () => b.readMessage(), clear: () => b.clear() }
}
const ours = (max?: number, plain = false): Reader => {
  const b = new FrameReader(deserializeMessage, utf8, max)
  return { append: c => b.append(plain ? new Uint8Array(c) : c), read: () => b.read(), clear: () => b.clear() }
}

/** The whole sequence of results of one reader for a list of chunks: an append that fails, then each read until null. */
// A null chunk is a clear() of the reader.
type Chunk = Buffer | null
const run = (reader: Reader, chunks: readonly Chunk[]): Outcome[] => {
  const out: Outcome[] = []
  for (const chunk of chunks) {
    if (chunk === null) {
      reader.clear()
      continue
    }
    try {
      reader.append(chunk)
    } catch (e) {
      out.push(failure(e))
      continue
    }
    for (;;) {
      try {
        const message = reader.read()
        if (message === null) break
        out.push({ message })
      } catch (e) {
        out.push(failure(e))
      }
    }
  }
  return out
}

const same = (chunks: readonly Chunk[], max?: number): Outcome[] => {
  const theirs = run(sdk(max), chunks)
  assert.deepEqual(run(ours(max), chunks), theirs)
  assert.deepEqual(run(ours(max, true), chunks), theirs, 'a plain Uint8Array chunk')
  return theirs
}
const b = (...parts: (string | number[])[]): Buffer =>
  Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))))

const DIFFERENCES: string[] = []
const PING = '{"jsonrpc":"2.0","method":"ping","id":1}'
const DONE = '{"jsonrpc":"2.0","id":2,"result":{}}'
const EMOJI = '{"jsonrpc":"2.0","method":"notifications/x","params":{"t":"\u{1F600}é漢"}}'

// The table of the rows, for the SDK reader of the test and for the v2 deserializeMessage below.
const rows: [string, Chunk[]][] = [
  ['a line ends at LF', [b(`${PING}\n`)]],
  ['CRLF: one CR before the LF goes', [b(`${PING}\r\n`)]],
  ['two CRs: only the last goes, and the line is not JSON', [b(`${PING}\r\r\n`)]],
  ['a CR inside a line stays', [b('{"jsonrpc":"2.0",\r"method":"ping","id":1}\n')]],
  ['a partial line gives nothing until its LF', [b(PING.slice(0, 10)), b(PING.slice(10)), b('\n')]],
  ['several lines in one chunk come out in order', [b(`${PING}\n${DONE}\n${PING}\n`)]],
  ['text with no final LF is never a message', [b(`${PING}\n${DONE}`)]],
  ['a character split over two chunks is whole', [b(`${EMOJI}\n`).subarray(0, 60), b(`${EMOJI}\n`).subarray(60)]],
  ['a 4-byte character cut at every byte', Array.from(b(`${EMOJI}\n`), x => Buffer.from([x]))],
  ['bad bytes become U+FFFD', [b('{"jsonrpc":"2.0","method":"p\u0000', [0xff, 0xfe, 0xf0, 0x9f], '","id":1}\n')]],
  ['a BOM line is not JSON', [b([0xef, 0xbb, 0xbf], `${PING}\n`)]],
  ['an empty line throws and is consumed', [b(`\n${PING}\n`)]],
  ['a line of spaces throws', [b(`   \n${PING}\n`)]],
  ['a lone CRLF line throws', [b(`\r\n${PING}\n`)]],
  ['invalid JSON throws and the next line reads', [b(`{nope\n${PING}\n`)]],
  ['valid JSON that is not a message throws the SDK check', [b('[]\n{}\n5\nnull\n"x"\n{"jsonrpc":"2.0"}\n')]],
  ['a bad line, then good lines, in several chunks', [b('{"a"'), b(':1}\n' + PING), b('\n' + DONE + '\n')]],
  ['an empty chunk changes nothing', [b(''), b(PING), b(''), b('\n')]],
  ['a character cut at the LF: U+FFFD, then not JSON', [b('{"a":"', [0xf0, 0x9f], '\n')]],
  [
    'clear() drops a partial line, and new bytes start fresh',
    [b(PING.slice(0, 10)), null, b(PING.slice(10) + '\n'), b(PING + '\n')],
  ],
  ['clear() with nothing held, and after a read', [null, b(PING + '\n'), null, b(DONE + '\n')]],
]

describe('the codec reads like the SDK reader', () => {
  for (const [name, chunks] of rows)
    test(name, () => {
      const result = same(chunks)
      assert.ok(
        result.length > 0 || name.includes('LF') || name.includes('gives nothing') || name.includes('empty chunk'),
      )
    })

  test('the rows give messages and errors, not only silence', () => {
    assert.equal(same([b(`${PING}\n`)]).length, 1)
    const bad = same([b(`\n{nope\n[]\n`)])
    assert.deepEqual(
      bad.map(o => ('error' in o ? o.error : 'message')),
      ['SyntaxError', 'SyntaxError', 'ZodError'],
    )
  })
})

describe('the cap', () => {
  test('exactly the cap passes, one byte more fails, the text is the one of the SDK, and the buffer is cleared', () => {
    const max = 40
    const line = (n: number) => b(`{"jsonrpc":"2.0","method":"${'m'.repeat(n - 30)}"}\n`)
    assert.equal(line(max).length, max)
    const exact = same([line(max)], max)
    assert.deepEqual(
      exact.map(o => ('message' in o ? 'message' : o.error)),
      ['message'],
    )
    const over = same([b('x'.repeat(max + 1))], max)
    assert.deepEqual(over, [{ error: 'Error', text: `ReadBuffer exceeded maximum size of ${max} bytes` }])
    // The unread bytes count, complete lines included, and a failed append clears them.
    const unread = (reader: Reader): string[] => {
      const seen: string[] = []
      const add = (c: Buffer) => {
        try {
          reader.append(c)
          seen.push('ok')
        } catch (e) {
          seen.push((e as Error).message)
        }
      }
      add(b(`${PING}\n`))
      add(b(`${PING}\n`))
      add(b('x'))
      return seen
    }
    assert.deepEqual(unread(ours(60)), unread(sdk(60)))
    assert.deepEqual(unread(ours(60)), ['ok', 'ReadBuffer exceeded maximum size of 60 bytes', 'ok'])
    // The cap is in bytes, not characters: 20 characters of 3 bytes are 60 bytes.
    const bytes = same([b('漢'.repeat(20))], 59)
    assert.deepEqual(
      bytes.map(o => ('error' in o ? o.error : 'message')),
      ['Error'],
    )
    assert.deepEqual(same([b('漢'.repeat(20))], 60), [])
  })

  test('a line read frees its bytes: many lines pass under a small cap, one chunk at a time', () => {
    same(
      Array.from({ length: 20 }, () => b(`${PING}\n`)),
      PING.length + 1,
    )
  })

  test('the real cap is 10 MB, counted in bytes', () => {
    assert.equal(FRAME_MAX, 10 * 1024 * 1024)
    const head = '{"jsonrpc":"2.0","method":"x","params":{"p":"'
    const tail = '"}}\n'
    const exact = b(head, 'a'.repeat(FRAME_MAX - head.length - tail.length), tail)
    assert.equal(exact.length, FRAME_MAX)
    const passed = same([exact])
    assert.equal(passed.length, 1)
    assert.ok('message' in passed[0]!)
    const over = same([Buffer.alloc(FRAME_MAX + 1, 97)])
    assert.deepEqual(over, [{ error: 'Error', text: 'ReadBuffer exceeded maximum size of 10485760 bytes' }])
  })
})

describe('the chunks held', () => {
  test('a line that arrives one byte for each read holds a bounded number of chunks, and reads like the SDK', () => {
    const head = '{"jsonrpc":"2.0","method":"x","params":{"p":"'
    same(Array.from(Buffer.from(head + 'a'.repeat(20_000) + '"}}\n'), x => Buffer.from([x])))
    const reader = new FrameReader(deserializeMessage, utf8)
    const big = Buffer.from(head + 'é'.repeat(150_000) + '"}}\n')
    let most = 0
    for (let i = 0; i < big.length - 1; i++) {
      reader.append(big.subarray(i, i + 1))
      most = Math.max(most, reader.held)
      assert.equal(reader.read(), null)
    }
    assert.ok(most <= 512, most + ' chunks held')
    reader.append(big.subarray(big.length - 1))
    const message = reader.read() as { params: { p: string } }
    assert.equal(message.params.p, 'é'.repeat(150_000))
    assert.equal(reader.held, 1)
  })

  test('unread bytes in small chunks, with no read, also stay in few chunks', () => {
    const reader = new FrameReader(deserializeMessage, utf8)
    for (let i = 0; i < 100_000; i++) reader.append(Buffer.from('a'))
    assert.ok(reader.held <= 512, String(reader.held))
  })
})

describe('the send', () => {
  test('is the JSON of the message and a line feed, as the SDK writes it', () => {
    for (const m of [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { a: '\u{1F600}\u2028' }, [], null, 'x'])
      assert.equal(frameOf(m), serializeMessage(m as never))
  })
})

// A seeded generator, so a failure is the same on each run.
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe('500 seeded streams cut at random places', () => {
  const pieces = [
    `${PING}\n`,
    `${DONE}\r\n`,
    `${EMOJI}\n`,
    '\n',
    '\r\n',
    '   \n',
    '{nope\n',
    '[1,2]\n',
    '{"jsonrpc":"2.0","method":"p\u00e9\u{1F600}","id":3}\n',
    '\ufeff{}\n',
    '"\u2028"\n',
  ]
  for (let seed = 1; seed <= 500; seed++)
    test(`seed ${seed}`, () => {
      const rand = seeded(seed)
      const count = 1 + Math.floor(rand() * 12)
      let text = ''
      for (let i = 0; i < count; i++) text += pieces[Math.floor(rand() * pieces.length)]
      if (rand() < 0.3) text += PING.slice(0, Math.floor(rand() * 20))
      const bytes = Buffer.from(text, 'utf8')
      const chunks: Buffer[] = []
      for (let at = 0; at < bytes.length; ) {
        const size = 1 + Math.floor(rand() * (rand() < 0.5 ? 4 : 64))
        chunks.push(bytes.subarray(at, at + size))
        at += size
      }
      const max = rand() < 0.3 ? 30 + Math.floor(rand() * 200) : undefined
      same(chunks, max)
    })
})

// v2's deserializeMessage (client package 2.4.0) on the same rows, through the codec: the rows where its
// outcome differs from v1's are listed here, so a difference that changes what happens to a real server's line is seen.
describe('the codec with the deserializeMessage of v2', () => {
  const theirs = (chunks: readonly Chunk[]) => run(sdk(), chunks)
  const v2 = (chunks: readonly Chunk[]) => {
    const reader = new FrameReader(deserializeMessageV2, utf8)
    return run({ append: c => reader.append(c), read: () => reader.read(), clear: () => reader.clear() }, chunks)
  }
  const label = (o: Outcome): string => ('error' in o ? `${o.error}: ${o.text.slice(0, 40)}` : 'message')
  test('every row gives the same messages, and the same errors but for the listed names', () => {
    const differing: string[] = []
    for (const [name, chunks] of rows) {
      const one = theirs(chunks)
      const two = v2(chunks)
      assert.equal(two.length, one.length, `the number of outcomes of "${name}"`)
      one.forEach((o, i) => {
        const p = two[i]!
        if ('message' in o || 'message' in p) assert.deepEqual(p, o, `the message of "${name}"`)
        else if (o.error !== p.error) differing.push(`${name}: ${label(o)} -> ${label(p)}`)
      })
    }
    assert.deepEqual(differing, DIFFERENCES)
  })
})
