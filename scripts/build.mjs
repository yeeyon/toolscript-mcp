// Builds dist/: one file, dist/host/main.js, that holds the host code and the
// packages it imports, and dist/third-party-licenses.txt with their licences.
// One file starts fast: Node resolves, reads and compiles about 300 modules
// of the SDK otherwise. The package has no runtime dependency, so npx
// installs one package. `npm run build` checks the types first.
//
//   node scripts/build.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'dist')
const MAIN = 'dist/host/main.js'

fs.rmSync(DIST, { recursive: true, force: true })
const { metafile } = await build({
  absWorkingDir: ROOT,
  entryPoints: ['src/host/main.ts'],
  outfile: MAIN,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  metafile: true,
  logLevel: 'warning',
  // The CommonJS packages in the bundle call require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})

// The folder of each package in the bundle: the path up to its name after the last node_modules/.
const packages = new Set(
  Object.keys(metafile.outputs[MAIN].inputs).flatMap(input => {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)
    return m ? [m[1]] : []
  }),
)
const notices = [...packages].sort().map(dir => {
  const { name, version, license } = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'))
  const file = fs.readdirSync(path.join(ROOT, dir)).find(f => /^licen[cs]e/i.test(f))
  assert.ok(file, `${name} ${version} has no licence file to copy into dist/third-party-licenses.txt`)
  const text = fs.readFileSync(path.join(ROOT, dir, file), 'utf8').trim()
  return `${name} ${version} (${license})\n\n${text}\n`
})
fs.writeFileSync(
  path.join(DIST, 'third-party-licenses.txt'),
  `${MAIN} holds these packages.\n\n${notices.join(`\n${'-'.repeat(78)}\n\n`)}`,
)
console.error(`built ${MAIN} with ${packages.size} packages`)
