import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIMITS,
  WORKSPACE_TOOLS,
  WORKSPACE_TOOL_NAMES,
  WorkspaceError,
  bindRoot,
  builtInExcluded,
  compileGlob,
  fold,
  globMatches,
  globProblem,
  includeTest,
  isInside,
  appliedChange,
  applyRanges,
  lineEndWarnings,
  makeExcluder,
  parseDiffInput,
  parseEditInput,
  parseListInput,
  parsePathInput,
  parseSearchInput,
  parseWriteInput,
  pathParts,
  realParts,
  planEdits,
  rootProblem,
  unifiedDiff,
  workspaceClass,
  type Edit,
  type Range,
} from '../src/core/workspace.ts'
import {
  NO_GUARDS,
  askText,
  checkCall,
  decide,
  onlyTightens,
  planRun,
  type Guards,
  type Policy,
} from '../src/core/policy.ts'
import type { ServerKey } from '../src/core/config.ts'

const code = (f: () => unknown): string | undefined => {
  try {
    f()
  } catch (err) {
    return err instanceof WorkspaceError ? err.code : `other: ${err}`
  }
  return undefined
}

describe('the text of a path', () => {
  test('refuses each bad form with bad-path, on every system', () => {
    const bad = [
      '',
      '../x',
      'a/../../x',
      'a/..',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'C:x',
      '//server/share/x',
      '\\\\server\\share\\x',
      'a\\b',
      'a\u0000b',
      'a\nb',
      'a//b',
      'a/',
      './a',
      'a/./b',
      Array.from({ length: LIMITS.parts + 1 }, () => 'a').join('/'),
      'x'.repeat(LIMITS.pathChars + 1),
    ]
    for (const text of bad)
      for (const windows of [false, true])
        assert.equal(
          code(() => pathParts(text, windows)),
          'bad-path',
          JSON.stringify(text.slice(0, 20)),
        )
  })

  test('refuses the Windows forms on Windows only', () => {
    for (const text of [
      'f.txt::$DATA',
      'f.txt:s',
      'f.txt.',
      'f.txt ',
      'NUL',
      'CON.txt',
      'a/com1',
      'a/Lpt9.log',
      'a<b',
      'a?b',
      'a*b',
    ])
      assert.equal(
        code(() => pathParts(text, true)),
        'bad-path',
        text,
      )
    for (const text of ['f.txt:s', 'f.txt.', 'NUL', 'CON.txt']) assert.deepEqual(pathParts(text, false), [text])
  })

  test('keeps the parts of a good path, and `.` is the root', () => {
    assert.deepEqual(pathParts('src/retry.ts', false), ['src', 'retry.ts'])
    assert.deepEqual(pathParts('.', true), [])
    assert.deepEqual(pathParts('a'.repeat(1), true), ['a'])
    assert.equal(pathParts(Array.from({ length: LIMITS.parts }, () => 'a').join('/'), false).length, LIMITS.parts)
    assert.deepEqual(pathParts('café/x', true), ['café', 'x'])
  })
})

describe('globs', () => {
  const m = (glob: string, path: string) => globMatches(compileGlob(glob), path.split('/'))
  test('* and ? stay inside a part, ** spans parts', () => {
    assert.ok(m('src/**/*.ts', 'src/a/b/c.ts'))
    assert.ok(m('src/**/*.ts', 'src/c.ts'))
    assert.ok(!m('src/*.ts', 'src/a/c.ts'))
    assert.ok(m('**', 'a/b'))
    assert.ok(m('**/x', 'x'))
    assert.ok(m('a/**', 'a'))
    assert.ok(m('f?.txt', 'f1.txt'))
    assert.ok(!m('f?.txt', 'f12.txt'))
    assert.ok(!m('*.ts', 'a/b.ts'))
    assert.ok(m('*a*b*', 'xxaxxbxx'))
    assert.ok(!m('src/**/*.ts', 'lib/a.ts'))
  })

  test('a hostile glob stays bounded', () => {
    const glob = '*a*a*a*a*a*a'
    assert.equal(globProblem(glob), undefined)
    const started = performance.now()
    assert.equal(m(glob, 'a'.repeat(240) + 'b'), false)
    assert.ok(performance.now() - started < 500)
    assert.match(globProblem('*a*a*a*a*a*a*a') ?? '', /at most 6 wildcards/)
  })

  test('globProblem names the rule and never the glob', () => {
    for (const bad of [
      '',
      '/abs',
      'a\\b',
      'a//b',
      '../x',
      'a/./b',
      'src/**x',
      'a\u0000',
      'x'.repeat(201),
      5,
      undefined,
      null,
    ])
      assert.ok(globProblem(bad) !== undefined, String(bad))
    for (const good of ['src/**/*.ts', '*.sqlite', 'fixtures/secrets/**', '.env', 'a?b'])
      assert.equal(globProblem(good), undefined, good)
  })

  test('an empty include list matches each path', () => {
    assert.ok(includeTest([])(['a', 'b']))
    assert.ok(!includeTest(['src/**'])(['lib', 'a']))
  })
})

