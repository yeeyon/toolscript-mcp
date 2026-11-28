// The reader of the files that skills are made from (issue #92). It reads the bundled hints of the package, and the
// hint files and saved-function files directly in the person's two folders under HOME, and nothing else: not the project
// hint folder, not `pending/`, not a learned, OAuth, broker or lock folder, not a file of a downstream server. Limits:
// regular files only (`lstat`: a link, a junction or a folder is skipped), 64 files a folder in name order, 65,536 bytes
// a file, valid UTF-8 only. A skipped file gives one line on stderr with its name and the reason, never its text.
// Nothing imports this file yet but its tests: the serving of skills comes after it.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BUNDLED_LIST, parseBundledList } from '../core/hints.ts'
import { functionsFolder, hintsFolder } from '../core/paths.ts'
import {
  SKILL_MAX_FILES,
  SKILL_MAX_FILE_BYTES,
  skillsOf,
  type Skill,
  type SkillFunctionFile,
  type SkillHintFile,
  type SkillTarget,
} from '../core/skills.ts'

export type SkillSources = {
  /** The home folder: its hint folder and function folder are read. */
  readonly home: string
  /** The `hints/` folder of the package, with its `sha256.json`. */
  readonly bundledDir: string
  /** One line for a skipped file. Default: stderr. */
  readonly log?: (line: string) => void
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// Without O_NOFOLLOW (Windows) the open follows a link, so `lstat` finds a link before the open, and the open file must be
// the same file (`dev` and `ino`): a file swapped for a link after the `lstat` is skipped. The type and the size are checked
// on the open file, the same file that is read, so a file that grew after a check is still held to the cap.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)

// At most SKILL_MAX_FILE_BYTES + 1 bytes from the open file, so a file that grew shows as too long and is never read whole.
const readCapped = (fd: number): Buffer => {
  const buffer = Buffer.alloc(SKILL_MAX_FILE_BYTES + 1)
  let length = 0
  while (length < buffer.length) {
    const n = fs.readSync(fd, buffer, length, buffer.length - length, length)
    if (n === 0) break
    length += n
  }
  return buffer.subarray(0, length)
}

// One file as text, or undefined with a line on the log. The text is what `readFileSync(file, 'utf8')` gives, so a hash of
// it is the hash of the bundled list.
const readText = (dir: string, name: string, log: (line: string) => void): string | undefined => {
  const skip = (reason: string): undefined => {
    log(`toolscript-mcp: skills: skipped ${JSON.stringify(name)}: ${reason}`)
    return undefined
  }
  const file = path.join(dir, name)
  let fd: number | undefined
  try {
    const before = fs.constants.O_NOFOLLOW === undefined ? fs.lstatSync(file, { bigint: true }) : undefined
    if (before !== undefined && !before.isFile()) return skip('not a regular file')
    fd = fs.openSync(file, OPEN_FLAGS)
    const stat = fs.fstatSync(fd, { bigint: true })
    if (!stat.isFile()) return skip('not a regular file')
    if (before !== undefined && (before.dev !== stat.dev || before.ino !== stat.ino)) return skip('not a regular file')
    if (stat.size > BigInt(SKILL_MAX_FILE_BYTES)) return skip(`more than ${SKILL_MAX_FILE_BYTES} bytes`)
    const bytes = readCapped(fd)
    if (bytes.length > SKILL_MAX_FILE_BYTES) return skip(`more than ${SKILL_MAX_FILE_BYTES} bytes`)
    return utf8.decode(bytes)
  } catch (error) {
    // O_NOFOLLOW makes the open of a link fail with ELOOP.
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return skip('not a regular file')
    return skip(error instanceof TypeError ? 'not valid UTF-8' : 'cannot be read')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** The `*.md` files directly in `dir` as (name, text), at most SKILL_MAX_FILES in name order. A missing folder has none. */
const readFolder = (dir: string, log: (line: string) => void): { file: string; text: string }[] => {
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.md'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`toolscript-mcp: skills: skipped the folder ${JSON.stringify(path.basename(dir))}: cannot be read`)
    }
    return []
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const name of names.slice(SKILL_MAX_FILES)) {
    log(`toolscript-mcp: skills: skipped ${JSON.stringify(name)}: more than ${SKILL_MAX_FILES} files in the folder`)
  }
  return names.slice(0, SKILL_MAX_FILES).flatMap(file => {
    const text = readText(dir, file, log)
    return text === undefined ? [] : [{ file, text }]
  })
}

/** The files that skills are made from: the bundled hints whose hash the list has, the person's hints, the person's functions. */
export const readSkillFiles = (sources: SkillSources): { hints: SkillHintFile[]; functions: SkillFunctionFile[] } => {
  const log = sources.log ?? ((line: string) => console.error(line))
  const listed = readText(sources.bundledDir, BUNDLED_LIST, log)
  const hashes = listed === undefined ? {} : parseBundledList(listed)
  const bundled = readFolder(sources.bundledDir, log).flatMap(({ file, text }): SkillHintFile[] => {
    const hash = Object.hasOwn(hashes, file) ? hashes[file] : undefined
    if (hash === undefined) {
      log(`toolscript-mcp: skills: skipped ${JSON.stringify(file)}: not in the list of bundled hints`)
      return []
    }
    if (createHash('sha256').update(text).digest('hex') !== hash) {
      log(`toolscript-mcp: skills: skipped ${JSON.stringify(file)}: its hash is not the one in the list`)
      return []
    }
    return [{ scope: 'bundled', file, text }]
  })
  const user = readFolder(hintsFolder(sources.home), log).map(
    ({ file, text }): SkillHintFile => ({ scope: 'user', file, text }),
  )
  return { hints: [...bundled, ...user], functions: readFolder(functionsFolder(sources.home), log) }
}

/** The skills for the servers of a config: the files read, then the pure mapping. */
export const loadSkills = (sources: SkillSources, targets: readonly SkillTarget[]): Skill[] =>
  skillsOf({ ...readSkillFiles(sources), targets })
