// The code follows the rules in CODING_STANDARDS.md that no type and no test
// of the hooks can see.
//
// Checked here: the core reads the time only through $.clock, so a test can
// set it with mock.clock. Only src/core/paths.ts types out a path into
// .toolscript-mcp, so the loaders and the hint-file guard name the same
// folders. Only src/core/tools.ts types out the full id of a tool of this
// server. Only src/core/hints.ts types out the `bundled:` prefix of a hint
// ref. No file in src/host writes to stdout, which carries only MCP JSON-RPC.
// The .mjs tests are not scanned. Only scripts/format.sh names a Prettier
// version, so the hook and CI format alike. Only src/host/sdk/ and tests/sdk.* name the MCP SDK, only the `sdk` package,
// the broker and src/core never import that folder, and no shipped folder imports from tests/ (see sdkProblems).
//
//   node tests/code.check.mjs

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChecks } from './check.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const filesIn = (dir, pattern) =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter(f => pattern.test(f))
    .sort()
    .map(f => `${dir}/${f}`)
const FILES = [...filesIn('src/core', /\.ts$/), ...filesIn('src/host', /\.ts$/), ...filesIn('tests', /\.ts$/)]

const inHooks = rel => rel.startsWith('src/core/')

// Each rule and the files it applies to. Date.now(), Date() and new Date()
// read the time. new Date(ms) only formats it.
const RULES = [
  {
    pattern: /\bDate\.now\b|(?<!new\s+)\bDate\s*\(|\bnew Date\s*\(\s*\)/,
    message: 'reads the time without $.clock: use await $.clock.now()',
    applies: inHooks,
  },
  {
    pattern: /\.toolscript-mcp\\?\/|appPath\(.*['"`](hints|functions)['"`]/,
    message: 'types out a path into .toolscript-mcp: use a helper from src/core/paths.ts',
    applies: rel => inHooks(rel) && rel !== 'src/core/paths.ts',
  },
  {
    pattern: /mcp__toolscript__/,
    message: 'types out the id of a toolscript tool: use TOOL from src/core/tools.ts',
    applies: rel => rel !== 'src/core/tools.ts',
  },
  {
    // console.error, warn, trace and assert write to stderr. Every other
    // console method writes to stdout. In src/core, tsc already fails on
    // console and process (no Node types), and RUN_DESCRIPTION names the
    // sandbox's console.log.
    // writeSync(1, ...) is the same stream by file descriptor.
    pattern: /\bprocess\.stdout\b|\bwriteSync\(\s*1\b|\bconsole\.(?!(error|warn|trace|assert)\b)\w+/,
    message: 'writes to stdout, which carries only MCP JSON-RPC: log with console.error',
    applies: rel => rel.startsWith('src/host/'),
    stdout: true,
  },
  {
    pattern: /['"`]bundled:/,
    message: 'reads or makes a hint ref by hand: use hintRef, bundledRef or refTarget from src/core/hints.ts',
    applies: rel => inHooks(rel) && rel !== 'src/core/hints.ts',
  },
]

const STDOUT_OK = '// stdout-ok: --version'

// The problems of one file, as "file:line: message". Comments are skipped.
const codeProblems = (rel, text) => {
  const rules = RULES.filter(r => r.applies(rel))
  return text.split('\n').flatMap((raw, i) => {
    const code = raw.replace(/\/\*.*?\*\//g, '')
    const line = /^\s*\/?\*/.test(code) ? '' : code.replace(/(^|\s)\/\/.*$/, '')
    // The one exemption: the `--version` answer of src/host/main.ts, which exits before any MCP transport exists.
    // The marker skips the stdout rule on that line only.
    const exempt = rel === 'src/host/main.ts' && raw.includes(STDOUT_OK)
    return rules.filter(r => !(exempt && r.stdout) && r.pattern.test(line)).map(r => `${rel}:${i + 1}: ${r.message}`)
  })
}

// The SDK seam (#154): only src/host/sdk/ and the test helper tests/sdk.* hold the text @modelcontextprotocol/. The folder names
// the `client`, `core` and `server` packages of SDK v2 and never the first SDK (`sdk`); the helper names `sdk` and `client`. src/, runtime/, tests/, bench/, demo/, scripts/ and plugin/ are scanned as raw text, so no import
// form can hide: import(variable), createRequire(...)(), a string with // or /* before the import. A comment that names
// the package outside the two places fails too. The tests take the SDK through tests/sdk.mjs, which imports the package
// itself and never src/host/sdk/: the host is on SDK v2 since PR 7 while the test peers stay on v1 until PR 8.
// Named exceptions:
//  - this file: its patterns and self-test lines hold the text;
//  - a name `@modelcontextprotocol/server-<x>` outside src/ and runtime/: the reference MCP servers that a test names as
//    sample config data (`npx -y @modelcontextprotocol/server-filesystem`). No SDK package starts with `server-`.
// The package ships no test file: nothing in src/, runtime/ or demo/ imports from tests/.
const SDK_DIR = 'src/host/sdk/'
const TOPS = ['src', 'runtime', 'tests', 'bench', 'demo', 'scripts', 'plugin']
const SEAM_EXCEPTION = 'tests/code.check.mjs'
const isHelperV2 = rel => /^tests\/sdk\.[\w.]+$/.test(rel)
const isHelperV1 = rel => /^tests\/sdk-v1\.[\w.]+$/.test(rel)
const isHelper = rel => isHelperV2(rel) || isHelperV1(rel)
// The files that may import tests/sdk-v1.mjs, each for a v1 peer that stays (named in the comment of that file).
const V1_USERS = new Set([
  'tests/server.e2e.mjs',
  'tests/downstream.test.ts',
  'tests/v1-stdio-server.mjs',
  'tests/fake-oauth.ts',
  'tests/codec.test.ts',
  'tests/childenv-child.mjs',
])
// Build scripts that must name the SDK packages: one finds the SDK's files to bundle and to prove that none is the first SDK's.
const SCRIPT_EXCEPTIONS = new Set(['scripts/build.mjs', 'scripts/pack-check.mjs'])
const SHIPS_NO_TEST = ['src/', 'runtime/', 'demo/']
const SDK_SOURCE = /\.(?:[cm]?[jt]s)$/
const MODULE = /\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`\n]*)\1/g
const NO_SDK_IMPORT = new Set(['src/host/broker.ts', 'src/host/brokermain.ts'])

const sourcesIn = (root, dir) =>
  fs.existsSync(path.join(root, dir))
    ? fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourcesIn(root, rel)
        return entry.isFile() && SDK_SOURCE.test(entry.name) ? [rel] : []
      })
    : []

const PACKAGE = /@modelcontextprotocol\/([\w.-]*)(\/[\w-]+(?:[./][\w-]+)*)?/g
// The packages that each place may name. The first SDK (`sdk`) is gone from src/, runtime/ and demo/ since PR 7.
const FOLDER_PACKAGES = ['client', 'core', 'server']
// The exact specifiers that the folder imports: no other subpath (`server/ext/skills` waits for S2, `server/_shims` and
// `server/validators/*` are internals).
const FOLDER_SPECIFIERS = ['client', 'core', 'server', 'server/stdio']
const HELPER_PACKAGES = ['client', 'server']
const HELPER_V1_PACKAGES = ['sdk']
const lineOf = (text, index) => text.slice(0, index).split('\n').length

// The problems of the SDK seam in the tree under `root`, as "file:line: message".
const sdkProblems = root =>
  TOPS.flatMap(top =>
    sourcesIn(root, top).flatMap(rel => {
      if (rel === SEAM_EXCEPTION) return []
      const text = fs.readFileSync(path.join(root, rel), 'utf8')
      const sealedTop = rel.startsWith('src/') || rel.startsWith('runtime/')
      const named = [...(SCRIPT_EXCEPTIONS.has(rel) ? [] : text.matchAll(PACKAGE))].flatMap(m => {
        const at = `${rel}:${lineOf(text, m.index)}: `
        if (!sealedTop && /^server-/.test(m[1])) return []
        if (!rel.startsWith(SDK_DIR) && !isHelper(rel))
          return [`${at}names ${m[0]} outside src/host/sdk/ and tests/sdk.*: use src/host/sdk/ (tests: tests/sdk.mjs)`]
        // The folder also names core, whose schemas of the stored OAuth values the client package does not export.
        const places = rel.startsWith(SDK_DIR)
          ? FOLDER_PACKAGES
          : isHelperV1(rel)
            ? HELPER_V1_PACKAGES
            : HELPER_PACKAGES
        if (m[1] === 'sdk' && rel.startsWith(SDK_DIR))
          return [`${at}names ${m[0]}: the first SDK is gone from src/, use the server or client package`]
        if (rel.startsWith(SDK_DIR) && places.includes(m[1]) && !FOLDER_SPECIFIERS.includes(m[1] + (m[2] ?? '')))
          return [`${at}names ${m[0]}: the folder imports only ${FOLDER_SPECIFIERS.join(', ')}`]
        return places.includes(m[1])
          ? []
          : [`${at}names ${m[0]}: this place names only the ${places.join(', ')} packages`]
      })
      const sealed = NO_SDK_IMPORT.has(rel) || rel.startsWith('src/core/')
      const shipped = SHIPS_NO_TEST.some(p => rel.startsWith(p))
      const loaded = [...text.matchAll(MODULE)].flatMap(m => {
        const at = `${rel}:${lineOf(text, m.index)}: `
        if (sealed && m[2].startsWith('.') && /(^|\/)sdk\//.test(m[2]))
          return [`${at}imports ${m[2]}: the broker and src/core never load the SDK folder`]
        if (shipped && m[2].startsWith('.') && /(^|\/)tests\//.test(m[2]))
          return [`${at}imports ${m[2]}: the package ships no test file`]
        if (SCRIPT_EXCEPTIONS.has(rel) && m[2].startsWith('@modelcontextprotocol'))
          return [`${at}imports ${m[2]}: a build script names the SDK files as paths, it never imports the SDK`]
        if (m[2].startsWith('.') && /(^|\/)sdk-v1(\.mjs)?$/.test(m[2]) && !V1_USERS.has(rel) && !isHelper(rel))
          return [`${at}imports ${m[2]}: only the files in V1_USERS of tests/code.check.mjs take a v1 peer`]
        if (isHelper(rel) && m[2].startsWith('.') && /(^|\/)src\/host\/sdk(\/|$)/.test(m[2]))
          return [`${at}imports ${m[2]}: the test helper takes the SDK package, never the adapter`]
        return []
      })
      return [...named, ...loaded]
    }),
  )

// The line numbers in `code` (1-based) that `rel` reports.
const flagged = (rel, code) => codeProblems(rel, code.join('\n')).map(p => Number(p.split(':')[1]))

const tests = {
  'the clock rule': () => {
    const code = [
      'const a = Date.now()',
      'const b = new Date()',
      'const c = Date()',
      "const e = 'https://x' + Date.now()",
      '/* now */ const f = Date.now()',
      'const d = new  Date(await $.clock.now())',
      '// Date.now()',
      ' * Date.now()',
      '/** Date.now() */',
    ]
    assert.deepEqual(flagged('src/core/x.ts', code), [1, 2, 3, 4, 5])
    assert.deepEqual(flagged('tests/x.test.ts', code), [], 'tests may read the time')
  },
  'only src/core/paths.ts types out a .toolscript-mcp path': () => {
    const code = [
      'const d = `${home}/.toolscript-mcp/hints`',
      '/\\.toolscript-mcp\\/+(hints)/.test(c)',
      "appPath(await $.session.root(), 'hints')",
      '// ~/.toolscript-mcp/metrics',
      "appPath(home, 'metrics')",
      'const c = `${base}/toolscript-mcp/config.json`',
    ]
    assert.deepEqual(flagged('src/core/x.ts', code), [1, 2, 3])
    assert.deepEqual(flagged('src/core/paths.ts', code), [])
    assert.deepEqual(flagged('tests/x.test.ts', code), [], 'tests name the guarded folders')
  },
  'only src/core/tools.ts types out a tool id': () => {
    const code = [
      "const run = { tool: 'mcp__toolscript__run_code' }",
      'const t = `mcp__toolscript__${name}`',
      "const s = 'mcp__fake__echo'",
      '// mcp__toolscript__run_code',
    ]
    assert.deepEqual(flagged('src/core/x.ts', code), [1, 2])
    assert.deepEqual(flagged('tests/x.test.ts', code), [1, 2])
    assert.deepEqual(flagged('src/core/tools.ts', code), [])
  },
  'no file in src/host writes to stdout': () => {
    const code = [
      "console.log('connected')",
      "process.stdout.write('x')",
      'const { stdout } = process; console.info(stdout)',
      'console.table(rows)',
      "console.error('toolscript-mcp: connected')",
      'console.warn(w); console.trace(t); console.assert(ok)',
      "// console.log('debug')",
    ]
    assert.deepEqual(flagged('src/host/x.ts', code), [1, 2, 3, 4])
    const sync = ['fs.writeSync(1, v) // stdout-ok: --version', 'fs.writeSync(2, v)', 'fs.writeSync( 1, v)']
    assert.deepEqual(
      flagged('src/host/main.ts', sync),
      [3],
      'the marker exempts only main.ts, and only fd 1 is flagged',
    )
    assert.deepEqual(flagged('src/host/x.ts', sync), [1, 3], 'the marker exempts no other file')
    assert.deepEqual(
      flagged('src/host/main.ts', ["fs.writeSync(1, 'mcp__toolscript__run_code') // stdout-ok: --version"]),
      [1],
      'the marker skips only the stdout rule: the tool id rule still fires',
    )
    const main = fs.readFileSync(path.join(ROOT, 'src/host/main.ts'), 'utf8')
    assert.equal(main.split(STDOUT_OK).length - 1, 1, 'main.ts holds exactly one marker')
    assert.deepEqual(flagged('src/core/x.ts', code), [], 'tsc rejects console and process in src/core')
    assert.deepEqual(flagged('tests/x.test.ts', code), [], 'tests print their results')
  },
  'only src/core/hints.ts types out a bundled hint ref': () => {
    const code = [
      "if (ref.startsWith('bundled:')) {",
      'const r = `bundled:${file}`',
      "if (hint.scope === 'bundled') {",
      '// bundled:<name>',
    ]
    assert.deepEqual(flagged('src/core/x.ts', code), [1, 2])
    assert.deepEqual(flagged('src/core/hints.ts', code), [])
    assert.deepEqual(flagged('tests/x.test.ts', code), [], 'tests check the refs')
  },
  'only scripts/format.sh names a Prettier version': () => {
    // New files too, so the check works before git add.
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(rel => rel && fs.statSync(path.join(ROOT, rel), { throwIfNoEntry: false })?.isFile())
    const pinned = files.filter(rel => /prettier@\d/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    assert.deepEqual(pinned, ['scripts/format.sh'], 'call Prettier through scripts/format.sh')
  },
  'only src/host/sdk/ and tests/sdk.* import the SDK': () => {
    const problems = sdkProblems(ROOT)
    assert.deepEqual(problems, [], `${problems.join('\n')}\n\nThe rule is in CODING_STANDARDS.md, "SDK seam".`)
  },
  'the SDK seam check catches each form, and each fix passes': () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-check-'))
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), text)
    }
    const drop = rel => fs.rmSync(path.join(root, rel))
    const sdk = '@modelcontextprotocol/sdk/types.js'
    try {
      const outside = [
        `import { X } from '${sdk}'`,
        `import type { X } from '${sdk}'`,
        `export { X } from '${sdk}'`,
        `export type { X } from '${sdk}'`,
        `const m = await import('${sdk}')`,
        `const m = await import(\n  '${sdk}',\n)`,
        `const m = require('${sdk}')`,
        `import '${sdk}'`,
        `import {\n  X,\n} from '${sdk}'`,
        `import { X } from '@modelcontextprotocol/client'`,
        `const p = '${sdk}'; const m = await import(p)`,
        `const r = createRequire(import.meta.url)('${sdk}')`,
        `const u = 'http://x'; const m = await import('${sdk}')`,
        `const g = 'src/*'; const m = await import('${sdk}') /* end */`,
        `const g = 'src/*'\nimport { X } from '${sdk}'\n/* end */`,
      ]
      for (const [i, line] of outside.entries()) {
        for (const rel of [
          'src/host/x.ts',
          'src/host/workspace/y.ts',
          'src/core/z.ts',
          'runtime/r.mjs',
          'tests/t.ts',
          'tests/e2e.mjs',
          'bench/b.mjs',
          'demo/d.mjs',
          'scripts/s.mjs',
          'plugin/p.mjs',
        ]) {
          put(rel, `${line}\n`)
          const found = sdkProblems(root)
          assert.equal(found.length, 1, `form ${i} in ${rel}: ${found.join('|')}`)
          assert.ok(found[0].startsWith(`${rel}:`), found[0])
          put(rel, "import { X } from './other.ts'\n")
          assert.deepEqual(sdkProblems(root), [], `form ${i} fixed in ${rel}`)
          drop(rel)
        }
      }
      // The folder itself may name the client, core and server packages, and no other.
      put('src/host/sdk/client.ts', "import { X } from '@modelcontextprotocol/client'\n")
      assert.deepEqual(sdkProblems(root), [], 'the sdk folder names the client package')
      for (const bad of [
        '@modelcontextprotocol/server/ext/skills',
        '@modelcontextprotocol/server/ext/skills/node',
        '@modelcontextprotocol/server/_shims',
        '@modelcontextprotocol/server/validators/cf-worker',
        '@modelcontextprotocol/client/stdio',
      ]) {
        put('src/host/sdk/client.ts', `import { X } from '${bad}'\n`)
        assert.equal(sdkProblems(root).length, 1, `the folder refuses ${bad}`)
      }
      put('src/host/sdk/client.ts', "import { X } from '@modelcontextprotocol/server/stdio'\n")
      assert.deepEqual(sdkProblems(root), [], 'the folder takes server/stdio')
      put('src/host/sdk/client.ts', "import { X } from '@modelcontextprotocol/core'\n")
      assert.deepEqual(sdkProblems(root), [], 'the sdk folder names the core package')
      put(
        'src/host/sdk/client.ts',
        "import { X } from '@modelcontextprotocol/server'\nimport { Y } from '@modelcontextprotocol/server/stdio'\n",
      )
      assert.deepEqual(sdkProblems(root), [], 'the sdk folder names the server package')
      put('src/host/sdk/client.ts', "import { X } from '@modelcontextprotocol/server-extra'\n")
      assert.equal(sdkProblems(root).length, 1, 'the folder names no other server-* package')
      // The first SDK is gone from src/, in the folder too: one row for each path that it was used for.
      for (const sub of [
        'client/index.js',
        'client/streamableHttp.js',
        'shared/auth.js',
        'shared/transport.js',
        'server/auth/errors.js',
        'server/index.js',
        'server/mcp.js',
        'server/stdio.js',
        'types.js',
      ]) {
        put('src/host/sdk/client.ts', `import { X } from '@modelcontextprotocol/sdk/${sub}'\n`)
        assert.equal(sdkProblems(root).length, 1, `src names sdk/${sub}`)
        for (const other of ['src/host/x.ts', 'runtime/r.mjs', 'demo/d.mjs']) {
          put(other, `import { X } from '@modelcontextprotocol/sdk/${sub}'\n`)
          // The folder file and the other file each name the path.
          assert.equal(sdkProblems(root).length, 2, `${other} names sdk/${sub}`)
          drop(other)
        }
      }
      put('src/host/sdk/client.ts', "import { X } from '@modelcontextprotocol/server'\n")
      assert.deepEqual(sdkProblems(root), [], 'the fix passes')
      // The broker and src/core never load the folder.
      for (const rel of ['src/host/broker.ts', 'src/host/brokermain.ts', 'src/core/a.ts', 'src/core/sub/b.ts']) {
        for (const bad of ["'./sdk/client.ts'", "'../host/sdk/client.ts'", "'../../host/sdk/errors.ts'"]) {
          put(rel, `import { X } from ${bad}\n`)
          assert.equal(sdkProblems(root).length, 1, `${rel} imports ${bad}`)
        }
        put(rel, "import { X } from './other.ts'\n")
        assert.deepEqual(sdkProblems(root), [], `${rel} with a fixed line`)
        drop(rel)
      }
      // Another host file may use the folder.
      put('src/host/downstream.ts', "import { X } from './sdk/client.ts'\n")
      assert.deepEqual(sdkProblems(root), [])
      // The v2 helper names the client and server packages, and no other. Its own folder-relative imports are fine, the adapter is not.
      put(
        'tests/sdk.mjs',
        "export { X } from '@modelcontextprotocol/client'\nexport { Y } from '@modelcontextprotocol/server'\n",
      )
      put('tests/sdk.d.mts', "export { X } from '@modelcontextprotocol/client/stdio'\n")
      assert.deepEqual(sdkProblems(root), [], 'the test helper names the client and server packages')
      for (const bad of ["'../src/host/sdk/client.ts'", "'../src/host/sdk'"]) {
        put('tests/sdk.mjs', `export { X } from ${bad}\n`)
        assert.equal(sdkProblems(root).length, 1, `the test helper imports ${bad}`)
      }
      for (const other of ['sdk', 'core']) {
        put('tests/sdk.mjs', `export { X } from '@modelcontextprotocol/${other}'\n`)
        assert.equal(sdkProblems(root).length, 1, `tests/sdk.mjs names no @modelcontextprotocol/${other}`)
      }
      drop('tests/sdk.mjs')
      drop('tests/sdk.d.mts')
      // The v1 helper is the one place that names the first SDK, and no other package.
      put('tests/sdk-v1.mjs', `export { X } from '${sdk}'\n`)
      assert.deepEqual(sdkProblems(root), [], 'tests/sdk-v1.mjs names the sdk package')
      for (const other of ['client', 'server', 'core']) {
        put('tests/sdk-v1.mjs', `export { X } from '@modelcontextprotocol/${other}'\n`)
        assert.equal(sdkProblems(root).length, 1, `tests/sdk-v1.mjs names no @modelcontextprotocol/${other}`)
      }
      put('tests/sdk-v1.mjs', `export { X } from '${sdk}'\n`)
      // Only the files in V1_USERS import it.
      for (const rel of [
        'tests/server.e2e.mjs',
        'tests/downstream.test.ts',
        'tests/fake-oauth.ts',
        'tests/codec.test.ts',
        'tests/v1-stdio-server.mjs',
        'tests/childenv-child.mjs',
      ]) {
        put(rel, "import { X } from './sdk-v1.mjs'\n")
        assert.deepEqual(sdkProblems(root), [], `${rel} takes a v1 peer`)
        drop(rel)
      }
      for (const rel of ['tests/run.test.ts', 'tests/other.e2e.mjs', 'bench/b.mjs']) {
        put(rel, "import { X } from './sdk-v1.mjs'\n")
        assert.equal(sdkProblems(root).length, 1, `${rel} takes no v1 peer`)
        drop(rel)
      }
      drop('tests/sdk-v1.mjs')
      // The two build scripts name the packages to find and to check the SDK files; no other script does.
      for (const rel of ['scripts/build.mjs', 'scripts/pack-check.mjs']) {
        put(rel, `const a = '${sdk}'\n`)
        assert.deepEqual(sdkProblems(root), [], `${rel} names the package`)
        // A name in a path string is fine; an import of any package of the SDK is not.
        for (const spec of [sdk, '@modelcontextprotocol/client', '@modelcontextprotocol/server/stdio']) {
          for (const line of [
            `import { X } from '${spec}'`,
            `const m = await import('${spec}')`,
            `const m = require('${spec}')`,
          ]) {
            put(rel, `${line}\n`)
            assert.equal(sdkProblems(root).length, 1, `${rel} imports ${spec}: ${line}`)
          }
        }
        drop(rel)
      }
      // The one named file, and the reference servers that a test names as sample data.
      put('tests/code.check.mjs', `const a = '${sdk}'; const b = '@modelcontextprotocol/client'\n`)
      assert.deepEqual(sdkProblems(root), [], 'the check file names the package')
      drop('tests/code.check.mjs')
      put('tests/other.check.mjs', `const a = '${sdk}'\n`)
      assert.equal(sdkProblems(root).length, 1, 'no other check file is an exception')
      drop('tests/other.check.mjs')
      for (const rel of ['tests/share.test.ts', 'bench/b.mjs', 'scripts/s.mjs', 'plugin/p.mjs']) {
        put(rel, "const c = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] }\n")
        assert.deepEqual(sdkProblems(root), [], `${rel} names a reference server`)
        drop(rel)
      }
      for (const rel of ['src/host/x.ts', 'runtime/r.mjs']) {
        put(rel, "const c = '@modelcontextprotocol/server-filesystem'\n")
        assert.equal(sdkProblems(root).length, 1, `${rel} names a reference server`)
        drop(rel)
      }
      put('tests/t.ts', "const c = '@modelcontextprotocol/server'\n")
      assert.equal(sdkProblems(root).length, 1, 'a v2 package name is not a reference server')
      drop('tests/t.ts')
      // The package ships no test file: src/, runtime/ and demo/ never import from tests/.
      for (const rel of ['src/host/x.ts', 'src/core/y.ts', 'runtime/r.mjs', 'demo/d.mjs']) {
        for (const bad of ["'../tests/rig.ts'", "'../../tests/sdk.mjs'", "'./tests/a.mjs'"]) {
          put(rel, `import { X } from ${bad}\n`)
          assert.equal(sdkProblems(root).length, 1, `${rel} imports ${bad}`)
        }
        put(rel, "import { X } from './testsuite.ts'\n")
        assert.deepEqual(sdkProblems(root), [], `${rel} with a name that only starts with tests`)
        drop(rel)
      }
      // Other folders may import from tests/ (bench takes the helper).
      for (const rel of ['bench/b.mjs', 'tests/t.ts', 'scripts/s.mjs']) {
        put(rel, "import { X } from '../tests/sdk.mjs'\n")
        assert.deepEqual(sdkProblems(root), [], `${rel} imports tests/`)
        drop(rel)
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
  'the hooks and tests follow the rules': () => {
    const problems = FILES.flatMap(rel => codeProblems(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    assert.deepEqual(problems, [], `${problems.join('\n')}\n\nThe rules are in CODING_STANDARDS.md.`)
  },
}

runChecks(tests)
