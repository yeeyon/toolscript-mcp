// scripts/changelog.mjs on temp folders, never on the files of the repo: the fold into a new or an existing section,
// the order, the delete after --apply, the dry run, each refusal, the stop of a run and CRLF.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'scripts', 'changelog.mjs')
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-changelog-test-')))
after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }))

const HEAD = '# Changelog\n\n'
const OLD = '## 1.0.4\n\n- old one\n- old two\n'
let counter = 0
/** A temp root with a CHANGELOG.md and the given fragments. */
const rig = (changelog: string | undefined, fragments: Record<string, string> = {}) => {
  const root = path.join(base, `r${counter++}`)
  fs.mkdirSync(path.join(root, 'changes'), { recursive: true })
  if (changelog !== undefined) fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog)
  for (const [name, text] of Object.entries(fragments)) fs.writeFileSync(path.join(root, 'changes', name), text)
  return root
}
const run = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args, '--root', root], { encoding: 'utf8', timeout: 30_000 })
const read = (root: string) => fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const left = (root: string) => fs.readdirSync(path.join(root, 'changes')).sort()
const refused = (r: ReturnType<typeof run>, pattern: RegExp) => {
  assert.equal(r.status, 2, r.stderr)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr.trim().split('\n').length, 1, 'one line')
  assert.match(r.stderr, pattern)
}

describe('the fold', () => {
  test('a new section goes above a lower first section, the rest stays byte for byte', () => {
    const root = rig(HEAD + OLD + '\n## 1.0.3\n\n- older\n', { 'a.md': '- one\n' })
    const r = run(root, '1.0.5', '--apply')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(read(root), HEAD + '## 1.0.5\n\n- one\n\n' + OLD + '\n## 1.0.3\n\n- older\n')
    assert.deepEqual(left(root), [])
  })

  test('the lines go to the end of the first section when it is the version', () => {
    const root = rig(HEAD + '## 1.0.5\n\n- have\n\n' + OLD, { 'a.md': '- one\n  wrapped\n- two\n' })
    assert.equal(run(root, '1.0.5', '--apply').status, 0)
    assert.equal(read(root), HEAD + '## 1.0.5\n\n- have\n- one\n  wrapped\n- two\n\n' + OLD)
  })

  test('a section at the end of the file, and a file with no section', () => {
    const a = rig(HEAD + '## 1.0.5\n\n- have\n', { 'a.md': '- one\n' })
    assert.equal(run(a, '1.0.5', '--apply').status, 0)
    assert.equal(read(a), HEAD + '## 1.0.5\n\n- have\n- one\n')
    const b = rig('# Changelog\n', { 'a.md': '- one\n' })
    assert.equal(run(b, '0.1.0', '--apply').status, 0)
    assert.equal(read(b), HEAD + '## 0.1.0\n\n- one\n')
  })

  test('fragments fold in file name order, and the lines of a fragment keep their order', () => {
    const root = rig(HEAD + OLD, {
      'b-two.md': '- b1\n- b2\n',
      'a-one.md': '- a1\n\n- a2\n',
      '10-ten.md': '- t1\n',
      '9-nine.md': '- n1\n',
      'README.md': 'Not folded.\n',
    })
    assert.equal(run(root, '1.0.5', '--apply').status, 0)
    assert.equal(read(root), HEAD + '## 1.0.5\n\n- t1\n- n1\n- a1\n- a2\n- b1\n- b2\n\n' + OLD)
    assert.deepEqual(left(root), ['README.md'], 'the README stays')
  })

  test('a fragment with CRLF folds as LF', () => {
    const root = rig(HEAD + OLD, { 'a.md': '- one\r\n  wrapped\r\n- two\r\n' })
    assert.equal(run(root, '1.0.5', '--apply').status, 0)
    assert.equal(read(root), HEAD + '## 1.0.5\n\n- one\n  wrapped\n- two\n\n' + OLD)
  })

  test('a dry run prints the section and changes nothing', () => {
    const text = HEAD + '## 1.0.5\n\n- have\n\n' + OLD
    const root = rig(text, { 'a.md': '- one\n' })
    const r = run(root, '1.0.5')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, '## 1.0.5\n\n- have\n- one\n')
    assert.equal(read(root), text)
    assert.deepEqual(left(root), ['a.md'])
    assert.equal(fs.existsSync(path.join(root, 'CHANGELOG.md.tmp')), false)
  })
})

