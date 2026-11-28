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
// version, so the hook and CI format alike. Only src/host/sdk/ names the MCP SDK, only the `sdk` package, and
// the broker and src/core never import that folder (see sdkProblems).
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

// The SDK seam (#154): only src/host/sdk/ holds the text @modelcontextprotocol/, and only of the `sdk` package.
// src/ and runtime/ are scanned as raw text, so no import form can hide: import(variable), createRequire(...)(), a string
// with // or /* before the import. A comment that names the package outside the folder fails too.
// tests/, bench/, demo/ and scripts/ are out of the check.
const SDK_DIR = 'src/host/sdk/'
const SDK_SOURCE = /\.(?:[cm]?[jt]s)$/
const MODULE = /\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`\n]*)\1/g
const NO_SDK_IMPORT = new Set(['src/host/broker.ts', 'src/host/brokermain.ts'])

const sourcesIn = (root, dir) =>
  fs.existsSync(path.join(root, dir))
    ? fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) return sourcesIn(root, rel)
        return entry.isFile() && SDK_SOURCE.test(entry.name) ? [rel] : []
      })
    : []

const PACKAGE = /@modelcontextprotocol\/([\w.-]*)/g
const lineOf = (text, index) => text.slice(0, index).split('\n').length

// The problems of the SDK seam in the tree under `root`, as "file:line: message".
const sdkProblems = root =>
  ['src', 'runtime'].flatMap(top =>
    sourcesIn(root, top).flatMap(rel => {
      const text = fs.readFileSync(path.join(root, rel), 'utf8')
      const named = [...text.matchAll(PACKAGE)].flatMap(m => {
        const at = `${rel}:${lineOf(text, m.index)}: `
        if (!rel.startsWith(SDK_DIR)) return [`${at}names ${m[0]} outside src/host/sdk/: use that folder`]
        return m[1] === 'sdk' ? [] : [`${at}names ${m[0]}: src/host/sdk/ names only the sdk package`]
      })
      const sealed = NO_SDK_IMPORT.has(rel) || rel.startsWith('src/core/')
      const loaded = [...text.matchAll(MODULE)].flatMap(m =>
        sealed && m[2].startsWith('.') && /(^|\/)sdk\//.test(m[2])
          ? [`${rel}:${lineOf(text, m.index)}: imports ${m[2]}: the broker and src/core never load the SDK folder`]
          : [],
      )
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
  'only src/host/sdk/ imports the SDK': () => {
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
        for (const rel of ['src/host/x.ts', 'src/host/workspace/y.ts', 'src/core/z.ts', 'runtime/r.mjs']) {
          put(rel, `${line}\n`)
          const found = sdkProblems(root)
          assert.equal(found.length, 1, `form ${i} in ${rel}: ${found.join('|')}`)
          assert.ok(found[0].startsWith(`${rel}:`), found[0])
          put(rel, "import { X } from './other.ts'\n")
          assert.deepEqual(sdkProblems(root), [], `form ${i} fixed in ${rel}`)
          drop(rel)
        }
      }
      // The folder itself may name the sdk package, and no other.
      put('src/host/sdk/client.ts', `import { X } from '${sdk}'\nexport type { Y } from '${sdk}'\n`)
      assert.deepEqual(sdkProblems(root), [], 'the sdk folder names the sdk package')
      for (const other of ['client', 'server', 'core']) {
        put('src/host/sdk/client.ts', `import { X } from '@modelcontextprotocol/${other}'\n`)
        assert.equal(sdkProblems(root).length, 1, `the folder names @modelcontextprotocol/${other}`)
      }
      put('src/host/sdk/client.ts', "import { X } from '@modelcontextprotocol/sdk/client/index.js'\n")
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
      // Out of the check: tests, bench, demo and scripts.
      for (const rel of ['tests/t.ts', 'bench/b.mjs', 'demo/d.mjs', 'scripts/s.mjs'])
        put(rel, `import { X } from '${sdk}'\n`)
      assert.deepEqual(sdkProblems(root), [])
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
