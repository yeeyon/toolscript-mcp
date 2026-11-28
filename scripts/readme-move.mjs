// The move check of the README split. It proves that the text moved from README.md into docs/ as it was.
//
//   node scripts/readme-move.mjs <base-ref>
//
// It reads README.md of <base-ref> (a git ref) and the README.md and docs/*.md of the working tree. Each non-blank line
// is normalised: a link target `](...)` becomes `]()`, and the `#` run of a heading becomes one `#`. The count of each
// line is compared (a multiset), so a dropped or an extra copy of a line shows. It prints:
//   - every base line that no new file holds (lost),
//   - every line of a new file that no base line backs, or that is one copy too many (new),
//   - every line of README.md that matches a base line, with its base line number, so a reviewer sees copied fragments,
//   - for each doc, each jump in the base line numbers of its lines: a doc must be contiguous runs of the base.
// Not in the package.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ref = process.argv[2]
if (!ref) {
  console.error('usage: node scripts/readme-move.mjs <base-ref>')
  process.exit(2)
}

const normal = line =>
  line
    .trimEnd()
    .replace(/\]\([^)]*\)/g, ']()')
    .replace(/^#+ /, '# ')
const linesOf = text =>
  text
    .split(/\r?\n/)
    .map((line, i) => ({ line, at: i + 1 }))
    .filter(l => l.line.trim() !== '')
const short = s => (s.length > 100 ? `${s.slice(0, 100)}...` : s)

const base = linesOf(
  execFileSync('git', ['-C', ROOT, 'show', `${ref}:README.md`], { encoding: 'utf8', maxBuffer: 1 << 26 }),
)
// The docs come first and README.md last, so a README line that copies a line that a doc already holds shows as one
// copy too many.
const files = [
  ...fs
    .readdirSync(path.join(ROOT, 'docs'))
    .filter(n => n.endsWith('.md'))
    .sort()
    .map(n => `docs/${n}`),
  'README.md',
]
// The place of a base line among the non-blank base lines, so that blank lines do not count as a jump.
const order = new Map(base.map((b, k) => [b.at, k]))

// Each normalised base line, with the base line numbers that are not used yet.
const free = new Map()
for (const b of base) {
  const n = normal(b.line)
  if (!free.has(n)) free.set(n, [])
  free.get(n).push(b.at)
}
const used = new Set()
const added = []
const copied = []
const jumps = []
for (const file of files) {
  let prev = 0
  let firstOfRun = true
  for (const { line, at } of linesOf(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
    const slots = free.get(normal(line)) ?? []
    if (slots.length === 0) {
      added.push(`${file}:${at}: ${line}`)
      continue
    }
    // The next unused base line after the previous one keeps a run together. Else the first unused one.
    const pick = slots.find(s => s > prev) ?? slots[0]
    slots.splice(slots.indexOf(pick), 1)
    used.add(pick)
    if (file === 'README.md') copied.push(`README.md:${at} = base ${pick}: ${short(line)}`)
    else if (!firstOfRun && order.get(pick) !== order.get(prev) + 1)
      jumps.push(`${file}:${at}: base ${prev} -> ${pick}`)
    firstOfRun = false
    prev = pick
  }
}
const lost = base.filter(b => !used.has(b.at))

console.log(`base lines not in any new file: ${lost.length}`)
for (const b of lost) console.log(`  - ${b.at}: ${b.line}`)
console.log(`new lines with no base line, or one copy too many: ${added.length}`)
for (const line of added) console.log(`  + ${line}`)
console.log(`README lines that match a base line: ${copied.length}`)
for (const line of copied) console.log(`  = ${line}`)
console.log(`jumps in the base line numbers of a doc: ${jumps.length}`)
for (const line of jumps) console.log(`  ~ ${line}`)
