// The move check of the README split. It proves that the text moved from README.md into docs/ as it was.
//
//   node scripts/readme-move.mjs <base-ref>
//
// It reads README.md of <base-ref> (a git ref) and the README.md and docs/*.md of the working tree. Each non-blank line
// is normalised: a link target `](...)` becomes `]()`, and the `#` run of a heading becomes one `#`. It prints every base
// line that is in no new file, and every line of a new file that is in no base line. Not in the package.

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
const linesOf = text => text.split(/\r?\n/).filter(l => l.trim() !== '')

const base = linesOf(
  execFileSync('git', ['-C', ROOT, 'show', `${ref}:README.md`], { encoding: 'utf8', maxBuffer: 1 << 26 }),
)
const files = [
  'README.md',
  ...fs
    .readdirSync(path.join(ROOT, 'docs'))
    .filter(n => n.endsWith('.md'))
    .sort()
    .map(n => `docs/${n}`),
]

const baseSet = new Set(base.map(normal))
const newSet = new Set()
const added = []
for (const file of files) {
  for (const line of linesOf(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
    const n = normal(line)
    newSet.add(n)
    if (!baseSet.has(n)) added.push(`${file}: ${line}`)
  }
}
const lost = base.filter(line => !newSet.has(normal(line)))

console.log(`base lines not in any new file: ${lost.length}`)
for (const line of lost) console.log(`  - ${line}`)
console.log(`new lines not in the base: ${added.length}`)
for (const line of added) console.log(`  + ${line}`)
