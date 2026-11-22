// What the broker and the hosts share in Node: the key file, the build id and the endpoint that both compute from them,
// and the HMAC. The broker bundle holds this file, so it imports Node built-ins only.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { endpointOf, type Crypto } from '../core/broker.ts'
import { brokerFolder } from '../core/paths.ts'

const KEY_BYTES = 32

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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
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
  if (key === undefined) throw new Error('the broker key file is not 32 bytes long')
  return key
}

/** The endpoint of the broker of this key and build. `home` is the folder of the key file. */
export const endpointFor = (home: string, key: Buffer, id: string, platform = process.platform): string =>
  endpointOf(platform, home, makeCrypto(key).mac(`toolscript-mcp build ${id}`))
