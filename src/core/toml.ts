// A strict reader of the [mcp_servers.<name>] tables of a Codex config.toml, for init (issue #86). It splits the file into
// tables and reads the values of the server tables with no guess: a server whose table holds any syntax that init does
// not read is skipped, and a file that it cannot split into tables gives no server at all. It builds no regular
// expression from the file, and never puts file text into a reason: a reason holds a fixed text and a line number.

/** What a value of a server table can be when init reads it: a string, a number, a boolean, a list or a table of strings. */
export type CodexField = string | number | boolean | string[] | { [key: string]: string }

export type CodexTomlServer =
  | { readonly name: string; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly name: string; readonly skip: string }

export type CodexToml =
  | { readonly ok: true; readonly servers: readonly CodexTomlServer[] }
  | { readonly ok: false; readonly why: string }

/** The text that init reads, in bytes. A larger file gives no server. */
export const TOML_MAX = 1024 * 1024

export const UNREADABLE_ENTRY = 'init cannot read this entry'

/** `env_vars` of Codex can hold `{ name, source }` tables. init reads names only. */
export const ENV_VARS_TABLE = 'a table in env_vars (name and source) is a form that init does not read'

const MAX_DEPTH = 16

type Val = {
  readonly v: unknown
  readonly plain: boolean
  /** An inline table. */
  readonly table?: true
  /** A list with an inline table in it. */
  readonly tables?: true
}

class Bad extends Error {
  readonly line: number
  constructor(line: number, why: string) {
    super(why)
    this.line = line
  }
}

type Scan = { readonly t: string; i: number }

const lineOf = (s: Scan, at = s.i): number => {
  let n = 1
  for (let k = 0; k < at && k < s.t.length; k++) if (s.t.charCodeAt(k) === 10) n++
  return n
}

