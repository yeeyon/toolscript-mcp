// Parallel Workspace walks (issue #160): N `search` calls started together on one tree, through the provider.
// No model, no spend. Run it only in a container with one CPU, never on the bare laptop:
//   docker run --rm --cpus 1 -v "$PWD:/app:ro" -w /app node:22-bookworm-slim \
//     node --experimental-strip-types bench/walks.mjs [--files 10000] [--runs 3] [--tree /tmp/walks-tree]
// The tree must be on the file system of the container. It is made once from a fixed seed, so a run repeats.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SKIP } from '../src/core/workspace.ts'
import { bindWorkspace } from '../src/host/workspace/bind.ts'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const FILES = Number(arg('files', 10_000))
const RUNS = Number(arg('runs', 3))
const TREE = arg('tree', '/tmp/walks-tree')
const FOLDERS = 800
const IGNORED = 30_000
const NEEDLES = 8
const SIZES = [1, 2, 4, 8]
const FORMS = [
  ['no include', []],
  ['include src/**/*.ts', ['src/**/*.ts']],
]

const seeded = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Half of the folders and files under `src/` (.ts), half under `docs/` (.txt), at most 6 levels, plus `vendor/`. */
const makeTree = () => {
  const rand = seeded(160)
  const words = Array.from({ length: 400 }, (_, i) => `w${i.toString(36)}${Math.floor(rand() * 1e4)}`)
  const folders = []
  for (const top of ['src', 'docs']) {
    const own = [{ dir: top, depth: 1 }]
    while (own.length < FOLDERS / 2) {
      const parent = own[Math.floor(rand() * own.length)]
      if (parent.depth < 6) own.push({ dir: `${parent.dir}/d${own.length}`, depth: parent.depth + 1 })
    }
    folders.push(...own.map(f => ({ ...f, ext: top === 'src' ? 'ts' : 'txt' })))
  }
  for (const f of folders) fs.mkdirSync(path.join(TREE, f.dir), { recursive: true })
  for (let i = 0; i < FILES; i++) {
    const f = folders[i % folders.length]
    const lines = []
    for (let size = 0, goal = 2048 + rand() * 8192; size < goal; ) {
      let line = Array.from({ length: 8 }, () => words[Math.floor(rand() * words.length)]).join(' ')
      if (rand() < 0.00005 * NEEDLES) line += ` needle-${Math.floor(rand() * NEEDLES)}`
      lines.push(line)
      size += line.length + 1
    }
    fs.writeFileSync(path.join(TREE, f.dir, `f${i}.${f.ext}`), lines.join('\n'))
  }
  fs.mkdirSync(path.join(TREE, 'vendor'))
  for (let i = 0; i < IGNORED; i++) fs.writeFileSync(path.join(TREE, 'vendor', `v${i}.js`), '')
  fs.writeFileSync(path.join(TREE, '.gitignore'), 'vendor/\n')
  fs.writeFileSync(path.join(TREE, '.made'), `${FILES}\n`)
}

const treeMade = () =>
  fs.existsSync(path.join(TREE, '.made')) && fs.readFileSync(path.join(TREE, '.made'), 'utf8') === `${FILES}\n`
if (!treeMade()) {
  fs.rmSync(TREE, { recursive: true, force: true })
  fs.mkdirSync(TREE, { recursive: true })
  makeTree()
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walks-home-'))
fs.writeFileSync(path.join(home, 'toolscript.json'), '{}')
const root = fs.realpathSync.native(TREE)
const binding = await bindWorkspace({
  workspace: { roots: [{ path: root, write: false }], exclude: [], skip: DEFAULT_SKIP },
  start: root,
  home,
  configFile: path.join(home, 'toolscript.json'),
  log: () => {},
})
if (!binding.ok) throw new Error(`Workspace unavailable: ${binding.reason}`)
const client = new Client({ name: 'walks-bench', version: '0' })
await client.connect(await binding.bound.provider.serve())

const failed = { seen: false }
/** N searches started together, each with its own query. */
const batch = async (n, include) => {
  const began = performance.now()
  const calls = await Promise.all(
    Array.from({ length: n }, async (_, k) => {
      const start = performance.now()
      // The client gives a call 60 s. A call that waits longer fails with a timeout, and it counts as a failed call.
      const r = await client
        .callTool({ name: 'search', arguments: { query: `needle-${k}`, include } })
        .catch(e => ({ isError: true, content: String(e?.message ?? e) }))
      if (r.isError === true) {
        // An error is counted as a cut call, and its text is printed once, so a limit that binds is named.
        if (!failed.seen) console.log(`call failed: ${JSON.stringify(r.content).slice(0, 300)}`)
        failed.seen = true
        return { s: (performance.now() - start) / 1000, truncated: true, matches: 0 }
      }
      const { truncated, matches } = r.structuredContent
      return { s: (performance.now() - start) / 1000, truncated, matches: matches.length }
    }),
  )
  return { wall: (performance.now() - began) / 1000, calls }
}

const f1 = x => x.toFixed(1)
console.log(
  `tree: ${FILES} files, ${FOLDERS} folders, ${IGNORED} ignored names, node ${process.version}, cpus ${os.cpus().length}`,
)
await batch(1, []) // warm the file cache once, not counted
const gate = {}
for (const [form, include] of FORMS) {
  console.log(`\n${form}\n| N | run | wall s | each call s (min/max) | cut | matches (min) | wall / (N x alone) |`)
  console.log('|---|---|---|---|---|---|---|')
  let alone = 0
  for (const n of SIZES) {
    for (let run = 1; run <= RUNS; run++) {
      const { wall, calls } = await batch(n, include)
      const cut = calls.filter(c => c.truncated).length
      const times = calls.map(c => c.s)
      if (n === 1) alone = (alone * (run - 1) + wall) / run
      const ratio = n === 1 ? '-' : (wall / (n * alone)).toFixed(2)
      const g = (gate[form] ??= { aloneCut: 0, eightCut: 0 })
      if (n === 1 && cut > 0) g.aloneCut++
      if (n === 8 && cut > 0) g.eightCut++
      console.log(
        `| ${n} | ${run} | ${f1(wall)} | ${f1(Math.min(...times))}/${f1(Math.max(...times))} | ${cut}/${n} | ${Math.min(...calls.map(c => c.matches))} | ${ratio} |`,
      )
    }
  }
}
for (const [form, g] of Object.entries(gate))
  console.log(
    `gate ${form}: batch of 8 cut in ${g.eightCut}/${RUNS} runs, alone cut in ${g.aloneCut}/${RUNS} runs -> ${g.eightCut >= 2 && g.aloneCut === 0 ? 'OPEN' : 'CLOSED'}`,
  )
await client.close()
fs.rmSync(home, { recursive: true, force: true })
