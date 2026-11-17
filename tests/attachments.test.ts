// Non-text blocks of a tool result: the program gets a reference to a file,
// never the base64 data, and a returned image reference shows as an image.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FILE_SIZE,
  MAX_RUN_ATTACHMENTS,
  MAX_RUN_ATTACHMENT_BYTES,
  MAX_SEARCHED_VALUES,
  base64Bytes,
  hiddenImagesNote,
  holdsImage,
  mcpReply,
  returnedImages,
  runFiles,
  savedReply,
} from '../src/core/protocol.ts'

const PNG = Buffer.from('fake png bytes').toString('base64')
const WAV = Buffer.from('fake wav').toString('base64')

// Numbered paths, so a test can name the file of each attachment.
const files = () => {
  let n = 0
  return (extension: string) => ({ file: `/files/a${++n}${extension}` })
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
    assert.deepEqual(r.files, [{ file: '/files/a1.png', data: PNG, mimeType: 'image/png' }])
    assert.equal(JSON.stringify(r.reply).includes(PNG), false, 'no base64 in the value')
  })

  test('a text block whose text is not a string keeps the text shape', () => {
    const noFile = () => assert.fail('no file expected')
    assert.deepEqual(
      mcpReply(
        {
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 5 },
          ],
          isError: false,
        },
        noFile,
      ),
      { reply: { ok: true, value: 'a\n[text block]' }, files: [] },
    )
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
    assert.deepEqual(r.files, [{ file: '/files/a1.pdf', data: WAV, mimeType: 'application/pdf' }])
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
    const none = { type: 'image', mimeType: 'image/png', bytes: 0, error: 'the block has no base64 data: not written' }
    const r = mcpReply(
      {
        content: [
          { type: 'image', data: big, mimeType: 'image/png' },
          { type: 'image', data: 'not base64!', mimeType: 'image/png' },
          { type: 'image', data: '', mimeType: 'image/png' },
          { type: 'image', mimeType: 'image/png' },
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
          none,
          none,
          none,
        ],
      },
    })
  })

  test('the files of one run stop at the count and byte caps, and the next attachments say why', () => {
    const count = runFiles(extension => `/files/x${extension}`)
    for (let i = 0; i < MAX_RUN_ATTACHMENTS; i++) assert.deepEqual(count('.png', 1), { file: '/files/x.png' })
    assert.deepEqual(count('.png', 1), {
      error: `one run writes at most ${MAX_RUN_ATTACHMENTS} attachments: not written`,
    })
    const size = runFiles(extension => `/files/y${extension}`)
    assert.deepEqual(size('.wav', MAX_RUN_ATTACHMENT_BYTES - 1), { file: '/files/y.wav' })
    const over = { error: `the attachments of one run hold at most ${MAX_RUN_ATTACHMENT_BYTES} bytes: not written` }
    assert.deepEqual(size('.png', 2), over)
    // A smaller one still fits.
    assert.deepEqual(size('.png', 1), { file: '/files/y.png' })
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

  test('returnedImages finds image references at any depth, in order, each file once', () => {
    const ref = (n: number) => ({ type: 'image', mimeType: 'image/png', bytes: 1, file: `/f/${n}.png` })
    const want = (...ns: number[]) => ({ files: ns.map(n => `/f/${n}.png`), unsearched: false })
    assert.deepEqual(returnedImages(JSON.stringify(ref(1))), want(1))
    assert.deepEqual(returnedImages(JSON.stringify([ref(1), ref(2), ref(1)])), want(1, 2))
    // The whole call result: { value, attachments: [...] }.
    assert.deepEqual(returnedImages(JSON.stringify({ value: 'x', attachments: [ref(3)] })), want(3))
    assert.deepEqual(
      returnedImages(JSON.stringify([{ attachments: [ref(4)] }, { a: { b: { c: ref(5) } } }])),
      want(4, 5),
    )
    // The reference needs no mimeType: the host has the type of the file it wrote.
    assert.deepEqual(returnedImages(JSON.stringify({ type: 'image', file: '/f/6.png' })), want(6))
    // An object typed image that holds attachments: the search goes on inside it.
    assert.deepEqual(returnedImages(JSON.stringify({ type: 'image', attachments: [ref(7)] })), want(7))
    // No file (not written), another type, or not JSON: nothing to show.
    assert.deepEqual(returnedImages(JSON.stringify({ type: 'image', mimeType: 'image/png', error: 'x' })), want())
    assert.deepEqual(returnedImages(JSON.stringify({ type: 'audio', mimeType: 'audio/wav', file: '/f/a.wav' })), want())
    assert.deepEqual(returnedImages('not json'), want())
  })

  test('returnedImages stops after MAX_SEARCHED_VALUES values, and says so only when a reference is past them', () => {
    const filler = Array.from({ length: MAX_SEARCHED_VALUES }, (_, i) => i)
    const ref = { type: 'image', file: '/f/late.png' }
    assert.deepEqual(returnedImages(JSON.stringify([filler, ref])), { files: [], unsearched: true })
    assert.deepEqual(returnedImages(JSON.stringify([ref, filler])), { files: ['/f/late.png'], unsearched: false })
    assert.deepEqual(returnedImages(JSON.stringify([filler, 'x'])), { files: [], unsearched: false })
  })

  test('hiddenImagesNote names each image that does not show and why', () => {
    assert.equal(hiddenImagesNote([], false), '')
    assert.equal(
      hiddenImagesNote(
        [
          { file: '/f/5.png', why: 'count' },
          { file: '/etc/x.png', why: 'not-written' },
          { file: '/f/6.png', why: 'not-image' },
        ],
        false,
      ),
      [
        '3 returned images are not shown:',
        '- /f/5.png: at most 4 images show per run',
        '- /etc/x.png: it is not an image file that a call of this session wrote',
        '- /f/6.png: the file does not hold an image of its type',
      ].join('\n'),
    )
    const many = Array.from({ length: 12 }, (_, i) => ({ file: `/f/${i}.png`, why: 'count' as const }))
    const note = hiddenImagesNote(many, true).split('\n')
    assert.equal(note[0], '12 returned images are not shown:')
    assert.equal(note.length, 1 + 8 + 2)
    assert.equal(note[9], '- 4 more')
    assert.equal(
      note[10],
      `Image references after the first ${MAX_SEARCHED_VALUES} values of the return value are not shown: return fewer values.`,
    )
  })

  test('holdsImage checks the bytes against the type', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
    const webp = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1')
    assert.equal(holdsImage('image/png', png), true)
    assert.equal(holdsImage('image/jpeg', jpeg), true)
    assert.equal(holdsImage('image/gif', gif), true)
    assert.equal(holdsImage('image/webp', webp), true)
    assert.equal(holdsImage('image/png', jpeg), false)
    assert.equal(holdsImage('image/webp', Buffer.from('RIFF\x24\x00\x00\x00WAVE', 'latin1')), false)
    assert.equal(holdsImage('image/png', Buffer.alloc(0)), false)
    assert.equal(holdsImage('image/svg+xml', Buffer.from('<svg/>')), false)
  })
})
