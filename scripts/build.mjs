// Builds dist/: two files, dist/host/main.js, that holds the host code and the
// packages it imports, and dist/host/broker.js, the broker of the shared
// servers (issue #63), which holds Node built-ins and cross-spawn only. And
// dist/third-party-licenses.txt with the licences of both. One file starts
// fast: Node resolves, reads and compiles about 300 modules of the SDK
// otherwise. The package has no runtime dependency, so npx installs one
// package. `npm run build` checks the types first.
//
//   node scripts/build.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'dist')
const BUNDLES = [
  { entry: 'src/host/main.ts', out: 'dist/host/main.js' },
  { entry: 'src/host/brokermain.ts', out: 'dist/host/broker.js' },
]

fs.rmSync(DIST, { recursive: true, force: true })
const results = await Promise.all(
  BUNDLES.map(({ entry, out }) =>
    build({
      absWorkingDir: ROOT,
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22.13',
      metafile: true,
      logLevel: 'warning',
      // The CommonJS packages in the bundle call require() for Node built-ins.
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    }),
  ),
)

// The folder of each package in the bundles: the path up to its name after the last node_modules/.
const packages = new Set(
  results.flatMap(({ metafile }, i) =>
    Object.keys(metafile.outputs[BUNDLES[i].out].inputs).flatMap(input => {
      const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)
      return m ? [m[1]] : []
    }),
  ),
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
  `${BUNDLES.map(b => b.out).join(' and ')} hold these packages.\n\n${notices.join(`\n${'-'.repeat(78)}\n\n`)}`,
)
const sizes = BUNDLES.map(b => `${b.out} ${Math.round(fs.statSync(path.join(ROOT, b.out)).size / 1024)} KB`)
console.error(`built ${sizes.join(', ')} with ${packages.size} packages`)