describe('the refusals', () => {
  test('a version that is not N.N.N', () => {
    for (const v of ['1.0', '1.0.5-rc1', 'v1.0.5', '01.0.5', '1.0.5.1', 'x'])
      refused(run(rig(HEAD + OLD, { 'a.md': '- one\n' }), v, '--apply'), /N\.N\.N/)
  })

  test('a section that exists below another, and a version lower than the first section', () => {
    const root = rig(HEAD + '## 1.0.5\n\n- x\n\n' + OLD, { 'a.md': '- one\n' })
    refused(run(root, '1.0.4', '--apply'), /exists below another section/)
    refused(run(root, '1.0.3', '--apply'), /lower than the first section/)
    assert.equal(read(root), HEAD + '## 1.0.5\n\n- x\n\n' + OLD)
    assert.deepEqual(left(root), ['a.md'])
  })

  test('no fragment to fold', () => {
    refused(run(rig(HEAD + OLD, { 'README.md': 'x\n' }), '1.0.5', '--apply'), /no file in changes/)
    const root = rig(HEAD + OLD)
    fs.rmSync(path.join(root, 'changes'), { recursive: true })
    refused(run(root, '1.0.5'), /no file in changes/)
  })

  test('a fragment that is not well-formed refuses the whole fold', () => {
    const bad: Record<string, string> = {
      'empty.md': '',
      'heading.md': '## 1.0.5\n- one\n',
      'prose.md': 'text\n',
      'nonewline.md': '- one',
      'blank-first.md': '\n- one\n',
      'blank-double.md': '- a\n\n\n- b\n',
      'orphan-continuation.md': '  wrapped\n- one\n',
      'empty-item.md': '- \n',
    }
    for (const [name, text] of Object.entries(bad)) {
      const root = rig(HEAD + OLD, { 'good.md': '- good\n', [name]: text })
      refused(run(root, '1.0.5', '--apply'), new RegExp(`changes/${name.replace('.', '\\.')}`))
      assert.equal(read(root), HEAD + OLD, name)
      assert.deepEqual(left(root), [name, 'good.md'].sort(), 'nothing deleted')
    }
  })

  test('a bad name, another extension and a folder in changes/', () => {
    for (const name of ['Upper.md', 'notes.txt', '.hidden.md', '-dash.md']) {
      const root = rig(HEAD + OLD, { 'good.md': '- good\n', [name]: '- one\n' })
      refused(run(root, '1.0.5', '--apply'), /the name must match/)
      assert.deepEqual(left(root).includes('good.md'), true)
    }
    const root = rig(HEAD + OLD, { 'good.md': '- good\n' })
    fs.mkdirSync(path.join(root, 'changes', 'dir.md'))
    refused(run(root, '1.0.5', '--apply'), /not a file/)
    assert.equal(read(root), HEAD + OLD)
  })

  test('a CHANGELOG.md with no "# Changelog" first line, or none at all', () => {
    refused(run(rig('## 1.0.4\n\n- x\n', { 'a.md': '- one\n' }), '1.0.5', '--apply'), /# Changelog/)
    refused(run(rig(undefined, { 'a.md': '- one\n' }), '1.0.5', '--apply'), /cannot be read/)
  })

  test('a first section that is not a version', () => {
    refused(run(rig(HEAD + '## Unreleased\n\n- x\n', { 'a.md': '- one\n' }), '1.0.5', '--apply'), /not a version/)
  })

  test('a bad argument', () => {
    refused(run(rig(HEAD + OLD), '--apply'), /usage/)
  })
})

describe('--apply is safe to stop', () => {
  test('a fragment left after the rename is deleted and its lines are not added twice', () => {
    const root = rig(HEAD + OLD, { 'a.md': '- one\n', 'b.md': '- two\n  wrapped\n' })
    assert.equal(run(root, '1.0.5', '--apply').status, 0)
    const folded = read(root)
    // A stop after the rename and before the deletes leaves every fragment, and a new one may come in meanwhile.
    fs.writeFileSync(path.join(root, 'changes', 'a.md'), '- one\n')
    fs.writeFileSync(path.join(root, 'changes', 'b.md'), '- two\n  wrapped\n')
    fs.writeFileSync(path.join(root, 'changes', 'c.md'), '- three\n')
    const again = run(root, '1.0.5', '--apply')
    assert.equal(again.status, 0, again.stderr)
    assert.equal(read(root), folded.replace('  wrapped\n', '  wrapped\n- three\n'))
    assert.deepEqual(left(root), [])
  })

  test('only folded fragments left: CHANGELOG.md is not written, the files go', () => {
    const root = rig(HEAD + OLD, { 'a.md': '- one\n' })
    assert.equal(run(root, '1.0.5', '--apply').status, 0)
    const folded = read(root)
    const mtime = fs.statSync(path.join(root, 'CHANGELOG.md')).mtimeMs
    fs.writeFileSync(path.join(root, 'changes', 'a.md'), '- one\n')
    assert.equal(run(root, '1.0.5').stdout, '## 1.0.5\n\n- one\n', 'the dry run shows the section as it is')
    assert.equal(run(root, '1.0.5', '--apply').status, 0)
    assert.equal(read(root), folded)
    assert.equal(fs.statSync(path.join(root, 'CHANGELOG.md')).mtimeMs, mtime)
    assert.deepEqual(left(root), [])
  })

  test('a temp file left by a stopped run is replaced, not folded in', () => {
    const root = rig(HEAD + OLD, { 'a.md': '- one\n' })
    fs.writeFileSync(path.join(root, 'CHANGELOG.md.tmp'), 'half a file')
    assert.equal(run(root, '1.0.5', '--apply').status, 0)
    assert.equal(read(root), HEAD + '## 1.0.5\n\n- one\n\n' + OLD)
    assert.equal(fs.existsSync(path.join(root, 'CHANGELOG.md.tmp')), false)
  })

  test('a refusal writes nothing, not even the temp file', () => {
    const root = rig(HEAD + OLD, { 'a.md': '- one\n', 'bad.md': 'x\n' })
    refused(run(root, '1.0.5', '--apply'), /bad\.md/)
    assert.equal(fs.existsSync(path.join(root, 'CHANGELOG.md.tmp')), false)
  })
})

describe('large inputs', () => {
  test('500 fragments fold in order, and a 1 MB fragment folds', () => {
    const fragments: Record<string, string> = {}
    for (let i = 0; i < 500; i++) fragments[`f${String(i).padStart(3, '0')}.md`] = `- item ${i}\n`
    fragments['z-big.md'] = `- ${'x'.repeat(1_000_000)}\n`
    const root = rig(HEAD + OLD, fragments)
    const r = run(root, '1.0.5', '--apply')
    assert.equal(r.status, 0, r.stderr)
    const lines = read(root).split('\n')
    assert.equal(
      lines.slice(4, 504).every((l, i) => l === `- item ${i}`),
      true,
    )
    assert.equal(lines[504]!.length, 1_000_002)
    assert.deepEqual(left(root), [])
  })
})