describe('the exclusions', () => {
  const excluded = makeExcluder(
    '/work/app',
    ['fixtures/secrets/**', '*.sqlite', 'private'],
    ['/work/app/cfg/toolscript.json', '/home/me/.toolscript-mcp'],
  )
  test('the built-in names, in any folder, any case, after NFC', () => {
    for (const path of [
      '.git/config',
      'a/.git/HEAD',
      '.env',
      '.ENV',
      '.env.local',
      'a/.Env.production',
      'id_rsa',
      'id_ed25519.pub',
      'key.pem',
      'x/server.KEY',
      '.claude/settings.json',
      '.mcp.json',
      '.vscode/tasks.json',
      '.ssh/config',
      '.npmrc',
      'infra/terraform.tfstate',
      'infra/terraform.tfstate.backup',
      '.toolscript-mcp/hints/x.md',
    ])
      assert.ok(excluded(path.split('/')), path)
    for (const path of [
      'src/retry.ts',
      'environment.ts',
      '.gitignore',
      'README.md',
      'a/env',
      '.github/workflows/test.yml',
    ])
      assert.ok(!excluded(path.split('/')), path)
  })

  test('the glob of the config', () => {
    assert.ok(excluded(['fixtures', 'secrets']))
    assert.ok(excluded(['fixtures', 'secrets', 'a', 'b.txt']))
    assert.ok(excluded(['data', 'app.SQLITE']))
    assert.ok(excluded(['a', 'private']), 'a name without a slash matches a part at any depth')
    assert.ok(excluded(['a', 'private', 'x']))
    assert.ok(!excluded(['fixtures', 'public']))
    assert.ok(!excluded(['fixtures']))
  })

  test('an NFD spelling matches an NFC name', () => {
    const ex = makeExcluder('/r', ['café.txt'], [])
    assert.ok(ex(['cafe\u0301.txt']))
    assert.equal(fold('CAFE\u0301'), fold('café'))
  })

  test('the real path of the config file and of the folder of the home folder', () => {
    assert.ok(excluded(['cfg', 'toolscript.json']))
    assert.ok(excluded(['CFG', 'ToolScript.JSON']))
    assert.ok(!excluded(['cfg', 'other.json']))
    const inHome = makeExcluder('/home/me', [], ['/home/me/.toolscript-mcp'])
    assert.ok(inHome(['.toolscript-mcp', 'config.json']))
    assert.ok(builtInExcluded(['x', '.AWS']))
  })
})

describe('the root of a session', () => {
  const win = (path: string) => path
  test('a root is refused for a drive, the home folder, a folder that holds it, an excluded part or a network path', () => {
    assert.match(rootProblem('/', '/home/me', 'linux') ?? '', /file system root/)
    assert.match(rootProblem('C:\\', 'C:\\Users\\me', 'win32') ?? '', /file system root/)
    assert.match(rootProblem('/home/me', '/home/me', 'linux') ?? '', /home/)
    assert.match(rootProblem('/home', '/home/me', 'linux') ?? '', /holds it/)
    assert.match(rootProblem('C:\\Users', 'C:\\Users\\me', 'win32') ?? '', /holds it/)
    assert.match(rootProblem('/home/me/app/.git/modules', '/home/me', 'linux') ?? '', /\.git/)
    assert.match(rootProblem('C:\\Users\\me\\.ssh', 'C:\\Users\\me', 'win32') ?? '', /\.ssh/)
    assert.match(rootProblem('\\\\server\\share\\app', 'C:\\Users\\me', 'win32') ?? '', /network/)
    assert.equal(rootProblem('/home/me/app', '/home/me', 'linux'), undefined)
    assert.equal(rootProblem('C:\\work\\app', 'C:\\Users\\me', 'win32'), undefined)
    assert.equal(win('x'), 'x')
  })

  const roots = [
    { path: '/work', write: false },
    { path: '/work/app', write: true },
    { path: '/other', write: false },
  ]
  test('1: a start folder inside entries takes the deepest entry, and is the root', () => {
    assert.deepEqual(bindRoot(roots, '/work/app/src', 'linux'), { ok: true, index: 1, root: '/work/app/src' })
    assert.deepEqual(bindRoot(roots, '/work/app', 'linux'), { ok: true, index: 1, root: '/work/app' })
    assert.deepEqual(bindRoot(roots, '/work/lib', 'linux'), { ok: true, index: 0, root: '/work/lib' })
    assert.deepEqual(bindRoot(roots, '/other', 'linux'), { ok: true, index: 2, root: '/other' })
  })

  test('2: one entry is the root when the start folder is outside it', () => {
    assert.deepEqual(bindRoot([roots[0]!], '/elsewhere', 'linux'), { ok: true, index: 0, root: '/work' })
  })

  test('3: several entries and a start folder outside all of them make Workspace unavailable', () => {
    const r = bindRoot(roots, '/elsewhere', 'linux')
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.reason, /Start the client in one of them/)
    assert.doesNotMatch(r.ok ? '' : r.reason, /\/work|elsewhere/)
  })

  test('a backslash separates parts on Windows only: on Linux and macOS it is a letter of a name', () => {
    const one = [{ path: '/home/me/projects/app', write: false }]
    const two = [...one, { path: '/home/me/other', write: false }]
    for (const platform of ['linux', 'darwin']) {
      const start = '/home/me/projects\\app/private'
      assert.equal(isInside(start, one[0]!.path, platform), false, platform)
      assert.equal(bindRoot(two, start, platform).ok, false, platform)
      assert.deepEqual(realParts(start, platform), ['home', 'me', 'projects\\app', 'private'])
      // The folder `projects\app` is not the home folder or a part of an excluded path either.
      assert.equal(rootProblem('/home/me/projects\\app', '/home/me/projects/app', platform), undefined)
      assert.match(rootProblem('/home/me/projects', '/home/me/projects/app', platform) ?? '', /holds it/)
    }
    // On Windows the backslash is a separator, so the same text is inside the entry.
    assert.equal(isInside('C:\\home\\me\\projects\\app\\private', 'C:\\home\\me\\projects\\app', 'win32'), true)
    assert.equal(isInside('C:\\home\\me\\projects/app/private', 'C:\\home\\me\\projects\\app', 'win32'), true)
    assert.deepEqual(realParts('C:\\a\\b/c', 'win32'), ['C:', 'a', 'b', 'c'])
  })

  test('a name that only starts like an entry is not inside it', () => {
    assert.equal(bindRoot(roots, '/work2', 'linux').ok, false)
  })

  test('case variants of one path are the same folder on Windows and macOS only', () => {
    for (const platform of ['win32', 'darwin'])
      assert.deepEqual(bindRoot(roots, '/WORK/App/Src', platform), { ok: true, index: 1, root: '/WORK/App/Src' })
    assert.deepEqual(bindRoot(roots, 'c:\\Work\\app', 'win32').ok, false, 'a drive letter is part of the path')
    assert.equal(bindRoot(roots, '/WORK/App/Src', 'linux').ok, false)
    const win32 = [{ path: 'C:\\Work\\App', write: false }]
    assert.deepEqual(bindRoot(win32, 'c:\\work\\app\\SRC', 'win32'), { ok: true, index: 0, root: 'c:\\work\\app\\SRC' })
  })
})

