import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ignored, parseIgnore, startsClear } from '../src/core/ignore.ts'
import { LIMITS } from '../src/core/workspace.ts'

const hides = (rules: string, path: string, folder = false, folded = false): boolean =>
  ignored(parseIgnore(rules, folded), path.split('/'), folder, folded)

describe('the rules of a .gitignore', () => {
  test('a table of pattern, path, folder flag and result', () => {
    // [rules, path, folder, hidden]
    const table: [string, string, boolean, boolean][] = [
      ['node_modules/', 'node_modules', true, true],
      ['node_modules/', 'node_modules', false, false],
      ['node_modules/', 'a/b/node_modules', true, true],
      ['*.log', 'x.log', false, true],
      ['*.log', 'a/b/x.log', false, true],
      ['*.log', 'x.txt', false, false],
      ['/out', 'out', true, true],
      ['/out', 'out', false, true],
      ['/out', 'a/out', true, false],
      ['out/a', 'out/a', false, true],
      ['out/a', 'x/out/a', false, false],
      ['docs/_build/', 'docs/_build', true, true],
      ['docs/_build/', 'x/docs/_build', true, false],
      ['**/tmp/*.bak', 'tmp/a.bak', false, true],
      ['**/tmp/*.bak', 'x/y/tmp/a.bak', false, true],
      ['**/tmp/*.bak', 'x/tmp/a.txt', false, false],
      ['**/tmp/*.bak', 'x/tmp/sub/a.bak', false, false],
      ['a/**/b', 'a/b', false, true],
      ['a/**/b', 'a/x/y/b', false, true],
      ['a/**/b', 'x/a/b', false, false],
      ['a/**', 'a/x', false, true],
      ['a/**', 'a/x/y', false, true],
      ['a/**', 'a', true, false],
      ['**/foo', 'foo', false, true],
      ['**/foo', 'a/b/foo', false, true],
      ['/**', 'a', false, true],
      ['/**', 'a/b', false, true],
      ['**', 'a', false, true],
      ['[Bb]in/', 'bin', true, true],
      ['[Bb]in/', 'Bin', true, true],
      ['[Bb]in/', 'xin', true, false],
      ['[Oo]bj/', 'src/Obj', true, true],
      ['*.py[cod]', 'a.pyc', false, true],
      ['*.py[cod]', 'a.pyo', false, true],
      ['*.py[cod]', 'a.pyx', false, false],
      ['[a-c]x', 'bx', false, true],
      ['[a-c]x', 'dx', false, false],
      ['[!a]x', 'bx', false, true],
      ['[!a]x', 'ax', false, false],
      ['[^a]x', 'bx', false, true],
      ['[^a]x', 'ax', false, false],
      ['[]a]x', ']x', false, true],
      ['?at', 'cat', false, true],
      ['?at', 'at', false, false],
      ['a?c*e', 'abcde', false, true],
      ['*', 'anything', false, true],
      ['# note\nx.log', '# note', false, false],
      ['\\#hash', '#hash', false, true],
      ['\\!bang', '!bang', false, true],
      ['x.log   ', 'x.log', false, true],
      ['   ', 'x', false, false],
      ['a/b/', 'a/b', true, true],
      ['café', 'café', false, true],
      ['café', 'café', false, true],
    ]
    for (const [rules, path, folder, hidden] of table)
      assert.equal(hides(rules, path, folder), hidden, `${JSON.stringify(rules)} on ${path}${folder ? '/' : ''}`)
  })

  test('negation: the last rule that matches wins', () => {
    const rules = '*.log\n!keep.log'
    assert.equal(hides(rules, 'x.log'), true)
    assert.equal(hides(rules, 'keep.log'), false)
    assert.equal(hides('!keep.log\n*.log', 'keep.log'), true)
    assert.equal(hides('logs/\n!logs/keep.txt', 'logs/keep.txt'), false, 'the walk never enters logs/, so this is moot')
    assert.equal(hides('/*\n!/src', 'src', true), false)
    assert.equal(hides('/*\n!/src', 'docs', true), true)
  })

  test('lines with CRLF, a missing final newline and blank lines', () => {
    const rules = 'a.log\r\n\r\n# c\r\n/out\r\nlast'
    assert.equal(hides(rules, 'a.log'), true)
    assert.equal(hides(rules, 'out', true), true)
    assert.equal(hides(rules, 'last'), true)
    assert.equal(hides(rules, '# c'), false)
  })

  test('the case folds only where the platform folds it', () => {
    assert.equal(hides('Out/', 'out', true, false), false)
    assert.equal(hides('Out/', 'out', true, true), true)
    assert.equal(hides('[A-C]x', 'bx', false, true), true)
    assert.equal(hides('[A-C]x', 'bx', false, false), false)
  })

  test('a start that is ignored, or inside an ignored folder, applies no rule', () => {
    const rules = parseIgnore('out/\n*.log', false)
    assert.equal(startsClear(rules, [], false), true)
    assert.equal(startsClear(rules, ['src'], false), true)
    assert.equal(startsClear(rules, ['out'], false), false)
    assert.equal(startsClear(rules, ['out', 'deep', 'er'], false), false)
    assert.equal(startsClear(rules, ['src', 'out'], false), false)
  })

  test('a line that is not taken is skipped whole, with no error', () => {
    const skipped = [
      'a\\b',
      'a\\ ',
      '\\#a\\b',
      'a**',
      '**a',
      'a**b/c',
      '[abc',
      '[',
      '[[:alpha:]]x',
      '[a-',
      '!',
      '/',
      '//',
      'a//b',
      `${'x'.repeat(201)}`,
      '*a*b*c*d*e*f*g',
      '?????????',
      '[a][b][c][d][e][f][g]',
      'a\0b',
    ]
    for (const line of skipped) {
      const rules = parseIgnore(`${line}\nkept`, false)
      assert.equal(rules.length, 1, JSON.stringify(line))
      assert.equal(ignored(rules, ['kept'], false, false), true)
    }
    assert.equal(parseIgnore('*a*b*c*d*e*f', false).length, 1, 'six wildcards count')
    assert.equal(parseIgnore('x'.repeat(200), false).length, 1, 'a line of 200 characters counts')
  })

  test('at most LIMITS.ignoreRules rules count, the rest are skipped', () => {
    const text = Array.from({ length: 10_000 }, (_, i) => `n${i}`).join('\n')
    const rules = parseIgnore(text, false)
    assert.equal(rules.length, LIMITS.ignoreRules)
    assert.equal(ignored(rules, ['n0'], false, false), true)
    assert.equal(ignored(rules, [`n${LIMITS.ignoreRules}`], false, false), false)
  })

  test('hostile text never throws and ends at once', () => {
    const hostile = [
      '[z-a]',
      '[z-a]\n*',
      '\\ ',
      '/\n!\n/',
      '\0\0\0',
      'a'.repeat(LIMITS.ignoreBytes),
      `${'*a'.repeat(100)}`,
      `${'a/'.repeat(5000)}`,
      '\n'.repeat(10_000),
      '[' + ']'.repeat(300),
      '\uD800',
    ]
    const names = [['a'], ['a', 'b', 'c'], Array.from({ length: 64 }, () => 'a'.repeat(200))]
    const began = performance.now()
    for (const text of hostile) {
      const rules = parseIgnore(text, true)
      for (const parts of names) ignored(rules, parts, true, true)
    }
    assert.ok(performance.now() - began < 2000)
    // Six wildcards against a long name that nearly matches: the match is bounded.
    const rules = parseIgnore('*a*a*a*a*a*b', false)
    assert.equal(ignored(rules, ['a'.repeat(200)], false, false), false)
  })
})
