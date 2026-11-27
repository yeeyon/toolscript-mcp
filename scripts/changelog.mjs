// Folds the files of changes/ into the section of a version in CHANGELOG.md. Node built-ins only.
//
//   node scripts/changelog.mjs 1.2.3            prints the section as it would be, changes nothing
//   node scripts/changelog.mjs 1.2.3 --apply    writes CHANGELOG.md, then deletes the folded files
//
// `--root <folder>` reads CHANGELOG.md and changes/ in that folder, for the tests. A refusal exits with 2, writes one
// line to stderr and changes nothing. The write is safe to stop: CHANGELOG.md is written to a temp file and renamed
// before any fragment is deleted, and a fragment whose lines are all in the section already is not folded again, so a
// second run after a stop only deletes it. The script does not summarize: the person rewrites the section by hand.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
    if (name === 'README.md') continue
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
  if (!/^# Changelog(\r?\n|$)/.test(changelog)) refuse('CHANGELOG.md must start with the line "# Changelog"')
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
  const seen = new Set(existing)
  const pending = []
  const done = []
  for (const f of fragments) {
    const lines = f.text
      .replace(/\n+$/, '')
      .split('\n')
      .filter(l => l !== '')
    if (own === 0 && lines.every(l => seen.has(l))) done.push(f)
    else pending.push({ ...f, lines })
  }
  const added = pending.flatMap(f => f.lines)
  if (added.length === 0) return { text: changelog, section: sectionText(existing), pending, done }
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
  return { text, section, pending, done }
}

const sectionText = lines => {
  const body = [...lines]
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  return `${body.join('\n')}\n`
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
  const folder = path.join(root, 'changes')
  const { text, section, pending, done } = fold(changelog, version, readFragments(folder))
  if (!apply) return void process.stdout.write(section)
  if (pending.length > 0) {
    // The temp file and the rename come before any delete.
    const temp = `${file}.tmp`
    try {
      fs.writeFileSync(temp, text)
      fs.renameSync(temp, file)
    } catch (err) {
      fs.rmSync(temp, { force: true })
      throw err
    }
  }
  for (const f of [...pending, ...done]) fs.unlinkSync(f.file)
  process.stderr.write(
    `changelog: folded ${pending.length} files into ${version}, removed ${done.length} that were folded already\n`,
  )
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