describe('the tool table', () => {
  test('the list and search descriptions say when truncated is true, with the numbers of LIMITS', () => {
    const num = (n: number) => n.toLocaleString('en-US')
    const list = WORKSPACE_TOOLS.list.description
    const search = WORKSPACE_TOOLS.search.description
    assert.ok(
      list.endsWith(
        `truncated is true when it stopped early (${LIMITS.searchMs / 1000} s, ${num(LIMITS.searchFiles)} names or ${num(LIMITS.listEntries)} entries).`,
      ),
      list,
    )
    assert.ok(
      search.endsWith(
        `truncated is true when it stopped early (${LIMITS.searchMs / 1000} s, ${num(LIMITS.searchFiles)} names or maxMatches): the matches are then partial.`,
      ),
      search,
    )
  })

  test('lists the tools of the read, write and exec classes', () => {
    assert.deepEqual(WORKSPACE_TOOL_NAMES, ['list', 'search', 'read', 'stat', 'run_task', 'diff', 'edit', 'write'])
    for (const name of WORKSPACE_TOOL_NAMES) {
      assert.equal(
        WORKSPACE_TOOLS[name].class,
        name === 'run_task' ? 'exec' : name === 'edit' || name === 'write' ? 'write' : 'read',
      )
      assert.equal(WORKSPACE_TOOLS[name].inputSchema.type, 'object')
      assert.equal((WORKSPACE_TOOLS[name].inputSchema as { additionalProperties: boolean }).additionalProperties, false)
      assert.equal(WORKSPACE_TOOLS[name].outputSchema.type, 'object')
      assert.ok(WORKSPACE_TOOLS[name].description.length > 20 && WORKSPACE_TOOLS[name].description.length < 280)
    }
    assert.equal(workspaceClass('mcp__workspace__read'), 'read')
    assert.equal(workspaceClass('mcp__workspace__diff'), 'read')
    assert.equal(workspaceClass('mcp__workspace__edit'), 'write')
    assert.equal(workspaceClass('mcp__workspace__write'), 'write')
    assert.equal(workspaceClass('mcp__workspace__run_task'), 'exec')
    assert.equal(workspaceClass('mcp__other__read'), undefined)
    assert.equal(workspaceClass('mcp__workspace__constructor'), undefined)
  })

  test('the input is checked, and a bad value is a bad-input error', () => {
    assert.deepEqual(parseListInput({}), { path: '.', depth: 1, include: [] })
    assert.deepEqual(parseListInput({ path: 'src', depth: 3, include: ['*.ts'] }), {
      path: 'src',
      depth: 3,
      include: ['*.ts'],
    })
    for (const bad of [
      { depth: 0 },
      { depth: 9 },
      { depth: 1.5 },
      { path: 4 },
      { include: 'x' },
      { include: ['/abs'] },
      { extra: 1 },
      null,
      [],
    ])
      assert.equal(
        code(() => parseListInput(bad)),
        'bad-input',
        JSON.stringify(bad),
      )
    assert.deepEqual(parseSearchInput({ query: 'x' }), {
      query: 'x',
      path: '.',
      include: [],
      ignoreCase: false,
      maxMatches: 200,
    })
    for (const bad of [
      {},
      { query: '' },
      { query: 'a\nb' },
      { query: 'x'.repeat(1001) },
      { query: 'x', maxMatches: 2001 },
      { query: 'x', ignoreCase: 'yes' },
      { query: 'x', regex: true },
    ])
      assert.equal(
        code(() => parseSearchInput(bad)),
        'bad-input',
        JSON.stringify(bad).slice(0, 40),
      )
    assert.deepEqual(parsePathInput({ path: 'a' }), { path: 'a' })
    assert.equal(
      code(() => parsePathInput({})),
      'bad-input',
    )
  })
})

