// The framing of a direct stdio child (issue #154): bytes to lines, the cap, and the line of a send. It is the framing
// of the SDK's ReadBuffer (v1 1.32.2), kept in our own code so a change of SDK cannot change how stdout becomes
// messages. The check that a line is a JSON-RPC message is the SDK's: the host passes it in as `parse`. Pure: the
// host also passes in the UTF-8 decoder, and `tests/codec.test.ts` compares this with the SDK reader on the same bytes.

/** The most bytes that a reader holds unread: 10 MB, counted in bytes, complete unread lines included. */
export const FRAME_MAX = 10 * 1024 * 1024

/** The text of the bytes as UTF-8, with U+FFFD for a bad byte, and a BOM kept. */
export type Utf8 = (bytes: Uint8Array) => string

/** More chunks than this are joined: the cap counts bytes, so one byte for each read would hold millions of objects. */
const CHUNKS_MAX = 256

const total = (parts: readonly Uint8Array[]): number => parts.reduce((n, part) => n + part.length, 0)

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(total(parts))
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }
  return bytes
}

/**
 * Reads lines from chunks of bytes. A line ends at the byte 10; one CR before it is removed; the line is decoded as a
 * whole. `parse` throws for a line that is not a message, and that line is consumed. A line with no end yet gives
 * nothing, and a partial line at the end of the stream is never a message. The unread chunks are kept as they came, and
 * the first `#quiet` of them hold no line feed, so each chunk is searched once. Past CHUNKS_MAX chunks they are joined
 * into one: the copy is one for each CHUNKS_MAX reads, where the SDK reader copies at each read.
 */
export class FrameReader<T> {
  readonly #parse: (line: string) => T
  readonly #utf8: Utf8
  readonly #max: number
  #chunks: Uint8Array[] = []
  #quiet = 0
  #size = 0

  constructor(parse: (line: string) => T, utf8: Utf8, max = FRAME_MAX) {
    this.#parse = parse
    this.#utf8 = utf8
    this.#max = max
  }

  /** The number of chunks held. */
  get held(): number {
    return this.#chunks.length
  }

  /** Adds a chunk. Over the cap, the buffer is cleared and this throws: the text is the one of the SDK reader. */
  append(chunk: Uint8Array): void {
    const size = this.#size + chunk.length
    if (size > this.#max) {
      this.clear()
      throw new Error(`ReadBuffer exceeded maximum size of ${this.#max} bytes`)
    }
    this.#chunks.push(chunk)
    this.#size = size
    if (this.#chunks.length > CHUNKS_MAX) {
      this.#chunks = [join(this.#chunks)]
      this.#quiet = 0
    }
  }

  /** The next message, or null when no complete line is left. */
  read(): T | null {
    const chunks = this.#chunks
    for (let i = this.#quiet; i < chunks.length; i++) {
      const last = chunks[i]!
      const end = last.indexOf(10)
      if (end === -1) {
        this.#quiet = i + 1
        continue
      }
      const head = last.subarray(0, end)
      const line = this.#utf8(i === 0 ? head : join([...chunks.slice(0, i), head])).replace(/\r$/, '')
      this.#chunks = [last.subarray(end + 1), ...chunks.slice(i + 1)]
      this.#quiet = 0
      this.#size = total(this.#chunks)
      return this.#parse(line)
    }
    return null
  }

  clear(): void {
    this.#chunks = []
    this.#quiet = 0
    this.#size = 0
  }
}

/** The line that a send writes: the JSON of the message and a line feed. */
export const frameOf = (message: unknown): string => `${JSON.stringify(message)}\n`
