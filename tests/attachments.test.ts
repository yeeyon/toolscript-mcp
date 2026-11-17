// Non-text blocks of a tool result: the program gets a reference to a file,
// never the base64 data, and a returned image reference shows as an image.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FILE_SIZE,
  base64Bytes,
  hiddenImagesNote,
  mcpReply,
  returnedImages,
  savedReply,
} from '../src/core/protocol.ts'

const PNG = Buffer.from('fake png bytes').toString('base64')
const WAV = Buffer.from('fake wav').toString('base64')

// Numbered paths, so a test can name the file of each attachment.
const files = () => {
  let n = 0
  return (extension: string) => `/files/a${++n}${extension}`
}
const image = { type: 'image', data: PNG, mimeType: 'image/png' }

describe('attachments', () => {
  test('a result with only text or structured content keeps its value and writes no file', () => {
    const noFile = () => assert.fail('no file expected')
    assert.deepEqual(mcpReply({ content: [{ type: 'text', text: '{"a":1}' }], isError: false }, noFile), {
      reply: { ok: true, value: { a: 1 } },
      files: [],
    })
    assert.deepEqual(
      mcpReply({ content: [{ type: 'text', text: 'x' }], isError: false, structuredContent: { b: 2 } }, noFile),
      { reply: { ok: true, value: { b: 2 } }, files: [] },
    )
    assert.deepEqual(mcpReply({ content: [], isError: false }, noFile), { reply: { ok: true, value: '' }, files: [] })
  })

  test('an image-only result is a null value and one image reference with its file', () => {
    const r = mcpReply({ content: [image], isError: false }, files())
    assert.deepEqual(r.reply, {
      ok: true,
      value: {
        value: null,
        attachments: [{ type: 'image', mimeType: 'image/png', bytes: 14, file: '/files/a1.png' }],
      },
    })
    assert.deepEqual(r.files, [{ file: '/files/a1.png', data: PNG }])
    assert.equal(JSON.stringify(r.reply).includes(PNG), false, 'no base64 in the value')
  })

  test('a mixed result keeps the value of its text and lists its other blocks in order', () => {
    const r = mcpReply(
      {
        content: [{ type: 'text', text: '{"panel":7}' }, image, { type: 'audio', data: WAV, mimeType: 'audio/wav' }],
        isError: false,
      },
      files(),
    )
    assert.deepEqual(r.reply, {
      ok: true,
      value: {
        value: { panel: 7 },
        attachments: [
          { type: 'image', mimeType: 'image/png', bytes: 14, file: '/files/a1.png' },
          { type: 'audio', mimeType: 'audio/wav', bytes: 8, file: '/files/a2.wav' },
        ],
      },
    })
    assert.deepEqual(
      r.files.map(f => f.file),
      ['/files/a1.png', '/files/a2.wav'],
    )
  })

  test('structured content stays the value next to the attachments', () => {
    const r = mcpReply(
      { content: [{ type: 'text', text: 'x' }, image], isError: false, structuredContent: { b: 2 } },
      files(),
    )
    assert.deepEqual(r.reply, {
      ok: true,
      value: {
        value: { b: 2 },
        attachments: [{ type: 'image', mimeType: 'image/png', bytes: 14, file: '/files/a1.png' }],
      },
    })
  })

  test('a text resource keeps its text, and a blob resource is a file', () => {
    const r = mcpReply(
      {
        content: [
          { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello' } },
          { type: 'resource', resource: { uri: 'file:///b.pdf', mimeType: 'application/pdf', blob: WAV } },
        ],
        isError: false,
      },
      files(),
    )
    assert.deepEqual(r.reply, {
      ok: true,
      value: {
        value: null,
        attachments: [
          { type: 'resource', uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello' },
          { type: 'resource', uri: 'file:///b.pdf', mimeType: 'application/pdf', bytes: 8, file: '/files/a1.pdf' },
        ],
      },
    })
    assert.deepEqual(r.files, [{ file: '/files/a1.pdf', data: WAV }])
  })

  test('a resource_link is a reference with no fetch, and an unknown block keeps its type', () => {
    const r = mcpReply(
      {
        content: [
          { type: 'resource_link', uri: 'https://example.com/r/1', name: 'r1', mimeType: 'text/csv' },
          { type: 'resource_link', uri: 'https://example.com/r/2' },
          { type: 'document' },
        ],
        isError: false,
      },
      () => assert.fail('no file expected'),
    )
    assert.deepEqual(r.reply, {
      ok: true,
      value: {
        value: null,
        attachments: [
          { type: 'resource_link', uri: 'https://example.com/r/1', name: 'r1', mimeType: 'text/csv' },
          { type: 'resource_link', uri: 'https://example.com/r/2' },
          { type: 'document' },
        ],
      },
    })
    assert.deepEqual(r.files, [])
  })

  test('an attachment over the file limit, or with no base64 data, is not written and says why', () => {
    // A multiple of 3 bytes, so the base64 has no padding.
    const bytes = MAX_FILE_SIZE + 2
    const big = 'A'.repeat((bytes / 3) * 4)
    const r = mcpReply(
      {
        content: [
          { type: 'image', data: big, mimeType: 'image/png' },
          { type: 'image', data: 'not base64!', mimeType: 'image/png' },
        ],
        isError: false,
      },
      () => assert.fail('no file expected'),
    )
    assert.deepEqual(r.files, [])
    assert.deepEqual(r.reply, {
      ok: true,
      value: {
        value: null,
        attachments: [
          {
            type: 'image',
            mimeType: 'image/png',
            bytes,
            error: `${bytes} bytes is more than the file limit of ${MAX_FILE_SIZE}: not written`,
          },
          { type: 'image', mimeType: 'image/png', bytes: 0, error: 'the block has no base64 data: not written' },
        ],
      },
    })
  })

  test('a tool error stays the text of its blocks, with no base64 and no file', () => {
    const r = mcpReply({ content: [{ type: 'text', text: 'render failed' }, image], isError: true }, () =>
      assert.fail('no file expected'),
    )
    assert.deepEqual(r, { reply: { ok: false, error: 'render failed\n[image block]' }, files: [] })
  })

  test('saved content blocks get the same reply as a live result', () => {
    const blocks = JSON.stringify([{ type: 'text', text: 'chart' }, image])
    assert.deepEqual(
      savedReply('blocks', blocks, files()),
      mcpReply(JSON.parse(`{"content":${blocks},"isError":false}`), files()),
    )
  })

  test('base64Bytes counts the decoded bytes', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'hello world']) {
      const b64 = Buffer.from(text).toString('base64')
      assert.equal(base64Bytes(b64), text.length, b64)
      assert.equal(base64Bytes(b64.replace(/=+$/, '')), text.length, `${b64} without padding`)
    }
    assert.equal(base64Bytes('aGVs\nbG8='), 5)
    assert.equal(base64Bytes('abcde'), undefined)
    assert.equal(base64Bytes('ab$d'), undefined)
  })

  test('returnedImages finds image references up to two levels deep, each file once', () => {
    const ref = (n: number) => ({ type: 'image', mimeType: 'image/png', bytes: 1, file: `/f/${n}.png` })
    const want = (...ns: number[]) => ns.map(n => ({ file: `/f/${n}.png`, mimeType: 'image/png' }))
    assert.deepEqual(returnedImages(JSON.stringify(ref(1))), want(1))
    assert.deepEqual(returnedImages(JSON.stringify([ref(1), ref(2), ref(1)])), want(1, 2))
    // The whole call result: { value, attachments: [...] }.
    assert.deepEqual(returnedImages(JSON.stringify({ value: 'x', attachments: [ref(3)] })), want(3))
    assert.deepEqual(returnedImages(JSON.stringify({ a: { b: { c: ref(4) } } })), [])
    // No file (not written), another type, or not JSON: nothing to show.
    assert.deepEqual(returnedImages(JSON.stringify({ type: 'image', mimeType: 'image/png', error: 'x' })), [])
    assert.deepEqual(returnedImages(JSON.stringify({ type: 'audio', mimeType: 'audio/wav', file: '/f/a.wav' })), [])
    assert.deepEqual(returnedImages('not json'), [])
  })

  test('hiddenImagesNote names each image that does not show and why', () => {
    assert.equal(hiddenImagesNote([]), '')
    assert.equal(
      hiddenImagesNote([
        { file: '/f/5.png', why: 'count' },
        { file: '/etc/x.png', why: 'outside' },
      ]),
      '2 returned images are not shown:\n- /f/5.png: at most 4 images show per run\n- /etc/x.png: it is not a file from this session',
    )
  })
})