describe('the policy of the built-in Workspace', () => {
  const on: Guards = { bridges: new Set<ServerKey>(), workspace: true }
  const rules = (...r: [string, 'allow' | 'deny' | 'ask'][]): Policy =>
    r.map(([match, action], index) => ({ match, action, index }))
  const READ = 'mcp__workspace__read'

  test('a read tool runs with no rule while the built-in is on, and asks without it', () => {
    for (const name of WORKSPACE_TOOL_NAMES)
      assert.deepEqual(decide([], on, `mcp__workspace__${name}`), {
        action: WORKSPACE_TOOLS[name].class === 'read' ? 'allow' : 'ask',
      })
    assert.deepEqual(decide([], NO_GUARDS, READ), { action: 'ask' }, 'a server named workspace gets no default')
    assert.deepEqual(decide([], on, 'mcp__workspace__edit'), { action: 'ask' })
    assert.deepEqual(decide([], on, 'mcp__other__read'), { action: 'ask' })
  })

  test('a rule that matches still decides', () => {
    const ask = rules(['mcp__workspace__*', 'ask'])
    const deny = rules([READ, 'deny'], ['*', 'allow'])
    assert.equal(decide(ask, on, READ).action, 'ask')
    assert.equal(decide(deny, on, READ).action, 'deny')
    assert.equal(decide(deny, on, 'mcp__workspace__list').action, 'allow')
  })

  test('the plan asks for no read tool, refuses a denied literal name and checks a built name at the call', () => {
    const call = (tool: string) => ({ tool, line: 1 })
    assert.deepEqual(planRun([], on, [call(READ)], new Set()), { kind: 'run', ask: [], interactive: [] })
    const deny = rules([READ, 'deny'])
    assert.equal(planRun(deny, on, [call(READ)], new Set()).kind, 'refused')
    assert.deepEqual(checkCall([], on, new Set(), READ, new Set()), { ok: true })
    assert.equal(checkCall(deny, on, new Set(), READ, new Set()).ok, false)
    assert.equal(checkCall([], NO_GUARDS, new Set(), READ, new Set()).ok, false)
  })

  test('onlyTightens gives the same answers with the built-in on', () => {
    const allow = rules([READ, 'allow'])
    assert.equal(onlyTightens(allow, rules([READ, 'ask']), on), true)
    assert.equal(onlyTightens(allow, rules([READ, 'deny']), on), true)
    assert.equal(onlyTightens(allow, [], on), true)
    assert.equal(onlyTightens([], rules([READ, 'deny']), on), true)
    assert.equal(onlyTightens(rules([READ, 'ask']), rules([READ, 'allow']), on), false)
    assert.equal(
      onlyTightens(rules([READ, 'ask']), [], on),
      false,
      'removing an ask rule gives the default, which allows',
    )
    assert.equal(onlyTightens(rules([READ, 'deny']), [], on), false)
    assert.equal(onlyTightens([], rules([READ, 'allow']), on), false)
    assert.equal(onlyTightens(rules(['mcp__workspace__*', 'allow'], [READ, 'deny']), rules([READ, 'deny']), on), true)
  })
})

