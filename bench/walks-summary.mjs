// The summary of the walk-slots runs (issue #180): reads the outputs of bench/walks.mjs in a folder, one file for each pass,
// named `pass<n>-slots<s>.txt`, and prints one table with a row for each slot count and form. The seconds are the median
// of every run of every pass of that slot count. Cuts are calls that came back `truncated`.
//
//   node bench/walks-summary.mjs <folder>
import fs from 'node:fs'
import path from 'node:path'

const folder = process.argv[2]
if (folder === undefined) {
  console.error('usage: node bench/walks-summary.mjs <folder>')
  process.exit(2)
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length === 0 ? Number.NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// slots -> form -> { alone: [wall], eight: [wall], eightCut: n, allCut: n, passes: Set }
const data = new Map()
for (const name of fs.readdirSync(folder).sort()) {
  const m = /^pass(\d+)-slots(\d+)\.txt$/.exec(name)
  if (m === null) continue
  const [, pass, slots] = m
  const forms = data.get(slots) ?? new Map()
  data.set(slots, forms)
  let form
  for (const line of fs.readFileSync(path.join(folder, name), 'utf8').split('\n')) {
    if (line === 'no include' || line.startsWith('include ')) {
      form = line
      continue
    }
    const cells = line.split('|').map(c => c.trim())
    // | N | run | wall s | each call s (min/max) | cut | matches (min) | wall / (N x alone) |
    if (form === undefined || cells.length < 7 || !/^\d+$/.test(cells[1])) continue
    const n = Number(cells[1])
    const wall = Number(cells[3])
    const cut = Number(cells[5].split('/')[0])
    const row = forms.get(form) ?? { alone: [], eight: [], eightCut: 0, allCut: 0, passes: new Set() }
    forms.set(form, row)
    row.passes.add(pass)
    if (n === 1) row.alone.push(wall)
    if (n === 8) {
      row.eight.push(wall)
      row.eightCut += cut
    }
    row.allCut += cut
  }
}

const f1 = x => (Number.isNaN(x) ? '-' : x.toFixed(2))
console.log(
  '| slots | form | passes | runs of 8 | alone median s | batch of 8 median s | cut calls in batches of 8 | cut calls in all batches |',
)
console.log('| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const [slots, forms] of [...data].sort((a, b) => Number(a[0]) - Number(b[0])))
  for (const [form, r] of forms)
    console.log(
      `| ${slots} | ${form} | ${r.passes.size} | ${r.eight.length} | ${f1(median(r.alone))} | ${f1(median(r.eight))} | ${r.eightCut} | ${r.allCut} |`,
    )
