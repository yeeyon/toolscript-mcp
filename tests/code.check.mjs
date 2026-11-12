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
// version, so the hook and CI format alike.
//
//   node tests/code.check.mjs

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
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
    pattern: /\bprocess\.stdout\b|\bconsole\.(?!(error|warn|trace|assert)\b)\w+/,
    message: 'writes to stdout, which carries only MCP JSON-RPC: log with console.error',
    applies: rel => rel.startsWith('src/host/'),
  },
  {
    pattern: /['"`]bundled:/,
    message: 'reads or makes a hint ref by hand: use hintRef, bundledRef or refTarget from src/core/hints.ts',
    applies: rel => inHooks(rel) && rel !== 'src/core/hints.ts',
  },
]

// The problems of one file, as "file:line: message". Comments are skipped.
const codeProblems = (rel, text) => {
  const rules = RULES.filter(r => r.applies(rel))
  return text.split('\n').flatMap((raw, i) => {
    const code = raw.replace(/\/\*.*?\*\//g, '')
    const line = /^\s*\/?\*/.test(code) ? '' : code.replace(/(^|\s)\/\/.*$/, '')
    return rules.filter(r => r.pattern.test(line)).map(r => `${rel}:${i + 1}: ${r.message}`)
  })
}

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
      .filter(rel => rel && fs.existsSync(path.join(ROOT, rel)))
    const pinned = files.filter(rel => /prettier@\d/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    assert.deepEqual(pinned, ['scripts/format.sh'], 'call Prettier through scripts/format.sh')
  },
  'the hooks and tests follow the rules': () => {
    const problems = FILES.flatMap(rel => codeProblems(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    assert.deepEqual(problems, [], `${problems.join('\n')}\n\nThe rules are in CODING_STANDARDS.md.`)
  },
}

runChecks(tests)