describe('the policy of run_task, the exec class', () => {
  const on: Guards = { bridges: new Set<ServerKey>(), workspace: true }
  const rules = (...r: [string, 'allow' | 'deny' | 'ask'][]): Policy =>
    r.map(([match, action], index) => ({ match, action, index }))
  const TASK = 'mcp__workspace__run_task'

  test('only the exact name allows it: *, mcp__* and mcp__workspace__* are skipped', () => {
    for (const match of ['*', 'mcp__*', 'mcp__workspace__*', 'mcp__workspace__run_*', 'mcp__*__run_task'])
      assert.deepEqual(decide(rules([match, 'allow']), on, TASK), { action: 'ask' }, match)
    assert.equal(decide(rules([TASK, 'allow']), on, TASK).action, 'allow')
    // The next rule that counts decides: a wildcard allow before an exact deny or ask does not hide it.
    assert.equal(decide(rules(['*', 'allow'], [TASK, 'deny']), on, TASK).action, 'deny')
    assert.equal(decide(rules(['mcp__workspace__*', 'allow'], [TASK, 'allow']), on, TASK).action, 'allow')
    // A wildcard allow still allows the read tools.
    assert.equal(decide(rules(['mcp__workspace__*', 'allow']), on, 'mcp__workspace__read').action, 'allow')
  })

  test('a deny rule and an ask rule count, with any match', () => {
    assert.equal(decide(rules(['mcp__workspace__*', 'deny']), on, TASK).action, 'deny')
    assert.equal(decide(rules(['mcp__*', 'ask']), on, TASK).action, 'ask')
    assert.equal(decide(rules(['*', 'deny'], [TASK, 'allow']), on, TASK).action, 'deny')
  })

  test('a server named workspace has no exec class: its tools follow the rules as any server', () => {
    assert.equal(decide(rules(['mcp__workspace__*', 'allow']), NO_GUARDS, TASK).action, 'allow')
  })

  test('the plan asks for it, a name built at run time is refused, and the exact rule lets both run', () => {
    const call = { tool: TASK, line: 1 }
    assert.deepEqual(planRun(rules(['*', 'allow']), on, [call], new Set()), {
      kind: 'run',
      ask: [TASK],
      interactive: [],
    })
    assert.deepEqual(planRun(rules([TASK, 'allow']), on, [call], new Set()), { kind: 'run', ask: [], interactive: [] })
    const wildcard = rules(['mcp__workspace__*', 'allow'])
    const refused = checkCall(wildcard, on, new Set(), TASK, new Set())
    assert.equal(refused.ok, false)
    assert.match(
      !refused.ok ? refused.error : '',
      /must name it exactly, such as \{"match": "mcp__workspace__run_task"/,
    )
    assert.deepEqual(checkCall(wildcard, on, new Set([TASK]), TASK, new Set()), { ok: true }, 'the person approved it')
    assert.deepEqual(checkCall(rules([TASK, 'allow']), on, new Set(), TASK, new Set()), { ok: true })
  })

  test('onlyTightens: an allow rule that run_task skips cannot be lowered to ask in front of a deny of it', () => {
    const before = rules(['mcp__workspace__*', 'allow'], [TASK, 'deny'])
    // The allow rule is skipped for run_task, so the deny decides. Lowered to ask, the ask rule would decide: looser.
    assert.equal(decide(before, on, TASK).action, 'deny')
    const lowered = rules(['mcp__workspace__*', 'ask'], [TASK, 'deny'])
    assert.equal(decide(lowered, on, TASK).action, 'ask')
    assert.equal(onlyTightens(before, lowered, on), false)
    for (const match of ['*', 'mcp__*', 'mcp__workspace__run_*'])
      assert.equal(
        onlyTightens(rules([match, 'allow'], [TASK, 'deny']), rules([match, 'ask'], [TASK, 'deny']), on),
        false,
        match,
      )
    // Lowered to deny, removed, or with a deny inserted, it only tightens.
    assert.equal(onlyTightens(before, rules(['mcp__workspace__*', 'deny'], [TASK, 'deny']), on), true)
    assert.equal(onlyTightens(before, rules([TASK, 'deny']), on), true)
    // The exact allow rule decides the tool, so lowering it to ask only tightens.
    assert.equal(onlyTightens(rules([TASK, 'allow']), rules([TASK, 'ask']), on), true)
    // With the built-in off, the same rules lower in place as before.
    assert.equal(onlyTightens(before, lowered, NO_GUARDS), true)
  })

  test('the prompt says that a task runs project code with your rights, and names the tasks and the root', () => {
    const text = askText({ ask: [TASK], interactive: [] }, 'return 1', on, {
      root: '/work/app',
      tasks: ['test', 'lint'],
    })
    assert.match(
      text,
      /- mcp__workspace__run_task\nA task runs project code with your rights\. Nothing contains it\.\nTasks: test, lint\.\nWorkspace root: \/work\/app\n/,
    )
    const read = askText({ ask: ['mcp__other__x'], interactive: [] }, 'return 1', on, {
      root: '/work/app',
      tasks: ['test'],
    })
    assert.doesNotMatch(read, /project code|Tasks:|Workspace root/, 'a prompt with no task names none')
    assert.doesNotMatch(askText({ ask: [TASK], interactive: [] }, 'return 1', NO_GUARDS, {}), /project code/)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Pull request B: edits, the unified diff and the policy of the change tools

const edit = (old: string, now: string, all = false): Edit => ({ old, new: now, all })
const range = (start: number, end: number, text: string): Range => ({ start, end, text, edit: 0 })
const lines = (...names: string[]) => names.map(n => `${n}\n`).join('')
const numbered = (count: number) => Array.from({ length: count }, (_, i) => `L${String(i + 1).padStart(2, '0')}`)

describe('apply edits', () => {
  test('each old must occur once, unless all is true, and only the matched text changes', () => {
    const text = 'one two three'
    assert.equal(applyRanges(text, planEdits(text, [edit('two', '2')])), 'one 2 three')
    assert.equal(applyRanges('aXaXa', planEdits('aXaXa', [edit('a', 'b', true)])), 'bXbXb')
    assert.equal(
      code(() => planEdits('aXaXa', [edit('a', 'b')])),
      'many-matches',
    )
    assert.throws(() => planEdits('aXaXa', [edit('a', 'b')]), /3 times/)
    assert.equal(
      code(() => planEdits('aaa', [edit('aa', 'b')])),
      'many-matches',
      'overlapping places count, so an old that can match two ways is refused',
    )
    assert.equal(
      code(() => planEdits(text, [edit('nope', 'x')])),
      'no-match',
    )
    assert.equal(
      code(() => planEdits(text, [edit('nope', 'x', true)])),
      'no-match',
      'all with no match is no-match too',
    )
  })

  test('an old is matched against the file as read: the order of the edits changes nothing, and overlapping edits fail', () => {
    assert.equal(applyRanges('ab', planEdits('ab', [edit('a', 'b'), edit('b', 'c')])), 'bc')
    assert.equal(applyRanges('ab', planEdits('ab', [edit('b', 'c'), edit('a', 'b')])), 'bc')
    assert.equal(
      code(() => planEdits('abcd', [edit('abc', 'x'), edit('bcd', 'y')])),
      'bad-input',
    )
    assert.equal(applyRanges('abcd', planEdits('abcd', [edit('ab', 'x'), edit('cd', 'y')])), 'xy')
  })

  test('an old that matches only with other line ends gets the hint, in both directions', () => {
    assert.throws(() => planEdits('a\r\nb\r\n', [edit('a\nb', 'x')]), /no-match: .*CRLF line ends/)
    assert.throws(() => planEdits('a\nb\n', [edit('a\r\nb', 'x')]), /no-match: .*LF line ends/)
    assert.throws(
      () => planEdits('a b', [edit('a\nb', 'x')]),
      (err: Error) => !/line ends/.test(err.message),
    )
  })

  test('the new text differs from the old only in the replaced ranges, for each style of line end', () => {
    const texts = [
      'x\nMID\ny\n',
      'x\r\nMID\r\ny\r\n',
      'x\r\nMID\ny\r\n',
      'MID',
      'no final line end MID',
      '﻿inner mark stays MID',
    ]
    for (const text of texts) {
      const at = text.indexOf('MID')
      const ranges = planEdits(text, [edit('MID', 'new\nlines')])
      assert.equal(
        applyRanges(text, ranges),
        text.slice(0, at) + 'new\nlines' + text.slice(at + 3),
        JSON.stringify(text),
      )
    }
  })

  test('the input of diff, edit and write is checked', () => {
    const hash = `sha256:${'a'.repeat(64)}`
    const good = { path: 'a.txt', expectedHash: hash, edits: [{ old: 'x', new: 'y' }] }
    assert.deepEqual(parseEditInput(good), { path: 'a.txt', expectedHash: hash, edits: [edit('x', 'y')] })
    assert.deepEqual(parseWriteInput({ path: 'a', content: 'c' }), { path: 'a', content: 'c' })
    assert.deepEqual(parseWriteInput({ path: 'a', content: 'c', expectedHash: hash }), {
      path: 'a',
      content: 'c',
      expectedHash: hash,
    })
    assert.deepEqual(parseDiffInput({ path: 'a', content: 'c' }), { path: 'a', content: 'c' })
    assert.deepEqual(parseDiffInput({ path: 'a', edits: good.edits }).edits, [edit('x', 'y')])
    const bad: [string, () => unknown, string][] = [
      ['no hash', () => parseEditInput({ ...good, expectedHash: undefined }), 'bad-input'],
      ['a short hash', () => parseEditInput({ ...good, expectedHash: 'sha256:ab' }), 'bad-input'],
      ['no edits', () => parseEditInput({ ...good, edits: [] }), 'bad-input'],
      [
        '51 edits',
        () => parseEditInput({ ...good, edits: Array.from({ length: 51 }, () => good.edits[0]) }),
        'bad-input',
      ],
      ['an empty old', () => parseEditInput({ ...good, edits: [{ old: '', new: 'y' }] }), 'bad-input'],
      ['an unknown key', () => parseEditInput({ ...good, edits: [{ old: 'x', new: 'y', regex: true }] }), 'bad-input'],
      ['a wrong all', () => parseEditInput({ ...good, edits: [{ old: 'x', new: 'y', all: 'yes' }] }), 'bad-input'],
      ['a NUL in new', () => parseEditInput({ ...good, edits: [{ old: 'x', new: 'a\0b' }] }), 'binary'],
      ['a lone surrogate', () => parseWriteInput({ path: 'a', content: '\ud800' }), 'encoding'],
      ['diff with both', () => parseDiffInput({ path: 'a', content: 'c', edits: good.edits }), 'bad-input'],
      ['diff with neither', () => parseDiffInput({ path: 'a' }), 'bad-input'],
      ['write with an edits key', () => parseWriteInput({ path: 'a', content: 'c', edits: [] }), 'bad-input'],
    ]
    for (const [what, f, expected] of bad) assert.equal(code(f), expected, what)
    // A pair of surrogates is a character, not an error.
    assert.equal(parseWriteInput({ path: 'a', content: '\u{1F600}' }).content, '\u{1F600}')
  })

  test('lineEndWarnings names a change that mixes line ends', () => {
    assert.deepEqual(lineEndWarnings('a\r\nb\r\n', 'a\r\nb\r\nc\n').length, 1)
    assert.deepEqual(lineEndWarnings('a\nb\n', 'a\nb\r\nc').length, 1)
    assert.deepEqual(lineEndWarnings('a\r\nb\r\n', 'a\r\nB\r\n'), [])
    assert.deepEqual(lineEndWarnings('a\nb\r\n', 'a\nb\r\nc\n'), [], 'a file that already mixes them is left alone')
  })

  test('appliedChange reads only a result that was applied', () => {
    const value = { path: 'a/b.ts', applied: true, created: false, added: 2, removed: 1, diff: 'x' }
    assert.deepEqual(appliedChange(value), { path: 'a/b.ts', created: false, added: 2, removed: 1 })
    assert.equal(appliedChange({ ...value, applied: false }), undefined)
    assert.equal(appliedChange({ ...value, added: '2' }), undefined)
    assert.equal(appliedChange(null), undefined)
    assert.equal(appliedChange('x'), undefined)
  })
})

describe('the unified diff', () => {
  test('one changed line, with 3 lines of context, as a unified diff', () => {
    const text = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
    const result = unifiedDiff('f.txt', text, planEdits(text, [edit('d', 'D')]))
    assert.equal(
      result.diff,
      ['--- a/f.txt', '+++ b/f.txt', '@@ -1,7 +1,7 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g', ''].join('\n'),
    )
    assert.deepEqual([result.added, result.removed, result.diffTruncated], [1, 1, false])
  })

  test('far changes make two hunks, near ones one, and the new line numbers follow the added lines', () => {
    const text = lines(...numbered(20))
    const far = unifiedDiff('f', text, planEdits(text, [edit('L02', 'X02'), edit('L18', 'X18\nX18b')]))
    const heads = far.diff.split('\n').filter(l => l.startsWith('@@'))
    assert.deepEqual(heads, ['@@ -1,5 +1,5 @@', '@@ -15,6 +15,7 @@'])
    assert.deepEqual([far.added, far.removed], [3, 2])
    const near = unifiedDiff('f', text, planEdits(text, [edit('L02', 'X02'), edit('L09', 'X09')]))
    assert.deepEqual(
      near.diff.split('\n').filter(l => l.startsWith('@@')),
      ['@@ -1,12 +1,12 @@'],
    )
  })

  test('a multi-line old that changes one line shows one removed and one added line', () => {
    const text = 'x\ny\nz\n'
    const result = unifiedDiff('f', text, planEdits(text, [edit('x\ny\nz', 'x\nY\nz')]))
    assert.deepEqual([result.added, result.removed], [1, 1])
    assert.match(result.diff, /\n-y\n\+Y\n/)
  })

  test('a file with no final line end is marked, and CRLF line ends stay in the diff', () => {
    const noEnd = unifiedDiff('f', 'a\nb', planEdits('a\nb', [edit('b', 'c')]))
    assert.equal(
      noEnd.diff,
      [
        '--- a/f',
        '+++ b/f',
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '\\ No newline at end of file',
        '+c',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )
    const crlf = unifiedDiff('f', 'a\r\nb\r\n', planEdits('a\r\nb\r\n', [edit('b', 'c')]))
    assert.ok(crlf.diff.includes('-b\r\n+c\r\n'))
  })

  test('a new file is all added lines, and a change that changes no line has no hunk', () => {
    const made = unifiedDiff('n.txt', undefined, [range(0, 0, 'a\nb')])
    assert.equal(
      made.diff,
      ['--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+a', '+b', '\\ No newline at end of file', ''].join('\n'),
    )
    assert.deepEqual([made.added, made.removed], [2, 0])
    const same = unifiedDiff('f', 'a\nb\n', planEdits('a\nb\n', [edit('b', 'b')]))
    assert.deepEqual([same.diff, same.added, same.removed], ['', 0, 0])
    const empty = unifiedDiff('e', undefined, [range(0, 0, '')])
    assert.equal(empty.diff, '--- /dev/null\n+++ b/e\n')
  })

  test('a whole replacement shows only the lines that differ', () => {
    const text = lines('a', 'b', 'c')
    const result = unifiedDiff('f', text, [range(0, text.length, lines('a', 'B', 'c'))])
    assert.deepEqual([result.added, result.removed], [1, 1])
  })

  test('a diff over the limit is cut at a line end, the counts stay whole', () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n')
    const result = unifiedDiff('big', undefined, [range(0, 0, body)])
    assert.equal(result.diffTruncated, true)
    assert.ok(result.diff.length <= LIMITS.diffChars && result.diff.endsWith('\n'))
    assert.equal(result.added, 20_000)
  })
})

describe('the policy of the change tools', () => {
  const on: Guards = { bridges: new Set<ServerKey>(), workspace: true }
  const rules = (...r: [string, 'allow' | 'deny' | 'ask'][]): Policy =>
    r.map(([match, action], index) => ({ match, action, index }))
  const EDIT = 'mcp__workspace__edit'
  const WRITE = 'mcp__workspace__write'

  test('edit and write ask by default, and no wildcard that skips the server name allows them', () => {
    assert.deepEqual(decide([], on, EDIT), { action: 'ask' })
    assert.deepEqual(decide([], on, WRITE), { action: 'ask' })
    for (const match of ['*', 'mcp__*', 'mcp__*__edit', 'mcp__work*', 'mcp__workspace*']) {
      assert.equal(decide(rules([match, 'allow']), on, EDIT).action, 'ask', match)
      assert.equal(decide(rules([match, 'allow']), on, WRITE).action, 'ask', match)
    }
    assert.equal(decide(rules(['mcp__workspace__*', 'allow']), on, EDIT).action, 'allow')
    assert.equal(decide(rules([EDIT, 'allow']), on, EDIT).action, 'allow')
    assert.equal(decide(rules([EDIT, 'allow']), on, WRITE).action, 'ask', 'the exact name allows that tool only')
    assert.equal(decide(rules([EDIT, 'deny'], ['mcp__workspace__*', 'allow']), on, EDIT).action, 'deny')
    assert.equal(decide(rules(['*', 'allow']), on, 'mcp__workspace__read').action, 'allow', 'a read tool is as before')
    assert.equal(decide(rules(['*', 'allow']), NO_GUARDS, EDIT).action, 'allow', 'a server named workspace is a server')
  })

  test('a name built at run time with no such rule is refused, an approved or allowed one is not', () => {
    const none = checkCall([], on, new Set(), EDIT, new Set())
    assert.equal(none.ok, false)
    assert.equal(!none.ok && none.needs, 'rule')
    assert.match(!none.ok ? none.error : '', /must start with mcp__workspace__/)
    assert.equal(checkCall(rules(['*', 'allow']), on, new Set(), EDIT, new Set()).ok, false)
    assert.equal(checkCall(rules(['mcp__*', 'allow']), on, new Set(), WRITE, new Set()).ok, false)
    assert.equal(checkCall([], on, new Set([EDIT]), EDIT, new Set()).ok, true, 'approved at the prompt')
    assert.equal(checkCall(rules(['mcp__workspace__*', 'allow']), on, new Set(), EDIT, new Set()).ok, true)
    assert.equal(checkCall(rules([EDIT, 'deny']), on, new Set([EDIT]), EDIT, new Set()).ok, false, 'a deny rule wins')
  })

  test('the plan asks for a written edit, and the prompt names the session root', () => {
    const calls = [
      { tool: EDIT, line: 1 },
      { tool: 'mcp__workspace__read', line: 2 },
    ]
    assert.deepEqual(planRun([], on, calls, new Set()), { kind: 'run', ask: [EDIT], interactive: [] })
    const text = askText({ ask: [EDIT, WRITE], interactive: [] }, 'return 1', on, { root: '/work/app' })
    assert.match(text, /mcp__workspace__edit/)
    assert.match(text, /mcp__workspace__write/)
    assert.match(text, /session root: \/work\/app/)
    assert.doesNotMatch(
      askText({ ask: ['mcp__x__y'], interactive: [] }, 'return 1', on, { root: '/work/app' }),
      /session root/,
    )
  })

  test('onlyTightens treats an allow rule that a change tool skips as one that a tool can skip', () => {
    const current = rules(['*', 'allow'], [EDIT, 'deny'])
    // Lowered to ask, `*` would now decide edit, which a deny rule decided before.
    assert.equal(onlyTightens(current, rules(['*', 'ask'], [EDIT, 'deny']), on), false)
    assert.equal(onlyTightens(current, rules(['*', 'ask'], [EDIT, 'deny']), NO_GUARDS), true)
    assert.equal(onlyTightens(current, rules(['*', 'deny'], [EDIT, 'deny']), on), true)
    // `mcp__workspace__*` matches no change tool by skipping it, but run_task (exec) skips it, so lowering it counts as looser.
    assert.equal(onlyTightens(rules(['mcp__workspace__*', 'allow']), rules(['mcp__workspace__*', 'ask']), on), false)
    assert.equal(onlyTightens(rules([EDIT, 'allow']), rules([EDIT, 'ask']), on), true)
    assert.equal(onlyTightens(rules([EDIT, 'ask']), rules([EDIT, 'allow']), on), false)
    assert.equal(onlyTightens(rules([EDIT, 'allow']), [], on), true, 'no rule is ask for a change tool')
  })

  test('one policy holds all three classes: read has no rule, write needs the server or the tool, exec needs its name', () => {
    const TASK = 'mcp__workspace__run_task'
    const wide = rules(['*', 'allow'], ['mcp__*', 'allow'])
    for (const name of [EDIT, WRITE, TASK]) assert.equal(decide(wide, on, name).action, 'ask', name)
    assert.equal(decide(wide, on, 'mcp__workspace__read').action, 'allow')
    const server = rules(['mcp__workspace__*', 'allow'])
    assert.deepEqual(
      [EDIT, WRITE, TASK].map(name => decide(server, on, name).action),
      ['allow', 'allow', 'ask'],
    )
    const exact = rules([TASK, 'allow'])
    assert.deepEqual(
      [EDIT, WRITE, TASK].map(name => decide(exact, on, name).action),
      ['ask', 'ask', 'allow'],
    )
    assert.deepEqual(
      [EDIT, TASK].map(name => decide(rules([name, 'allow']), on, name).action),
      ['allow', 'allow'],
    )
    const refused = checkCall(wide, on, new Set(), EDIT, new Set())
    assert.deepEqual([refused.ok, refused.ok ? '' : refused.needs], [false, 'rule'])
    assert.match(refused.ok ? '' : refused.error, /Workspace change tool must start with mcp__workspace__/)
  })
})

describe('unified diff of an edit that crosses a line boundary', () => {
  const run = (text: string, old: string, now: string) => {
    const edits = [{ old, new: now }]
    const ranges = planEdits(text, edits as Parameters<typeof planEdits>[1])
    const after = applyRanges(text, ranges)
    return { after, ...unifiedDiff('f.txt', text, ranges) }
  }
  // The lines of the new side of the hunks must be the lines of the new file.
  const newSide = (diff: string): string =>
    diff
      .split('\n')
      .filter(l => l.startsWith('+') || l.startsWith(' '))
      .filter(l => !l.startsWith('+++'))
      .map(l => l.slice(1))
      .join('\n')

  test('a join takes the next line into the change', () => {
    const r = run('a\nb\n', 'a\n', 'a')
    assert.equal(r.after, 'ab\n')
    assert.equal(r.diff, '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,1 @@\n-a\n-b\n+ab\n')
    assert.deepEqual([r.added, r.removed], [1, 2])
    assert.equal(newSide(r.diff), 'ab')
  })

  test('a split is one removed line and two added', () => {
    const r = run('ab\n', 'ab', 'a\nb')
    assert.equal(r.after, 'a\nb\n')
    assert.equal(r.diff, '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,2 @@\n-ab\n+a\n+b\n')
    assert.deepEqual([r.added, r.removed], [2, 1])
  })

  test('a join over CRLF line ends', () => {
    const r = run('a\r\nb\r\n', 'a\r\n', 'a')
    assert.equal(r.after, 'ab\r\n')
    assert.equal(r.diff, '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,1 @@\n-a\r\n-b\r\n+ab\r\n')
    assert.deepEqual([r.added, r.removed], [1, 2])
  })

  test('an edit at the end of a file with no final line end', () => {
    const r = run('a\nb', 'b', 'c')
    assert.equal(
      r.diff,
      '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n',
    )
    assert.deepEqual([r.added, r.removed], [1, 1])
    const j = run('a\nb', '\n', '')
    assert.equal(j.after, 'ab')
    assert.equal(
      j.diff,
      '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,1 @@\n-a\n-b\n\\ No newline at end of file\n+ab\n\\ No newline at end of file\n',
    )
  })

  test('a join that reaches the next edit merges the two', () => {
    const edits = [
      { old: 'a\n', new: 'a' },
      { old: 'b\n', new: 'B\n' },
    ]
    const ranges = planEdits('a\nb\nc\n', edits as Parameters<typeof planEdits>[1])
    const d = unifiedDiff('f.txt', 'a\nb\nc\n', ranges)
    assert.equal(applyRanges('a\nb\nc\n', ranges), 'aB\nc\n')
    assert.equal(d.diff, '--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,2 @@\n-a\n-b\n+aB\n c\n')
    assert.deepEqual([d.added, d.removed], [1, 2])
  })
})
