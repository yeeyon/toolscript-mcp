// The pure parts of the lock of an OAuth refresh (src/host/oauthlock.ts): what the file holds, how to read it as
// untrusted text, and when it is stale. The lock file never holds a token, a client or a server name.

import { parseJson } from './config.ts'

/** What a lock file holds: the process that made it, a random id that only that process knows, and the time. */
export type LockContent = { readonly pid: number; readonly id: string; readonly at: number }

/** A lock file is a few dozen bytes. A bigger one is not ours: its content is not read. */
export const LOCK_MAX_BYTES = 512

export const lockText = (content: LockContent): string => JSON.stringify(content)

const ID = /^[0-9a-f-]{36}$/

/** The content in `text`, or undefined when it is not what `lockText` writes. Another program can write the file. */
export const parseLock = (text: string): LockContent | undefined => {
  const json = parseJson(text)
  if (!json.ok || typeof json.value !== 'object' || json.value === null) return undefined
  const { pid, id, at } = json.value as Record<string, unknown>
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && typeof id === 'string' && ID.test(id)
    ? { pid, id, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 }
    : undefined
}

/**
 * True when a waiter may take the lock over. The pid of a lock that parses is dead: the holder cannot finish, so no
 * wait for the age. Any lock older than `staleAfterMs` goes, also one that does not parse. A live pid is never taken
 * over before the age, since a dead process can leave a pid that another program reuses.
 */
export const lockStale = (
  content: LockContent | undefined,
  ageMs: number,
  pidLives: boolean,
  staleAfterMs: number,
): boolean => ageMs > staleAfterMs || (content !== undefined && !pidLives)
