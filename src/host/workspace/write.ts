// The locks of the Workspace editing tools (issue #144, docs/adr/0144-workspace-provider.md, section Edits). A change
// holds two locks for its file: one in this process, and a lock file under HOME, so two sessions never lose an update.
// The second change then sees the new hash of the file and fails with `stale`. The lock file is the lock of the OAuth
// refresh (`takeLock`, src/host/oauthlock.ts): made with `wx`, taken over when its process is dead or it is older than
// `LIMITS.lockStaleMs`. A change waits `LIMITS.lockWaitMs` for it, then fails with `busy`.

import { createHash } from 'node:crypto'
import path from 'node:path'
import { locksFolder } from '../../core/paths.ts'
import { LIMITS, WorkspaceError, fold } from '../../core/workspace.ts'
import { dropLock, takeLock, type Held } from '../oauthlock.ts'

/**
 * The name of the lock of a file: the hash of its absolute path. `root` and `parts` are real paths, so two sessions
 * with two roots name one file alike. On a volume that ignores case the path is folded, so `A.txt` and `a.txt` share a lock.
 */
export const lockKey = (root: string, parts: readonly string[], folds: boolean): string => {
  const real = `${root.replaceAll('\\', '/')}/${parts.join('/')}`
  return createHash('sha256')
    .update(folds ? fold(real) : real)
    .digest('hex')
}

/** The locks that one change holds. `also` takes the lock of another name of the same file, when the proof found one. */
export type Hold = {
  also(key: string): Promise<void>
  release(): Promise<void>
}

export type Locker = { hold(key: string, signal: AbortSignal): Promise<Hold> }

export type LockerOptions = {
  /** Tests only: shorter times. */
  readonly waitMs?: number
  readonly staleMs?: number
}

const busy = (): WorkspaceError =>
  new WorkspaceError('busy', 'another change holds the lock of this file. Try again in a moment')

/** Waits `ms`, or until `signal` aborts. */
const nap = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    let timer: NodeJS.Timeout | undefined
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

export const createLocker = (home: string, options: LockerOptions = {}): Locker => {
  const waitMs = options.waitMs ?? LIMITS.lockWaitMs
  const staleMs = options.staleMs ?? LIMITS.lockStaleMs
  const local = new Map<string, Promise<void>>()

  /** The lock of this process: the first caller gets it, the others wait until it is released. */
  const takeLocal = async (key: string, deadline: number, signal: AbortSignal): Promise<() => void> => {
    for (;;) {
      const current = local.get(key)
      if (current === undefined) {
        let release = () => {}
        local.set(key, new Promise<void>(resolve => (release = resolve)))
        return () => {
          local.delete(key)
          release()
        }
      }
      const left = deadline - Date.now()
      if (left <= 0) throw busy()
      if (signal.aborted) throw new WorkspaceError('cancelled', 'the call was cancelled')
      await Promise.race([current, nap(left, signal)])
    }
  }

  const take = async (key: string, deadline: number, signal: AbortSignal) => {
    const unlock = await takeLocal(key, deadline, signal)
    let held: Held | 'busy' | 'none'
    try {
      held = await takeLock(
        path.join(locksFolder(home), key),
        deadline,
        staleMs,
        undefined,
        'A Workspace change makes no change without it.',
      )
    } catch (err) {
      unlock()
      throw err
    }
    if (typeof held === 'string') {
      unlock()
      throw held === 'busy'
        ? busy()
        : new WorkspaceError('io', 'Workspace cannot make its lock file, so it changes nothing')
    }
    return async () => {
      await dropLock(held)
      unlock()
    }
  }

  return {
    hold: async (key, signal) => {
      const deadline = Date.now() + waitMs
      const keys = new Set([key])
      const releases = [await take(key, deadline, signal)]
      return {
        also: async other => {
          if (keys.has(other)) return
          releases.push(await take(other, deadline, signal))
          keys.add(other)
        },
        release: async () => {
          for (const release of releases.splice(0).reverse()) await release()
        },
      }
    },
  }
}
