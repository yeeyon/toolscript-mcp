// Folds the files of changes/ into the section of a version in CHANGELOG.md. Node built-ins only.
//
//   node scripts/changelog.mjs 1.2.3            prints the section as it would be, changes nothing
//   node scripts/changelog.mjs 1.2.3 --apply    writes CHANGELOG.md, then deletes the folded files
//
// `--root <folder>` reads CHANGELOG.md and changes/ in that folder, for the tests. A refusal exits with 2, writes one
// line to stderr and changes nothing. The write is safe to stop: CHANGELOG.md is written to a temp file and renamed
// before any fragment is deleted. The marker CHANGELOG.md.folded (the names and the SHA-256 of the new text) lives from
// before the rename to after the last delete. A run that finds a marker that matches CHANGELOG.md only deletes the
// fragments it names; a marker that does not match (a stop before the rename) is removed and ignored. The script does not summarize: the person rewrites the section by hand.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** A dotfile or a backup of an editor (a name that ends with ~) is not a fragment, and is never an error. */
export const ignoredName = name => name.startsWith('.') || name.endsWith('~')
export const FRAGMENT_NAME = /^[a-z0-9][a-z0-9._-]*\.md$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const USAGE = 'usage: node scripts/changelog.mjs <N.N.N> [--apply] [--root <folder>]'

class Refusal extends Error {}
const refuse = text => {
  throw new Refusal(text)
}

/** The text of a fragment with LF line ends. */
export const lf = text => text.replaceAll('\r\n', '\n')

/**
 * The problems of the text of one fragment, as short phrases: empty, a line that is not an item or a continuation, a
 * blank line that is not between two items, no final newline. The text has LF line ends.
 */
