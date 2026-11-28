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

// The client and the server package each inline the same JSON schema validator (ajv with ajv-formats) through their own
// `_shims`, about 295 KB each. The two files and the helper files that they import are the same code: only the hash in a file name and the
// source map comment differ. The check below compares them all, so a new SDK release that changes one of them stops the build, and the
// plugin then sends the import of the server's copy to the client's, so the bundle holds one validator.
const SDK = path.join(ROOT, 'node_modules', '@modelcontextprotocol')
const providerOf = pkg => {
  const dir = path.join(SDK, pkg, 'dist')
  const files = fs.readdirSync(dir).filter(f => /^ajvProvider-[\w-]+\.mjs$/.test(f))
  assert.equal(files.length, 1, `@modelcontextprotocol/${pkg} has ${files.length} ajv provider files`)
  return path.join(dir, files[0])
}
/**
 * A provider file and every file that it imports with a relative specifier, as text without the source map line and without
 * the hash in the name of an imported file, keyed by the name without its hash. The hashes differ between the two packages.
 */
const closureOf = file => {
  const out = new Map()
  const visit = f => {
    const key = path.basename(f).replace(/-[\w-]{8}\.mjs$/, '.mjs')
    if (out.has(key)) return
    const text = fs.readFileSync(f, 'utf8')
    out.set(
      key,
      text
        .split('\n')
        .filter(line => !line.startsWith('//# sourceMappingURL='))
        .join('\n')
        .replace(/(from "\.\/[\w]+)-[\w-]{8}\.mjs"/g, '$1.mjs"'),
    )
    for (const m of text.matchAll(/^(?:import|export) [^;]*? from "(\.\/[^"]+)";$/gm))
      visit(path.join(path.dirname(f), m[1]))
  }
  visit(file)
  return out
}
const clientProvider = providerOf('client')
const serverProvider = providerOf('server')
const clientClosure = closureOf(clientProvider)
const serverClosure = closureOf(serverProvider)
assert.ok(clientClosure.size >= 3, 'the closure of the client validator lost its helper files')
assert.deepEqual(
  [...serverClosure.keys()].sort(),
  [...clientClosure.keys()].sort(),
  'the files behind the validator of the server package are no longer those of the client package',
)
for (const [name, text] of clientClosure)
  assert.equal(
    serverClosure.get(name),
    text,
    `${name} of the server package is no longer the code of the client package: one copy cannot serve both`,
  )
/** Sends the import of the server package's validator to the client package's. */
const oneValidator = {
  name: 'one-validator',
  setup(b) {
    b.onResolve({ filter: /^\.\/ajvProvider-[\w-]+\.mjs$/ }, args =>
      path.join(args.resolveDir, args.path) === serverProvider ? { path: clientProvider } : undefined,
    )
  },
}

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
      plugins: [oneValidator],
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
// The licence text of a package folder, as it must stand in dist/third-party-licenses.txt.
const licenceOf = (dir, name, version) => {
  const file = fs.readdirSync(path.join(ROOT, dir)).find(f => /^licen[cs]e/i.test(f))
  assert.ok(file, `${name} ${version} has no licence file to copy into dist/third-party-licenses.txt`)
  return fs.readFileSync(path.join(ROOT, dir, file), 'utf8').trim()
}
const notices = [...packages].sort().map(dir => {
  const { name, version, license } = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'))
  return `${name} ${version} (${license})

${licenceOf(dir, name, version)}
`
})

// The shipped bundle holds one SDK generation: no input of main.js is a file of the first SDK (`@modelcontextprotocol/sdk`).
const mainInputs = Object.keys(results[0].metafile.outputs['dist/host/main.js'].inputs)
const first = mainInputs.filter(input => input.includes('node_modules/@modelcontextprotocol/sdk/'))
assert.deepEqual(first, [], 'the bundle holds files of the first SDK')
// The after state of the one-validator fix: the plugin fired, and the only validator in the bundle is the client package's.
const providers = mainInputs.filter(input => /\/ajvProvider-[\w-]+\.mjs$/.test(input))
assert.deepEqual(
  providers.map(input => path.join(ROOT, input)),
  [clientProvider],
  'the bundle does not hold exactly one validator, the one of the client package',
)

// What the two SDK packages inline from other packages (their source maps name each one as .pnpm/<name>@<version>/). The
// packages are not in node_modules/ of the bundle, so the notice is built from the installed copy of the same package.
const inlined = new Map()
for (const input of mainInputs.filter(p => /node_modules\/@modelcontextprotocol\/[^/]+\/dist\/.*\.mjs$/.test(p))) {
  const map = path.join(ROOT, `${input}.map`)
  if (!fs.existsSync(map)) continue
  for (const source of JSON.parse(fs.readFileSync(map, 'utf8')).sources) {
    const m = /\.pnpm\/((?:@[^/@]+\+)?[^/@]+)@([^/_]+)[^/]*\//.exec(source)
    if (m) inlined.set(m[1].replace('+', '/'), m[2])
  }
}
for (const [name, version] of [...inlined].sort()) {
  const dir = `node_modules/${name}`
  assert.ok(
    fs.existsSync(path.join(ROOT, dir)),
    `the SDK inlines ${name} ${version}, which is not installed for its licence`,
  )
  const have = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'))
  notices.push(
    `${name} ${version} (${have.license}), inlined by the @modelcontextprotocol packages; the text is from the installed ${have.version}

${licenceOf(dir, name, version)}
`,
  )
}
fs.writeFileSync(
  path.join(DIST, 'third-party-licenses.txt'),
  `${BUNDLES.map(b => b.out).join(' and ')} hold these packages.\n\n${notices.join(`\n${'-'.repeat(78)}\n\n`)}`,
)
const sizes = BUNDLES.map(b => `${b.out} ${Math.round(fs.statSync(path.join(ROOT, b.out)).size / 1024)} KB`)
console.error(`built ${sizes.join(', ')} with ${packages.size} packages and ${inlined.size} inlined`)
