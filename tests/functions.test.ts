import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  codeDiff,
  failedFunctions,
  formatFunction,
  formatFunctions,
  functionError,
  functionFixNudge,
  functionsFor,
  parseFunction,
  signatureOf,
  usedFunctions,
  type SavedFunction,
} from '../src/core/functions.ts'

const HOME = '/home/test'
const DIR = `${HOME}/.claude/code-mode/functions`
const CODE =
  'async ({ cloudId, jql }) => {\n  const r = await call("mcp__jira__search", { cloudId, jql })\n  return r.issues\n}'

const fn = (name: string, code: string, description = `Does ${name}.`): SavedFunction => ({
  name,
  description,
  code,
  path: `${DIR}/${name}.md`,
})

describe('function files', () => {
  test('functionError accepts an async function expression with a name and a description', () => {
    assert.equal(functionError('searchAll', 'Every issue.', CODE), undefined)
    assert.ok(functionError('search-all', 'Every issue.', CODE)?.includes('JavaScript name'))
    assert.ok(functionError('searchAll', '', CODE)?.includes('description'))
    assert.ok(functionError('searchAll', 'Every issue.', '({ jql }) => 1')?.includes('async function expression'))
    assert.ok(functionError('searchAll', 'Every issue.', 'async () => "```"')?.includes('```'))
    assert.ok(functionError('searchAll', 'Every issue.', `async () => ${'1'.repeat(8001)}`)?.includes('more than 8000'))
  })

  test('formatFunction and parseFunction give the same function back', () => {
    const text = formatFunction({ name: 'searchAll', description: 'Every\nissue.', code: CODE, why: 'Weekly report.' })
    assert.equal(
      text,
      `---\nname: searchAll\ndescription: Every issue.\nwhy: Weekly report.\n---\n\n\`\`\`js\n${CODE}\n\`\`\`\n`,
    )
    assert.deepEqual(parseFunction(text, '/f.md'), {
      name: 'searchAll',
      description: 'Every issue.',
      code: CODE,
      path: '/f.md',
      why: 'Weekly report.',
    })
    assert.equal(parseFunction('---\nname: x\n---\nno code', '/f.md'), undefined)
    assert.equal(parseFunction(text.replace('searchAll', 'bad name'), '/f.md'), undefined)
  })

  test('usedFunctions follows lib.<name> into the functions it names', () => {
    const all = new Map([
      ['a', fn('a', 'async () => lib.b()')],
      ['b', fn('b', 'async () => lib["c"]()')],
      ['c', fn('c', 'async () => 1')],
      ['d', fn('d', 'async () => lib.a()')],
    ])
    assert.deepEqual(usedFunctions('return await lib.a({}) + calllib.d()', all).sort(), ['a', 'b', 'c'])
    assert.deepEqual(usedFunctions('return lib.missing()', all), [])
  })

  test('signatureOf shows the parameters', () => {
    assert.equal(signatureOf(CODE), '({ cloudId, jql })')
    assert.equal(signatureOf('async args => args'), '(args)')
    assert.equal(signatureOf('async function all(a,\n b) {}'), '(a, b)')
  })

  test('functionsFor finds a function by a tool it calls or by a query word', () => {
    const all = [
      fn('searchAll', CODE, 'Every issue for a query.'),
      fn('mailDigest', 'async () => 1', 'A digest of mail.'),
    ]
    assert.deepEqual(
      functionsFor(all, ['mcp__jira__search'], 'jira').map(f => f.name),
      ['searchAll'],
    )
    assert.deepEqual(
      functionsFor(all, [], 'digest').map(f => f.name),
      ['mailDigest'],
    )
    assert.deepEqual(
      functionsFor(all, [], '').map(f => f.name),
      ['searchAll', 'mailDigest'],
    )
    assert.equal(
      formatFunctions(all.slice(0, 1)),
      '## Saved functions\n\nCall them in run_code as await lib.<name>(args). The person approved each one.\n- lib.searchAll({ cloudId, jql }): Every issue for a query.',
    )
    assert.equal(formatFunctions([]), '')
  })

  test('codeDiff shows every line, with the removed lines before the added ones', () => {
    assert.equal(codeDiff('a\nb\nc', 'a\nB\nc\nd'), '@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d')
    assert.equal(codeDiff('a', 'a'), '@@ -1,1 +1,1 @@\n a')
    // Too large for the table of common lines: all old lines, then all new ones,
    // between the equal first and last lines.
    const lines = (p: string) => Array.from({ length: 600 }, (_, i) => `${p}${i}`)
    const diff = codeDiff(['top', ...lines('a'), 'end'].join('\n'), ['top', ...lines('b'), 'end'].join('\n')).split(
      '\n',
    )
    assert.deepEqual(diff.slice(0, 3), ['@@ -1,602 +1,602 @@', ' top', '-a0'])
    assert.deepEqual(diff.slice(601, 604), ['-a599', '+b0', '+b1'])
    assert.equal(diff.at(-1), ' end')
  })

  test('failedFunctions finds the saved functions an error came from', () => {
    const stack = 'Error: boom\n    at eval (lib/page.js:3:11)\n    at async code.js:1:14'
    assert.deepEqual(failedFunctions(stack, ['page', 'searchAll']), ['page'])
    assert.deepEqual(failedFunctions('SyntaxError: lib.searchAll does not compile: x', ['page', 'searchAll']), [
      'searchAll',
    ])
    assert.equal(functionFixNudge([]), '')
    assert.ok(functionFixNudge(['page']).includes('The error comes from lib.page.'))
  })
})
