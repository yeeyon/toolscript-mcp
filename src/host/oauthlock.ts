// The lock of an OAuth refresh: `<store file>.lock`, made with O_EXCL, so processes that share a store send one refresh
// at a time. A rotating refresh token works once, and a server with reuse detection revokes the grant on a second use.
// The file holds a pid, a random id and a time (src/core/lock.ts), never a secret.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LOCK_MAX_BYTES, lockStale, lockText, parseLock, type LockContent } from '../core/lock.ts'

/** The file calls of the lock. A test gives its own, to fail one of them. */
export type LockFs = Pick<typeof fs.promises, 'open' | 'readFile' | 'stat' | 'unlink' | 'mkdir'>

/** The lock of this process: the file and the id that it holds. */
export type Held = { readonly file: string; readonly id: string }

const POLL_MIN_MS = 50
const POLL_SPAN_MS = 100
// Windows keeps a file that a reader has open in a state where it refuses a new file of the same name.
const WINDOWS_BUSY = ['EPERM', 'EACCES', 'EBUSY']
const warned = new Set<string>()

const codeOf = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? 'unknown'

const pidLives = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return codeOf(err) !== 'ESRCH'
  }
}

// O_NONBLOCK: a FIFO at the path does not block the open. Windows has no such flag and no FIFO at a file path.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)

/**
 * The lock file at `file` as one waiter sees it, or undefined when it cannot be read: gone, or being removed. The age
 * and the content come from one open file: another waiter can put a new lock at the path between two calls by name,
 * and the age of the old file with the id of the new one would take over a live lock.
 */
const look = async (file: string, io: LockFs) => {
  let handle: Awaited<ReturnType<LockFs['open']>>
  try {
    handle = await io.open(file, READ_FLAGS)
  } catch {
    return undefined
  }
  try {
    const stat = await handle.stat()
    const text = stat.isFile() && stat.size <= LOCK_MAX_BYTES ? await handle.readFile('utf8') : ''
    const content = parseLock(text)
    // A file that does not parse has no id: its time stands for it, so a waiter takes over only the file that it saw.
    return { content, ageMs: Date.now() - stat.mtimeMs, identity: content?.id ?? `x${Math.trunc(stat.mtimeMs)}` }
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => {})
  }
}

type Made = 'made' | 'held' | { readonly failed: string }

/** Makes `file` with `content`, or says that it exists. The folder of the store is made when it is missing. */
const make = async (file: string, content: LockContent, io: LockFs): Promise<Made> => {
  let busy = 0
  for (let again = true; ; again = false) {
    let handle: Awaited<ReturnType<LockFs['open']>>
    try {
      handle = await io.open(file, 'wx', 0o600)
    } catch (err) {
      const code = codeOf(err)
      if (code === 'EEXIST') return 'held'
      if (code === 'ENOENT' && again) {
        try {
          await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
          continue
        } catch (mkdirErr) {
          return { failed: codeOf(mkdirErr) }
        }
      }
      if (process.platform === 'win32' && WINDOWS_BUSY.includes(code)) {
        // A file in the state of a removal that waits for its last reader gives no stat either: only ENOENT says that
        // the path is free. Then a new create gets the answer of the next state.
        const exists = await io.stat(file).then(
          () => true,
          statErr => codeOf(statErr) !== 'ENOENT',
        )
        if (exists) return 'held'
        if (busy++ < 3) {
          await new Promise(resolve => setTimeout(resolve, 20))
          continue
        }
      }
      return { failed: code }
    }
    try {
      await handle.writeFile(lockText(content))
    } catch (err) {
      await handle.close().catch(() => {})
      await io.unlink(file).catch(() => {})
      return { failed: codeOf(err) }
    }
    await handle.close()
    return 'made'
  }
}

/**
 * Takes over the lock file that `file` holds when it is stale. Waiters that see one stale file make `claim`, a file
 * named for that lock: only one of them makes it, so only one removes the lock, and a waiter that comes late sees a
 * new lock under the old claim name and leaves it. Returns true after a takeover, so the caller makes its lock at once.
 */
const takeOver = async (file: string, staleAfterMs: number, io: LockFs): Promise<boolean> => {
  const seen = await look(file, io)
  if (seen === undefined) return false
  if (!lockStale(seen.content, seen.ageMs, seen.content !== undefined && pidLives(seen.content.pid), staleAfterMs))
    return false
  const claim = `${file}.${seen.identity}.claim`
  const made = await make(claim, { pid: process.pid, id: randomUUID(), at: Date.now() }, io)
  if (made !== 'made') {
    // A claim of a dead process, or an old one, goes too: the next poll tries again.
    if (made === 'held') {
      const old = await look(claim, io)
      if (
        old &&
        lockStale(old.content, old.ageMs, old.content !== undefined && pidLives(old.content.pid), staleAfterMs)
      )
        await io.unlink(claim).catch(() => {})
    }
    return false
  }
  try {
    const now = await look(file, io)
    if (now?.identity === seen.identity) await io.unlink(file)
    return true
  } catch {
    return false
  } finally {
    await io.unlink(claim).catch(() => {})
  }
}

/**
 * Takes the lock of `file` before `deadline` (an epoch time in ms). 'busy' means another process held it to the
 * deadline. 'none' means the lock cannot be made here (a full disk, a read-only folder): the caller refreshes without
 * it, as before the lock, and a line on stderr says so once for each file.
 */
export const takeLock = async (
  file: string,
  deadline: number,
  staleAfterMs: number,
  io: LockFs = fs.promises,
): Promise<Held | 'busy' | 'none'> => {
  const lock = `${file}.lock`
  const content: LockContent = { pid: process.pid, id: randomUUID(), at: Date.now() }
  for (;;) {
    const made = await make(lock, content, io)
    if (made === 'made') return { file: lock, id: content.id }
    if (made !== 'held') {
      if (!warned.has(lock)) {
        warned.add(lock)
        console.error(`toolscript-mcp: cannot make ${lock} (${made.failed}). The OAuth refresh runs without a lock.`)
      }
      return 'none'
    }
    if (Date.now() >= deadline) return 'busy'
    if (await takeOver(lock, staleAfterMs, io)) continue
    await new Promise(resolve => setTimeout(resolve, POLL_MIN_MS + Math.random() * POLL_SPAN_MS))
  }
}

/** Removes the lock when it still holds this process's id: another process took over a lock that looked stale. */
export const dropLock = async (held: Held, io: LockFs = fs.promises): Promise<void> => {
  const start = Date.now()
  for (;;) {
    try {
      const text = await io.readFile(held.file, 'utf8').catch(() => '')
      if (parseLock(text)?.id === held.id) await io.unlink(held.file)
      return
    } catch (err) {
      // Windows refuses the removal while a waiter reads the file. A lock that stays blocks the others for its age.
      if (!WINDOWS_BUSY.includes(codeOf(err)) || Date.now() - start >= DROP_WAIT_MS) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}
const DROP_WAIT_MS = 1000