export const fragmentProblems = text => {
  const problems = []
  if (text.trim() === '') return ['it is empty']
  if (!text.endsWith('\n')) problems.push('it does not end with a newline')
  const lines = text.replace(/\n+$/, '').split('\n')
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`
    if (line === '') {
      if (i === 0 || lines[i - 1] === '' || !(lines[i + 1] ?? '').startsWith('- '))
        problems.push(`${at}: a blank line must sit between two items`)
    } else if (line.startsWith('#')) problems.push(`${at}: no heading`)
    else if (/^- \S/.test(line)) return
    else if (/^ {2,}\S/.test(line)) {
      if (i === 0 || lines[i - 1] === '') problems.push(`${at}: a continuation line must follow an item`)
    } else problems.push(`${at}: a line must start with "- " or two spaces`)
  })
  return problems
}

const versionOf = text => text.split('.').map(Number)
const lower = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

/** The names of the files of changes/ to fold, in code point order, each checked. */
const readFragments = folder => {
  if (!fs.existsSync(folder)) return []
  const found = []
  for (const name of fs.readdirSync(folder).sort()) {
    if (name === 'README.md' || ignoredName(name)) continue
    const file = path.join(folder, name)
    if (!FRAGMENT_NAME.test(name)) refuse(`changes/${name}: the name must match [a-z0-9][a-z0-9._-]*.md`)
    if (!fs.lstatSync(file).isFile()) refuse(`changes/${name}: it is not a file`)
    const text = lf(fs.readFileSync(file, 'utf8'))
    const problems = fragmentProblems(text)
    if (problems.length > 0) refuse(`changes/${name}: ${problems[0]}`)
    found.push({ name, file, text })
  }
  return found
}

/** Where each `## ` section starts in the text: its offset, its title and the offset of its end. */
const sectionsOf = text => {
  const found = []
  for (const m of text.matchAll(/^## (.*?)[ \t\r]*$/gm)) found.push({ start: m.index, title: m[1], end: text.length })
  for (let i = 0; i + 1 < found.length; i++) found[i].end = found[i + 1].start
  return found
}

/**
 * The new text of CHANGELOG.md, the section of the version, the fragments that need a fold and those that a stopped
 * run folded already. Throws a Refusal.
 */
export const fold = (changelog, version, fragments) => {
  if (!SEMVER.test(version)) refuse(`${version}: the version must be N.N.N`)
  if (changelog.includes('\r')) refuse('CHANGELOG.md must have LF line ends')
  if (!/^# Changelog(\n|$)/.test(changelog)) refuse('CHANGELOG.md must start with the line "# Changelog"')
  if (fragments.length === 0) refuse('no file in changes/ to fold')
  const sections = sectionsOf(changelog)
  const first = sections[0]
  const own = sections.findIndex(s => s.title === version)
  if (own > 0) refuse(`the section ${version} exists below another section`)
  if (own < 0 && first !== undefined) {
    if (!SEMVER.test(first.title)) refuse(`the first section "${first.title}" is not a version`)
    if (lower(versionOf(version), versionOf(first.title)))
      refuse(`${version} is lower than the first section ${first.title}`)
  }
  const existing = own === 0 ? changelog.slice(first.start, first.end).split('\n') : []
  const added = fragments.flatMap(f =>
    f.text
      .replace(/\n+$/, '')
      .split('\n')
      .filter(l => l !== ''),
  )
  let text
  let section
  if (own === 0) {
    const body = existing.slice(1)
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    section = [existing[0], ...body, ...added].join('\n') + '\n'
    const rest = changelog.slice(first.end)
    text = changelog.slice(0, first.start) + section + (rest === '' ? '' : `\n${rest}`)
  } else {
    section = `## ${version}\n\n${added.join('\n')}\n`
    if (first === undefined) text = `${changelog.replace(/\n+$/, '')}\n\n${section}`
    else {
      const head = changelog.slice(0, first.start)
      text =
        (head.endsWith('\n\n') ? head : `${head.replace(/\n*$/, '')}\n\n`) +
        section +
        `\n${changelog.slice(first.start)}`
    }
  }
  return { text, section }
}

/** The section of a version as it stands in the text, or an empty text. */
const sectionOfVersion = (changelog, version) => {
  const s = sectionsOf(changelog).find(x => x.title === version)
  return s === undefined ? '' : `${changelog.slice(s.start, s.end).replace(/\n+$/, '')}\n`
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex')

/** The names that a stopped run folded, when its marker matches the CHANGELOG.md on disk; else an empty list. */
const readMarker = (marker, changelog) => {
  try {
    const m = JSON.parse(fs.readFileSync(marker, 'utf8'))
    if (m?.sha256 === sha256(changelog) && Array.isArray(m.names))
      return { names: m.names.map(String), exists: true, matches: true }
  } catch {}
  return { names: [], exists: fs.existsSync(marker), matches: false }
}

const main = argv => {
  let root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  let apply = false
  let version
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') apply = true
    else if (argv[i] === '--root' && argv[i + 1] !== undefined) root = path.resolve(argv[++i])
    else if (version === undefined && !argv[i].startsWith('-')) version = argv[i]
    else refuse(USAGE)
  }
  if (version === undefined) refuse(USAGE)
  const file = path.join(root, 'CHANGELOG.md')
  let changelog
  try {
    changelog = fs.readFileSync(file, 'utf8')
  } catch {
    refuse('CHANGELOG.md cannot be read')
  }
  const marker = `${file}.folded`
  const known = readMarker(marker, changelog)
  const all = readFragments(path.join(root, 'changes'))
  // The files that a stopped run folded: the marker matches the CHANGELOG.md on disk, so they are in it already.
  const done = all.filter(f => known.names.includes(f.name))
  const pending = all.filter(f => !known.names.includes(f.name))
  if (pending.length === 0 && done.length === 0 && known.matches && apply) fs.rmSync(marker, { force: true })
  let next
  if (pending.length > 0 || done.length === 0) next = fold(changelog, version, pending)
  else if (!SEMVER.test(version)) refuse(`${version}: the version must be N.N.N`)
  for (const f of done)
    process.stderr.write(
      `changelog: changes/${f.name} is folded already by a stopped run, ${apply ? 'removed' : 'left out of the fold'}\n`,
    )
  if (!apply) {
    if (pending.length > 0)
      process.stderr.write(`changelog: would fold ${pending.map(f => f.name).join(', ')} into ${version}\n`)
    return void process.stdout.write(next?.section ?? sectionOfVersion(changelog, version))
  }
  if (known.exists && !known.matches) fs.rmSync(marker, { force: true }) // a stop before the rename
  if (next !== undefined) {
    // The marker, the temp file and the rename come before any delete; the marker goes last.
    const temp = `${file}.tmp`
    try {
      fs.writeFileSync(marker, JSON.stringify({ names: pending.map(f => f.name), sha256: sha256(next.text) }))
      fs.writeFileSync(temp, next.text)
      fs.renameSync(temp, file)
    } catch (err) {
      fs.rmSync(temp, { force: true })
      fs.rmSync(marker, { force: true })
      throw err
    }
  }
  for (const f of [...pending, ...done]) fs.unlinkSync(f.file)
  fs.rmSync(marker, { force: true })
  process.stderr.write(`changelog: folded ${pending.map(f => f.name).join(', ')} into ${version}\n`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    if (!(err instanceof Refusal)) throw err
    process.stderr.write(`changelog: ${err.message}\n`)
    process.exitCode = 2
  }
}
