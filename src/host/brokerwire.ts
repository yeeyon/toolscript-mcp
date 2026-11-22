// What the broker and the hosts share in Node: the key file, the build id and the endpoint that both compute from them,
// and the HMAC. The broker bundle holds this file, so it imports Node built-ins only.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { endpointOf, parseStderrFrame, STDERR_CHUNK, stderrFrame, type Crypto } from '../core/broker.ts'
import { brokerFolder } from '../core/paths.ts'

const KEY_BYTES = 32
/** The error code of a key file of the wrong length, which a person fixes by deleting it. */
export const BAD_KEY = 'EBADKEY'

/** The HMAC-SHA-256 of the key over the text, the random nonce, and the comparison in constant time. */
export const makeCrypto = (key: Buffer): Crypto => ({
  mac: text => crypto.createHmac('sha256', key).update(text).digest('hex'),
  nonce: () => crypto.randomBytes(16).toString('hex'),
  same: (a, b) => {
    const x = Buffer.from(a)
    const y = Buffer.from(b)
    return x.length === y.length && crypto.timingSafeEqual(x, y)
  },
})

/** Stderr text of a child as frames of at most STDERR_CHUNK bytes. */
export const stderrFrames = (data: Buffer): string[] => {
  const out: string[] = []
  for (let at = 0; at < data.length; at += STDERR_CHUNK)
    out.push(stderrFrame(data.subarray(at, at + STDERR_CHUNK).toString('base64')))
  return out
}

/** The stderr text of a broker frame (a Buffer, or the count of bytes dropped), or undefined for any other line. */
export const parseStderr = (line: string): { readonly data: Buffer } | { readonly dropped: number } | undefined => {
  const got = parseStderrFrame(line)
  return got === undefined ? undefined : 'data' in got ? { data: Buffer.from(got.data, 'base64') } : got
}

/** The SHA-256 of a file: the build id of a `broker.js`. Two builds whose code differs never share an endpoint. */
export const buildId = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/**
 * The key of this user: 32 random bytes in the broker folder (0700), made with a hard link of a private temp file, so
 * two starts at once end with one key that both read, and no reader sees a half-written file.
 */
export const loadKey = (home: string): Buffer => {
  const dir = brokerFolder(home)
  const file = `${dir}/key`
  const read = (): Buffer | undefined => {
    try {
      const key = fs.readFileSync(file)
      return key.length === KEY_BYTES ? key : undefined
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }
  const have = read()
  if (have !== undefined) return have
  privateFolder(dir)
  const temp = `${dir}/key.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, crypto.randomBytes(KEY_BYTES), { flag: 'wx', mode: 0o600 })
    try {
      fs.linkSync(temp, file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  } finally {
    fs.rmSync(temp, { force: true })
  }
  const key = read()
  if (key === undefined) throw Object.assign(new Error('the broker key file is not 32 bytes long'), { code: BAD_KEY })
  return key
}

/** The endpoint of the broker of this key and build. `home` is the folder of the key file. */
export const endpointFor = (home: string, key: Buffer, id: string, platform = process.platform): string =>
  endpointOf(platform, home, makeCrypto(key).mac(`toolscript-mcp build ${id}`), process.getuid?.() ?? 0)

/**
 * Makes a folder for sockets or keys that only this user can enter, and tightens one that exists with wider modes.
 * Outside Windows it must be a real folder (no link) that this user owns, else it throws: a folder of another user
 * in `/tmp` is no place for a socket.
 */
export const privateFolder = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  const problem = folderProblem(dir)
  if (problem !== undefined) throw new Error(`the folder ${problem}`)
  if ((fs.lstatSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
}

/**
 * Why `privateFolder` refuses this folder: it is a link or a file, or another user owns it. Undefined when it may be
 * used, also when it does not exist yet (the broker makes it) and on Windows. The text holds no path.
 */
export const folderProblem = (dir: string): string | undefined => {
  if (process.platform === 'win32') return undefined
  let info: fs.Stats
  try {
    info = fs.lstatSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? undefined : `cannot be read (${code ?? 'error'})`
  }
  if (!info.isDirectory()) return 'is a link or a file, not a folder'
  if (info.uid !== process.getuid?.()) return 'belongs to another user'
  return undefined
}
