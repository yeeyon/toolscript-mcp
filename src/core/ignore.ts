// The `.gitignore` of a Workspace root (issue #150): a parse of its text into rules, and a test of a path against them.
// `list` and `search` use it to leave out names. It is discovery only and never access control: no rule opens a path
// that an exclusion refuses, and `read`, `edit` and the other tools never call it. The matcher is its own code and
// builds no regular expression from the file, so a hostile file costs bounded time: a line has at most
// `LIMITS.ignoreWildcards` wildcards, the file at most `LIMITS.ignoreRules` rules.

import { LIMITS, fold } from './workspace.ts'

/** One character of a pattern part: a letter, `?`, `*`, or a class of ranges. */
type Token =
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'any' }
  | { readonly kind: 'star' }
  | { readonly kind: 'class'; readonly negate: boolean; readonly ranges: readonly (readonly [string, string])[] }

/** A part of a pattern: tokens, or `undefined` for a whole `**`. */
type Segment = readonly Token[] | undefined

export type IgnoreRule = {
  readonly negate: boolean
  readonly foldersOnly: boolean
  /** A `/` at the start or in the middle: the pattern matches the path from the root, not a name at any depth. */
  readonly anchored: boolean
  readonly segments: readonly Segment[]
}

export type IgnoreRules = readonly IgnoreRule[]

/** Compiles one part. Undefined when the part is no pattern that we take (a class that does not close, `[:`). */
const compilePart = (part: string, folded: boolean): Token[] | undefined => {
  const chars = Array.from(part)
  const tokens: Token[] = []
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!
    if (c === '*') {
      // Runs of `*` act as one.
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' })
    } else if (c === '?') tokens.push({ kind: 'any' })
    else if (c === '[') {
      let j = i + 1
      const negate = chars[j] === '!' || chars[j] === '^'
      if (negate) j++
      const members: string[] = []
      // A `]` that comes first is a member, as in git.
      for (let first = true; j < chars.length && (first || chars[j] !== ']'); j++, first = false)
        members.push(chars[j]!)
      if (j >= chars.length || members.join('').includes('[:')) return undefined
      const ranges: (readonly [string, string])[] = []
      for (let k = 0; k < members.length; k++) {
        const low = members[k]!
        if (members[k + 1] === '-' && k + 2 < members.length) {
          ranges.push([cased(low, folded), cased(members[k + 2]!, folded)])
          k += 2
        } else ranges.push([cased(low, folded), cased(low, folded)])
      }
      tokens.push({ kind: 'class', negate, ranges })
      i = j
    } else tokens.push({ kind: 'char', char: c })
  }
  return tokens
}

const cased = (text: string, folded: boolean): string => (folded ? fold(text) : text.normalize('NFC'))

/** `*` and `?` stay inside a part. Each other token takes one character, so the two-pointer match is exact. */
const partMatches = (tokens: readonly Token[], name: readonly string[]): boolean => {
  const one = (token: Token, c: string): boolean =>
    token.kind === 'char'
      ? token.char === c
      : token.kind === 'any'
        ? true
        : token.kind === 'class'
          ? token.ranges.some(([low, high]) => low <= c && c <= high) !== token.negate
          : false
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < name.length) {
    const token = tokens[p]
    if (token?.kind === 'star') {
      star = p++
      mark = t
    } else if (token !== undefined && one(token, name[t]!)) {
      p++
      t++
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else return false
  }
  while (tokens[p]?.kind === 'star') p++
  return p === tokens.length
}

/**
 * The rules of the text of a `.gitignore`. A line that is blank, a comment, or that we do not take is skipped whole,
 * with no error: another `\`, a `**` beside other characters, a class that does not close or holds `[:`, a line over
 * `LIMITS.ignoreLineChars` characters or with more than `LIMITS.ignoreWildcards` wildcards. At most
 * `LIMITS.ignoreRules` rules count. `folded`: names compare with no regard to case. Names always compare after NFC.
 */
