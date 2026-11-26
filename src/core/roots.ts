// MCP client roots for the built-in Workspace (issue #150): the text of a `file:` URI as a path, and the root that a
// session uses when its client names roots. Client roots only narrow: the effective root is the bound root or a folder
// inside it. Nothing here touches files, so the host proves each client root with `realpath` before it calls `narrowRoot`.

import { fold, foldsCase, isInside, realParts } from './workspace.ts'

/** The longest path text that `fileUriPath` gives. */
const URI_PATH_CHARS = 4096

const DRIVE = /^[A-Za-z]:$/

/** True for a character that no folder name of a root holds: a control character. */
const hasControl = (text: string): boolean => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)

/**
 * The path that a `file:` URI names, or undefined. The scheme can be in any case, and the host empty or `localhost`.
 * Each part is decoded one time, as UTF-8. A query, a fragment, another host, a part that is empty, `.` or `..` after
 * decoding, a decoded `/`, NUL or control character, and a path over 4096 characters give undefined. On Windows the
 * first part must be a drive and the result uses `\`. On other systems `\` is a letter. Never throws.
 */
export const fileUriPath = (uri: unknown, platform: string): string | undefined => {
  if (typeof uri !== 'string' || uri.length > URI_PATH_CHARS * 3 + 64) return undefined
  if (!/^file:/i.test(uri) || /[?#]/.test(uri)) return undefined
  let rest = uri.slice('file:'.length)
  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2)
    const host = (slash < 0 ? rest.slice(2) : rest.slice(2, slash)).toLowerCase()
    if (host !== '' && host !== 'localhost') return undefined
    rest = slash < 0 ? '' : rest.slice(slash)
  }
  // `file:////server/share` and `//?/` forms keep a second `/` here: they name a network path, never a folder.
  if (!rest.startsWith('/') || rest.startsWith('//')) return undefined
  const raw = rest.slice(1).split('/')
  if (raw.length > 1 && raw.at(-1) === '') raw.pop()
  const windows = platform === 'win32'
  const parts: string[] = []
  for (const piece of raw) {
    if (piece === '' && raw.length === 1) break
    let part: string
    try {
      part = decodeURIComponent(piece)
    } catch {
      return undefined
    }
    if (part === '' || part === '.' || part === '..' || part.includes('/') || hasControl(part)) return undefined
    if (windows && part.includes('\\')) return undefined
    parts.push(part)
  }
  let text: string
  if (windows) {
    if (parts.length === 0 || !DRIVE.test(parts[0]!)) return undefined
    text = parts.length === 1 ? `${parts[0]}\\` : parts.join('\\')
  } else text = `/${parts.join('/')}`
  return text.length > URI_PATH_CHARS ? undefined : text
}

/**
 * The root a session uses. `bound` and each entry of `clientRoots` are real paths. A client root is usable when it is
 * inside the bound root, equal to it, or holds it (and then counts as the bound root). The result is the deepest folder
 * that holds every usable client root, so it is the bound root or inside it, whatever the order of the list. With no
 * usable root it is the bound root.
 */
export const narrowRoot = (
  bound: string,
  clientRoots: readonly string[],
  platform: string,
  folds = foldsCase(platform),
): string => {
  const same = (a: string, b: string) => (folds ? fold(a) === fold(b) : a === b)
  const usable = clientRoots.filter(
    root => isInside(root, bound, platform, folds) || isInside(bound, root, platform, folds),
  )
  if (usable.length === 0) return bound
  const lists = usable.map(root =>
    isInside(bound, root, platform, folds) ? realParts(bound, platform) : realParts(root, platform),
  )
  const first = lists[0]!
  let common = first.length
  for (const list of lists)
    for (let i = 0; i < common; i++)
      if (i >= list.length || !same(list[i]!, first[i]!)) {
        common = i
        break
      }
  if (common <= realParts(bound, platform).length) return bound
  const kept = first.slice(0, common)
  return platform === 'win32' ? kept.join('\\') : `/${kept.join('/')}`
}