const bad = (s: Scan, why: string): never => {
  throw new Bad(lineOf(s), why)
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t'
const BARE = /^[A-Za-z0-9_-]$/

/** Skips spaces and tabs, and with `lines` also newlines and comments. */
const skip = (s: Scan, lines: boolean): void => {
  for (;;) {
    const c = s.t[s.i]
    if (isSpace(c)) s.i++
    else if (lines && (c === '\n' || c === '\r')) s.i++
    else if (lines && c === '#') {
      while (s.i < s.t.length && s.t[s.i] !== '\n') s.i++
    } else return
  }
}

/** The end of a statement: spaces, then a comment, then a newline or the end of the text. */
const endOfLine = (s: Scan): void => {
  skip(s, false)
  if (s.t[s.i] === '#') while (s.i < s.t.length && s.t[s.i] !== '\n') s.i++
  if (s.i >= s.t.length) return
  if (s.t[s.i] === '\r' && s.t[s.i + 1] === '\n') s.i++
  if (s.t[s.i] !== '\n') bad(s, 'text after a value')
  s.i++
}

const ESCAPES: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

const basicString = (s: Scan): string => {
  s.i++
  let out = ''
  for (;;) {
    const c = s.t[s.i]
    if (c === undefined || c === '\n' || c === '\r') return bad(s, 'a string that does not end')
    s.i++
    if (c === '"') return out
    if (c !== '\\') {
      const code = c.charCodeAt(0)
      // TOML allows a tab and no other control character in a string. An escape such as \u001b is checked by the map.
      if ((code < 0x20 && code !== 9) || code === 0x7f) return bad(s, 'a control character in a string')
      out += c
      continue
    }
    const e = s.t[s.i++]
    if (e !== undefined && Object.hasOwn(ESCAPES, e)) out += ESCAPES[e]!
    else if (e === 'u' || e === 'U') {
      const n = e === 'u' ? 4 : 8
      const hex = s.t.slice(s.i, s.i + n)
      const code = /^[0-9A-Fa-f]+$/.test(hex) && hex.length === n ? parseInt(hex, 16) : NaN
      if (!(code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return bad(s, 'an escape that is not valid')
      out += String.fromCodePoint(code)
      s.i += n
    } else return bad(s, 'an escape that is not valid')
  }
}

const literalString = (s: Scan): string => {
  const end = s.t.indexOf("'", s.i + 1)
  const text = end === -1 ? undefined : s.t.slice(s.i + 1, end)
  if (text === undefined || text.includes('\n')) return bad(s, 'a string that does not end')
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(text)) return bad(s, 'a control character in a string')
  s.i = end + 1
  return text
}

/** A multi-line string: init does not read its value. */
const multiline = (s: Scan, quote: string): void => {
  s.i += 3
  for (;;) {
    if (s.i >= s.t.length) return bad(s, 'a string that does not end')
    if (quote === '"' && s.t[s.i] === '\\') s.i += 2
    else if (s.t.startsWith(quote.repeat(3), s.i)) {
      s.i += 3
      while (s.t[s.i] === quote) s.i++
      return
    } else s.i++
  }
}

const simpleKey = (s: Scan): string => {
  const c = s.t[s.i]
  if (c === '"') return basicString(s)
  if (c === "'") return literalString(s)
  let out = ''
  while (s.i < s.t.length && BARE.test(s.t[s.i]!)) out += s.t[s.i++]
  return out === '' ? bad(s, 'a key that is not valid') : out
}

/** A key, dotted or not, up to its next character that is not part of it. */
const keyPath = (s: Scan): string[] => {
  const parts = [simpleKey(s)]
  for (;;) {
    skip(s, false)
    if (s.t[s.i] !== '.') return parts
    s.i++
    skip(s, false)
    parts.push(simpleKey(s))
  }
}

const NUMBER_PLAIN = /^[+-]?(0|[1-9][0-9]*(_[0-9]+)*)$/
const FLOAT_PLAIN = /^[+-]?(0|[1-9][0-9]*)\.[0-9]+$/
const TOKEN = /^[0-9A-Za-z_:+.-]+$/

const value = (s: Scan, depth: number): Val => {
  if (depth > MAX_DEPTH) return bad(s, 'values nested too deep')
  const c = s.t[s.i]
  if (c === '"' || c === "'") {
    if (s.t.startsWith(c.repeat(3), s.i)) {
      multiline(s, c)
      return { v: undefined, plain: false }
    }
    return { v: c === '"' ? basicString(s) : literalString(s), plain: true }
  }
  if (c === '[') {
    s.i++
    const items: Val[] = []
    for (;;) {
      skip(s, true)
      if (s.t[s.i] === ']') {
        s.i++
        break
      }
      items.push(value(s, depth + 1))
      skip(s, true)
      if (s.t[s.i] === ',') s.i++
      else if (s.t[s.i] !== ']') return bad(s, 'a list that is not valid')
    }
    const plain = items.every(i => i.plain && typeof i.v === 'string')
    return {
      v: plain ? items.map(i => i.v as string) : undefined,
      plain,
      ...(items.some(i => i.table) && { tables: true as const }),
    }
  }
  if (c === '{') {
    s.i++
    const table: Record<string, string> = {}
    let plain = true
    skip(s, false)
    if (s.t[s.i] === '}') {
      s.i++
      return { v: table, plain, table: true }
    }
    for (;;) {
      skip(s, false)
      const path = keyPath(s)
      skip(s, false)
      if (s.t[s.i] !== '=') return bad(s, 'a table that is not valid')
      s.i++
      skip(s, false)
      const item = value(s, depth + 1)
      const [key] = path
      if (path.length !== 1 || !item.plain || typeof item.v !== 'string' || Object.hasOwn(table, key!)) plain = false
      else table[key!] = item.v
      skip(s, false)
      if (s.t[s.i] === ',') s.i++
      else if (s.t[s.i] === '}') {
        s.i++
        return { v: plain ? table : undefined, plain, table: true }
      } else return bad(s, 'a table that is not valid')
    }
  }
  let token = ''
  while (s.i < s.t.length && !',]} \t\r\n#'.includes(s.t[s.i]!)) token += s.t[s.i++]
  if (token === 'true' || token === 'false') return { v: token === 'true', plain: true }
  if (NUMBER_PLAIN.test(token)) {
    const n = Number(token.replaceAll('_', ''))
    return Number.isSafeInteger(n) ? { v: n, plain: true } : { v: undefined, plain: false }
  }
  if (FLOAT_PLAIN.test(token)) return { v: Number(token), plain: true }
  // A hex number, a float with an exponent, inf, nan, a date: valid TOML, which init does not read.
  if (TOKEN.test(token)) return { v: undefined, plain: false }
  return bad(s, 'a value that is not valid')
}

type Table = { name: string; fields: Record<string, unknown>; skip?: string }

/** The [mcp_servers.<name>] tables of the TOML text, or why init reads none. */
export const readCodexToml = (text: string): CodexToml => {
  if (text.length > TOML_MAX) return { ok: false, why: 'the file is larger than 1 MB' }
  const s: Scan = { t: text.startsWith('﻿') ? text.slice(1) : text, i: 0 }
  const servers = new Map<string, Table>()
  const headers = new Set<string>()
  let current: { server: Table; sub: string | undefined; ignore?: true } | 'root-of-servers' | 'other' = 'other'
  let rootKeys = new Set<string>()
  const refuse: (why: string) => never = why => {
    throw new Bad(lineOf(s), why)
  }
  try {
    for (;;) {
      skip(s, true)
      if (s.i >= s.t.length) break
      if (s.t[s.i] === '[') {
        const array = s.t[s.i + 1] === '['
        s.i += array ? 2 : 1
        skip(s, false)
        const path = keyPath(s)
        skip(s, false)
        if (s.t.slice(s.i, s.i + (array ? 2 : 1)) !== (array ? ']]' : ']')) bad(s, 'a table header that is not valid')
        s.i += array ? 2 : 1
        endOfLine(s)
        const id = JSON.stringify(path)
        if (headers.has(id) && !array) refuse('a table defined twice')
        headers.add(id)
        rootKeys = new Set()
        if (path[0] !== 'mcp_servers') current = 'other'
        else if (path.length === 1) {
          if (array) refuse('mcp_servers is written in a form that init cannot read')
          current = 'root-of-servers'
        } else {
          const name = path[1]!
          let server = servers.get(name)
          if (server === undefined) servers.set(name, (server = { name, fields: {} }))
          if (array && path.length === 2) server.skip = UNREADABLE_ENTRY
          const sub = path.length > 2 ? path[2] : undefined
          // [mcp_servers.<name>.tools.<tool>]: per-tool settings, left out by name and not read.
          const tool = sub === 'tools' && path.length === 4 && !array
          if (tool) server.fields.tools ??= {}
          else if (sub !== undefined) {
            if (array || path.length > 3 || Object.hasOwn(server.fields, sub)) server.skip = UNREADABLE_ENTRY
            else server.fields[sub] = {}
          }
          current = tool ? { server, sub, ignore: true } : { server, sub }
        }
        continue
      }
      const key = keyPath(s)
      skip(s, false)
      if (s.t[s.i] !== '=') bad(s, 'a key without a value')
      s.i++
      skip(s, false)
      const val = value(s, 0)
      endOfLine(s)
      if (current === 'other') {
        // The root table: mcp_servers can also be written as a key, or as an inline table, which init does not read.
        if (headers.size === 0 && key[0] === 'mcp_servers')
          refuse('mcp_servers is written in a form that init cannot read')
        continue
      }
      if (current === 'root-of-servers') refuse('mcp_servers is written in a form that init cannot read')
      const { server, sub, ignore } = current
      const id = JSON.stringify(key)
      if (rootKeys.has(id)) refuse('a key defined twice')
      rootKeys.add(id)
      if (ignore) continue
      if (key.length !== 1 || !val.plain) {
        server.skip = key.length === 1 && key[0] === 'env_vars' && val.tables ? ENV_VARS_TABLE : UNREADABLE_ENTRY
        continue
      }
      if (sub === undefined) {
        if (Object.hasOwn(server.fields, key[0]!)) server.skip = UNREADABLE_ENTRY
        else server.fields[key[0]!] = val.v
      } else {
        const table = server.fields[sub]
        if (typeof val.v === 'string' && typeof table === 'object' && table !== null)
          (table as Record<string, string>)[key[0]!] = val.v
        else server.skip = UNREADABLE_ENTRY
      }
    }
  } catch (err) {
    if (err instanceof Bad) return { ok: false, why: `${err.message} at line ${err.line}` }
    throw err
  }
  return {
    ok: true,
    servers: [...servers.values()].map(t =>
      t.skip === undefined ? { name: t.name, fields: t.fields } : { name: t.name, skip: t.skip },
    ),
  }
}
