// The class of a stdio server when sharing is on (issue #63, decisions 025 and 026), and the text that names its copy.
// Sessions share one child process only when the class and this text agree. Pure: the host hashes the text.

import type { ServerEntry, ServerKey, StdioServer } from './config.ts'
import type { Bridges } from './policy.ts'

/**
 * The words of the servers that keep state between calls, so that two sessions must not share them. A convenience,
 * not a safety rule: policy, approval and the guard run in the host for each call, for every class. The list is
 * closed. A server that it misses stays per folder, and `"share": true` is the way out of a wrong match.
 */
const STATE_WORDS = [
  ['playwright', 'drives a browser'],
  ['puppeteer', 'drives a browser'],
  ['chrome-devtools', 'drives a browser'],
  ['browsermcp', 'drives a browser'],
  ['browser', 'drives a browser'],
  ['selenium', 'drives a browser'],
  ['desktop-commander', 'runs a shell'],
  ['shell', 'runs a shell'],
  ['terminal', 'runs a shell'],
] as const

/** A word counts only between characters that are not letters, with an `s` allowed at its end. */
const STATE_WORD = new RegExp(`(?<![a-z])(${STATE_WORDS.map(([word]) => word).join('|')})s?(?![a-z])`, 'i')

/** The first state word in the key, the command or an argument, in that order. */
const stateWord = (key: string, server: StdioServer): (typeof STATE_WORDS)[number] | undefined => {
  for (const text of [key, server.command, ...server.args]) {
    const word = STATE_WORD.exec(text)?.[1]?.toLowerCase()
    const row = STATE_WORDS.find(([w]) => w === word)
    if (row !== undefined) return row
  }
  return undefined
}

/** One copy for each session. It holds the rule that decided and no key: a bridge cannot get a key. */
export type Session =
  | { readonly class: 'session'; readonly rule: 1 | 2 }
  | { readonly class: 'session'; readonly rule: 3; readonly word: string; readonly reason: string }

/** A copy for the sessions that agree on the share key: all of them, or the ones in one folder. */
export type Keyed =
  | { readonly class: 'shared'; readonly rule: 2 | 4 }
  | { readonly class: 'folder'; readonly rule: 2 | 5 }

export type Class = Session | Keyed

/** The class of a server, or undefined for an HTTP or an invalid entry. The first rule that matches wins. */
export const classify = (key: ServerKey, server: ServerEntry, bridges: Bridges): Class | undefined => {
  if (server.kind !== 'stdio') return undefined
  if (bridges.has(key)) return { class: 'session', rule: 1 }
  if (server.share === false) return { class: 'session', rule: 2 }
  if (server.share === true) return { class: 'shared', rule: 2 }
  if (server.share === 'folder') return { class: 'folder', rule: 2 }
  const state = stateWord(key, server)
  if (state !== undefined) return { class: 'session', rule: 3, word: state[0], reason: state[1] }
  return server.cwd !== undefined ? { class: 'shared', rule: 4 } : { class: 'folder', rule: 5 }
}

/** Where a session runs: `home` for a shared server without `cwd`, `folder` (the host's folder) for a per-folder one. */
export type Place = { readonly home: string; readonly folder: string }

/**
 * The text that two servers share only when one copy can serve both: the command, the arguments in order, the whole
 * child environment (`env`, with `PATH`) and the folder. Not the server key, `untrusted` or `share`. JSON of arrays
 * holds each part apart, so no two different inputs give one text. Never print it: it holds env values.
 */
export const shareText = (
  class_: Keyed,
  server: StdioServer,
  env: Readonly<Record<string, string>>,
  at: Place,
): string => {
  const names = Object.keys(env).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const folder = server.cwd ?? (class_.class === 'shared' ? at.home : at.folder)
  return JSON.stringify(['toolscript-share', server.command, server.args, names.map(n => [n, env[n]]), folder])
}
