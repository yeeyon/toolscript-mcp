// Packs toolscript-mcp as npm publishes it, checks the file list, installs the
// tarball in an empty folder and runs the end-to-end test against the
// installed command. CI runs it on every system, and the release runs it
// before npm publish. Run `npm run build` first.
//
//   node scripts/pack-check.mjs [--out <dir>]   the tarball stays in <dir>

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'dist/host/main.js', 'runtime/runner.mjs']
const FORBIDDEN = /^(src|tests|bench|scripts|\.github|\.audit|\.claude|\.githooks|node_modules)\//
const WIN = process.platform === 'win32'

// npm and the command npm makes are .cmd files on Windows, which Node starts
// only through a shell. The shell gets one joined line, so a path with a space
// is quoted. No argument here comes from outside this script.
const arg = a => (WIN && /\s/.test(a) ? `"${a}"` : a)
const npm = (args, cwd) => {
  const r = spawnSync('npm', args.map(arg), { cwd, encoding: 'utf8', shell: WIN })
  assert.equal(r.status, 0, `npm ${args.join(' ')} failed:\n${r.stderr}`)
  return r.stdout
}

const { out } = parseArgs({ options: { out: { type: 'string' } } }).values
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-pack-'))
try {
  const dest = path.resolve(out ?? work)
  fs.mkdirSync(dest, { recursive: true })

  const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', dest], ROOT))
  const files = pack.files.map(f => f.path.replaceAll('\\', '/'))
  for (const f of REQUIRED) assert.ok(files.includes(f), `the package has no ${f}`)
  const extra = files.filter(f => FORBIDDEN.test(f))
  assert.deepEqual(extra, [], 'the package holds files that are not for users')
  const tarball = path.join(dest, pack.filename)
  console.log(`packed ${pack.name}@${pack.version}: ${files.length} files, ${pack.size} bytes`)

  const app = path.join(work, 'app')
  fs.mkdirSync(app)
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ private: true }))
  npm(['install', '--no-audit', '--no-fund', tarball], app)
  const installed = path.join(app, 'node_modules', 'toolscript-mcp')
  const bin = path.join(app, 'node_modules', '.bin', WIN ? 'toolscript-mcp.cmd' : 'toolscript-mcp')
  assert.ok(fs.existsSync(bin), `npm made no command at ${bin}`)

  // The command npm made starts the server: without a config it names the file it tried, on stderr only.
  const missing = path.join(work, 'no-such-config.json')
  const run = spawnSync(arg(bin), ['--config', missing].map(arg), { encoding: 'utf8', shell: WIN, timeout: 30_000 })
  assert.equal(run.status, 1, `the installed command exited ${run.status}:\n${run.stderr}`)
  assert.equal(run.stdout, '', 'the installed command wrote to stdout')
  assert.match(run.stderr, /cannot read the config/)
  console.log('the installed command starts and reports a missing config')

  const e2e = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'server.e2e.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, TOOLSCRIPT_E2E_MAIN: path.join(installed, 'dist', 'host', 'main.js') },
  })
  assert.equal(e2e.status, 0, 'the end-to-end test failed against the installed package')
  console.log(out ? `pack check passed: ${tarball}` : 'pack check passed')
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