export const parseIgnore = (text: string, folded: boolean): IgnoreRules => {
  const rules: IgnoreRule[] = []
  for (const line of text.split('\n')) {
    if (rules.length >= LIMITS.ignoreRules) break
    const rule = parseLine(line.endsWith('\r') ? line.slice(0, -1) : line, folded)
    if (rule !== undefined) rules.push(rule)
  }
  return rules
}

const parseLine = (raw: string, folded: boolean): IgnoreRule | undefined => {
  if (raw.length > LIMITS.ignoreLineChars || raw.includes('\0')) return undefined
  let line = raw.replace(/ +$/, '')
  if (line === '' || line.startsWith('#')) return undefined
  let negate = false
  if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1)
  else if (line.startsWith('!')) {
    negate = true
    line = line.slice(1)
  }
  if (line.includes('\\')) return undefined
  const foldersOnly = line.endsWith('/')
  if (foldersOnly) line = line.slice(0, -1)
  const anchored = line.includes('/')
  if (line.startsWith('/')) line = line.slice(1)
  if (line === '') return undefined
  const parts = line.split('/')
  if (parts.some(part => part === '' || (part.includes('**') && part !== '**'))) return undefined
  if ((line.match(/\*+|\?|\[/g) ?? []).length > LIMITS.ignoreWildcards) return undefined
  const segments: Segment[] = []
  for (const [i, part] of parts.entries()) {
    if (part === '**') {
      // `**` after another `**` adds nothing. `a/**` takes what is inside `a`, never `a` itself, so it ends with a part.
      if (segments.at(-1) !== undefined || segments.length === 0) segments.push(undefined)
      if (i === parts.length - 1) segments.push([{ kind: 'star' }])
      continue
    }
    const compiled = compilePart(cased(part, folded), folded)
    if (compiled === undefined) return undefined
    segments.push(compiled)
  }
  // A lone `**` is a name pattern that takes every name.
  if (!anchored && segments.length === 2 && segments[0] === undefined)
    return { negate, foldersOnly, anchored, segments: [segments[1]!] }
  return { negate, foldersOnly, anchored, segments }
}

/** The compare of a list of parts with segments: `**` takes zero or more parts. */
const pathMatches = (segments: readonly Segment[], names: readonly (readonly string[])[]): boolean => {
  // A length check first: the DP below is never run for a rule that cannot fit the number of names.
  const fixed = segments.filter(seg => seg !== undefined).length
  if (fixed > names.length || (fixed === segments.length && fixed !== names.length)) return false
  let below: boolean[] = Array.from({ length: names.length + 1 }, (_, j) => j === names.length)
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    const row: boolean[] = new Array(names.length + 1).fill(false)
    for (let j = names.length; j >= 0; j--)
      row[j] =
        seg === undefined
          ? below[j]! || (j < names.length && row[j + 1]!)
          : j < names.length && below[j + 1]! && partMatches(seg, names[j]!)
    below = row
  }
  return below[0]!
}

/** True when the rules ignore the path: the last rule that matches decides, and a `!` rule un-ignores. */
export const ignored = (rules: IgnoreRules, parts: readonly string[], isFolder: boolean, folded: boolean): boolean => {
  if (parts.length === 0 || rules.length === 0) return false
  const names = parts.map(part => Array.from(cased(part, folded)))
  let hidden = false
  for (const rule of rules) {
    if (rule.foldersOnly && !isFolder) continue
    const hit = rule.anchored
      ? pathMatches(rule.segments, names)
      : partMatches(rule.segments[0] as readonly Token[], names.at(-1)!)
    if (hit) hidden = !rule.negate
  }
  return hidden
}

/**
 * True when a call that starts at `start` applies the rules: a start that is ignored, or inside an ignored folder, applies
 * none, as `path` can name a folder of `skip`.
 */
export const startsClear = (rules: IgnoreRules, start: readonly string[], folded: boolean): boolean =>
  !start.some((_, k) => ignored(rules, start.slice(0, k + 1), true, folded))
