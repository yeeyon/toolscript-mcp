// The named tasks of the built-in Workspace (issue #144, pull request C): `run_task` on real temp trees, with real
// child processes (tests/task-child.mjs). Each fixture checks what the child saw (its argv and environment), the pids
// that are gone, and the times that the children wrote, never a success text. A task is NOT contained: no test claims it.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { getEventListeners } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  TASK_ENV_NAMES,
  TASK_LIMITS,
  argumentLine,
  commandProblem,
  cwdParts,
  isBareName,
  taskEnv,
  type TaskConfig,
} from '../src/core/task.ts'
import {
  COMMAND_LINE_MAX,
  decide,
  parseReport,
  posixFrame,
  prctlNumber,
  startCode,
  taskRefusal,
  windowsEnv,
  windowsFrame,
  type Report,
} from '../src/core/taskjob.ts'
import { perlPath, powershellPath } from '../src/host/taskjob.ts'
import { createTaskRunner, findOnPath, launchProblem, type ResolvedTask } from '../src/host/workspace/task.ts'
import { codeOf, open, rm, tempDir, trySymlink, write, type Rig, type RigOptions } from './workspace-rig.ts'

const win = process.platform === 'win32'
const mac = process.platform === 'darwin'
const CHILD = path.join(import.meta.dirname, 'task-child.mjs')

/** A task that runs the test child in `mode`. The command is the Node of this test, as an absolute path. */
const task = (name: string, args: readonly string[], over: Partial<TaskConfig> = {}): TaskConfig => ({
  name,
  command: process.execPath,
  args: [CHILD, ...args],
  cwd: [],
  timeoutSeconds: 30,
  env: {},
  ...over,
})

const folders = (t: TestContext) => {
  const dirs: string[] = []
  t.after(() => dirs.forEach(rm))
  return (): string => {
    const dir = tempDir()
    dirs.push(dir)
    return dir
  }
}

/** A rig over a new temp root with `tasks` in its entry. macOS may ship Workspace unavailable: then the test skips. */
const rigOf = async (
  t: TestContext,
  tasks: readonly TaskConfig[],
  options: RigOptions & { files?: Record<string, string> } = {},
): Promise<Rig | undefined> => {
  const root = folders(t)()
  write(root, options.files ?? {})
  const opened = await open(root, { ...options, tasks: { [root]: tasks } })
  if ('unavailable' in opened) {
    if (mac) return void t.skip(`Workspace is unavailable on macOS: ${opened.unavailable}`)
    assert.fail(`Workspace is unavailable: ${opened.unavailable}`)
  }
  t.after(() => opened.rig.close())
  return opened.rig
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits until `check` is true, at most `ms`. The deadline covers a start of the helper, which a loaded machine slows. */
const until = async (check: () => boolean, ms = 15_000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (check()) return true
  return check()
}

/** The pids that a `tree` child wrote, after its `ready` file exists. */
const treePids = async (dir: string): Promise<{ child: number; grand: number }> => {
  assert.ok(await until(() => fs.existsSync(path.join(dir, 'ready'))), 'the tree child did not start in time')
  return {
    child: Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8')),
    grand: Number(fs.readFileSync(path.join(dir, 'grand.pid'), 'utf8')),
  }
}

const gone = (...pids: number[]) => until(() => pids.every(p => !alive(p)))

describe('the pure rules of a task', () => {
  test('a command is an absolute path or a bare name, and nothing else', () => {
    assert.equal(commandProblem('node', false), undefined)
    assert.equal(commandProblem('/usr/bin/make', false), undefined)
    assert.equal(commandProblem('C:\\Program Files\\nodejs\\node.exe', true), undefined)
    assert.equal(commandProblem('\\\\server\\share\\tool.exe', true), undefined)
    for (const bad of ['./run.sh', 'bin/run', '../x', 'a\\b', 'a\nb'])
      assert.notEqual(commandProblem(bad, false), undefined, bad)
    for (const bad of ['C:node.exe', 'bin\\run.exe']) assert.notEqual(commandProblem(bad, true), undefined, bad)
    assert.equal(isBareName('node', false), true)
    assert.equal(isBareName('/usr/bin/node', false), false)
    assert.equal(isBareName('C:/x/node.exe', true), false)
  })

  test('a folder is a path inside the entry: `.` is the entry, and `..`, an absolute path and a backslash are refused', () => {
    assert.deepEqual(cwdParts('.', false), [])
    assert.deepEqual(cwdParts('packages/app', false), ['packages', 'app'])
    for (const bad of ['..', '../x', 'a/../b', '/abs', 'C:/x', 'a\\b', '', 'a//b', './a'])
      assert.equal(typeof cwdParts(bad, false), 'string', bad)
    assert.equal(typeof cwdParts('a:b', true), 'string')
  })

  test('Windows refuses a .cmd, .bat and .ps1 program with the reason that names node, and accepts .exe and .com', () => {
    for (const bad of ['C:/x/tool.cmd', 'C:/x/tool.BAT', 'C:/x/tool.ps1', 'C:/x/tool', 'C:/x/tool.exe.cmd']) {
      const reason = launchProblem(bad, 'win32')
      assert.match(reason ?? '', /on Windows its command must be an \.exe or \.com file/, bad)
      assert.match(reason ?? '', /"node" as the first argument|set "command" to "node"/, bad)
    }
    for (const good of ['C:/x/tool.exe', 'C:/x/TOOL.EXE', 'C:/x/tool.com'])
      assert.equal(launchProblem(good, 'win32'), undefined)
    assert.equal(launchProblem('/x/tool.cmd', 'linux'), undefined, 'the rule is for Windows')
  })

  test('the environment holds the listed variables only, and the task env comes on top', () => {
    const source = {
      PATH: '/bin',
      HOME: '/h',
      FAKE_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'x',
      LANG: 'C',
      SystemRoot: 'C:\\Windows',
    }
    assert.deepEqual(taskEnv(source, { CI: '1', LANG: 'en' }, false), { PATH: '/bin', HOME: '/h', LANG: 'en', CI: '1' })
    assert.deepEqual(taskEnv(source, {}, true), { PATH: '/bin', SystemRoot: 'C:\\Windows' })
    assert.deepEqual(taskEnv({ PATH: 'a' }, { path: 'b' }, true), { path: 'b' }, 'on Windows names ignore case')
    assert.deepEqual(taskEnv({ PATH: 'a' }, { path: 'b' }, false), { PATH: 'a', path: 'b' })
    for (const names of Object.values(TASK_ENV_NAMES)) assert.ok(names.includes('PATH'))
    assert.ok(
      !Object.values(TASK_ENV_NAMES)
        .flat()
        .some(n => /token|secret|key|pass/i.test(n)),
    )
  })
})

describe('finding a command on PATH', () => {
  const exe = (dir: string, name: string, mode = 0o755): string => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, 'not a real program')
    if (!win) fs.chmodSync(file, mode)
    return file
  }

  test('a bare name finds the first program on PATH, and a relative PATH entry is dropped', t => {
    const dir = folders(t)()
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    const name = win ? 'tool.exe' : 'tool'
    const first = exe(a, name)
    exe(b, name)
    const found = findOnPath('tool', { PATH: [a, b].join(path.delimiter) }, process.platform)
    assert.equal(found, path.join(fs.realpathSync.native(a), name))
    assert.equal(found, fs.realpathSync.native(first))
    assert.equal(
      findOnPath('tool', { PATH: ['a', b].join(path.delimiter) }, process.platform),
      path.join(fs.realpathSync.native(b), name),
    )
    assert.equal(findOnPath('missing-tool', { PATH: a }, process.platform), undefined)
    assert.equal(findOnPath('tool', {}, process.platform), undefined)
    const start = process.cwd()
    process.chdir(dir)
    try {
      assert.equal(
        findOnPath('tool', { PATH: ['a', b].join(path.delimiter) }, process.platform),
        path.join(fs.realpathSync.native(b), name),
        'a relative entry that exists in the start folder is dropped too',
      )
    } finally {
      process.chdir(start)
    }
  })

  test('outside Windows a file that is not executable is skipped, and a folder is no program', { skip: win }, t => {
    const dir = folders(t)()
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    fs.mkdirSync(path.join(a, 'folder'))
    exe(a, 'tool', 0o644)
    const second = exe(b, 'tool')
    assert.equal(
      findOnPath('tool', { PATH: `${a}${path.delimiter}${b}` }, process.platform),
      fs.realpathSync.native(second),
    )
    assert.equal(findOnPath('folder', { PATH: a }, process.platform), undefined)
  })

  test(
    'on Windows a name finds the first file of PATHEXT in PATH order, and a .cmd file is found, then refused',
    { skip: !win },
    t => {
      const dir = folders(t)()
      const a = path.join(dir, 'a')
      const b = path.join(dir, 'b')
      fs.mkdirSync(a)
      fs.mkdirSync(b)
      exe(a, 'tool.cmd')
      exe(b, 'tool.exe')
      const found = findOnPath('tool', { PATH: `${a};${b}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')
      assert.equal(found, path.join(fs.realpathSync.native(a), 'tool.cmd'), 'PATH order wins over PATHEXT order')
      assert.match(launchProblem(found!, 'win32') ?? '', /\.exe or \.com/)
      assert.equal(
        findOnPath('tool.exe', { PATH: `${a};${b}` }, 'win32'),
        path.join(fs.realpathSync.native(b), 'tool.exe'),
      )
    },
  )
})

describe('run_task: what is listed', () => {
  test('it is listed only when the entry has a valid task, with the names in its text and an enum', async t => {
    const none = await rigOf(t, [])
    if (none === undefined) return
    const without = (await none.client.listTools()).tools.map(x => x.name)
    assert.ok(!without.includes('run_task'))
    assert.match(await none.fail('run_task', { task: 'a' }), /^bad-input: unknown tool/)

    const some = await rigOf(t, [task('test', ['argv']), task('lint', ['argv'])])
    if (some === undefined) return
    const listed = (await some.client.listTools()).tools.find(x => x.name === 'run_task')
    assert.ok(listed)
    assert.match(listed.description ?? '', /Tasks: test, lint\.$/)
    assert.deepEqual((listed.inputSchema.properties as { task: { enum: string[] } }).task.enum, ['test', 'lint'])
    assert.equal(listed.annotations?.readOnlyHint, false)
    assert.deepEqual(some.bound.tasks, { names: ['test', 'lint'], invalid: [] })
  })

  test('a task that cannot run is not listed, and the call says why in our own words', async t => {
    const r = await rigOf(t, [
      task('ok', ['argv']),
      task('gone', ['argv'], { command: path.join(folders(t)(), 'missing') }),
    ])
    if (r === undefined) return
    assert.deepEqual(r.bound.tasks.names, ['ok'])
    assert.deepEqual(r.bound.tasks.invalid, [{ name: 'gone', reason: 'its command is not a file that exists' }])
    assert.match(
      await r.fail('run_task', { task: 'gone' }),
      /^bad-input: the task gone is invalid: its command is not a file that exists$/,
    )
    const all = await rigOf(t, [task('gone', ['argv'], { command: 'no-such-program-xyz' })])
    if (all === undefined) return
    assert.equal(all.bound.tasks.invalid[0]?.reason, 'its command was not found on PATH')
    assert.ok(!(await all.client.listTools()).tools.some(x => x.name === 'run_task'), 'no valid task, no tool')
  })

  test('a session whose entry has no task cannot run a task of another entry', async t => {
    const root = folders(t)()
    const other = path.join(root, 'other')
    const mine = path.join(root, 'mine')
    fs.mkdirSync(other)
    fs.mkdirSync(mine)
    const opened = await open(mine, {
      roots: [other, mine],
      tasks: { [other]: [task('secret-task', ['argv'])] },
      start: mine,
    })
    if ('unavailable' in opened) return void (mac ? t.skip(opened.unavailable) : assert.fail(opened.unavailable))
    t.after(() => opened.rig.close())
    const { rig } = opened
    assert.deepEqual(rig.bound.tasks, { names: [], invalid: [] })
    assert.ok(!(await rig.client.listTools()).tools.some(x => x.name === 'run_task'))
    assert.match(await rig.fail('run_task', { task: 'secret-task' }), /^bad-input: unknown tool/)
  })

  test('the tasks of the entry apply when the session root is a folder inside it, and the folder of a task is relative to the entry', async t => {
    const root = folders(t)()
    write(root, { 'sub/x.txt': 'x' })
    const sub = path.join(root, 'sub')
    const opened = await open(sub, {
      roots: [root],
      start: sub,
      tasks: { [root]: [task('where', ['cwd']), task('inner', ['cwd'], { cwd: ['sub'] })] },
    })
    if ('unavailable' in opened) return void (mac ? t.skip(opened.unavailable) : assert.fail(opened.unavailable))
    t.after(() => opened.rig.close())
    const { rig } = opened
    assert.equal(rig.bound.root, sub)
    assert.deepEqual(rig.bound.tasks.names, ['where', 'inner'])
    assert.equal(fs.realpathSync.native((await rig.call('run_task', { task: 'where' })).stdout), root)
    assert.equal(fs.realpathSync.native((await rig.call('run_task', { task: 'inner' })).stdout), sub)
  })
})

describe('run_task: what runs', () => {
  test('an unknown task is an error that lists the names, and nothing starts', async t => {
    const dir = folders(t)()
    const log = path.join(dir, 'stamp.log')
    const r = await rigOf(t, [task('real', ['stamp', log, '1']), task('other', ['argv'])])
    if (r === undefined) return
    for (const name of ['nope', '__proto__', 'constructor', 'REAL', '', 'real ']) {
      const message = await r.fail('run_task', { task: name })
      assert.equal(message, 'bad-input: unknown task. The tasks are: real, other', JSON.stringify(name))
    }
    assert.match(await r.fail('run_task', {}), /^bad-input: task must be a string/)
    assert.match(await r.fail('run_task', { task: 'real', extra: 1 }), /^bad-input: unknown argument/)
    await sleep(100)
    assert.equal(fs.existsSync(log), false, 'no child ran')
  })

  test('no shell: arguments with shell syntax reach the child exactly as given', async t => {
    const args = [
      'a && echo INJECTED',
      '$(id)',
      '%PATH%',
      '`id`',
      '"quoted" \'single\'',
      'a b  c',
      '; rm -rf x',
      '*',
      '',
      '$HOME',
      '|x',
      '>out.txt',
    ]
    const r = await rigOf(t, [task('argv', ['argv', ...args])])
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'argv' })
    assert.deepEqual(JSON.parse(out.stdout), args)
    assert.equal(out.exitCode, 0)
    assert.equal(fs.existsSync(path.join(r.root, 'out.txt')), false, 'a redirect was not parsed')
  })

  test('the model sends only the name: an extra argument that names a program or a folder is refused', async t => {
    const r = await rigOf(t, [task('argv', ['argv'])])
    if (r === undefined) return
    for (const extra of [{ command: 'calc' }, { args: ['x'] }, { cwd: '..' }, { env: { A: '1' } }, { shell: true }])
      assert.match(await r.fail('run_task', { task: 'argv', ...extra }), /^bad-input: unknown argument/)
  })

  test('the child gets the listed variables and the task env, and no other variable of the server', async t => {
    const fake = `FAKE-${randomBytes(8).toString('hex')}`
    process.env.FAKE_TOKEN = fake
    t.after(() => void delete process.env.FAKE_TOKEN)
    const r = await rigOf(t, [task('env', ['env'], { env: { CI: '1', FROM_TASK: 'yes' } })])
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'env' })
    const seen = JSON.parse(out.stdout) as Record<string, string>
    assert.ok(!out.stdout.includes(fake), 'the value of FAKE_TOKEN is in no variable')
    assert.equal(seen.FAKE_TOKEN, undefined)
    assert.equal(seen.CI, '1')
    assert.equal(seen.FROM_TASK, 'yes')
    assert.ok(seen.PATH !== undefined, 'PATH reaches the child')
    const listed = new Set(
      Object.values(TASK_ENV_NAMES)
        .flat()
        .map(n => n.toLowerCase()),
    )
    const extra = Object.keys(seen).filter(k => !listed.has(k.toLowerCase()) && k !== 'CI' && k !== 'FROM_TASK')
    // The system adds a few variables to each process: on Windows the current folders of drives (`=C:`) and the
    // defaults of an account (`LOGONSERVER`, `USERDOMAIN`), and on macOS `__CF_USER_TEXT_ENCODING`.
    const system = /^(=|__CF|LOGONSERVER$|USERDOMAIN)/
    // macOS adds the marker TOOLSCRIPT_TASK by design, with 32 hex characters, and no other OS adds it.
    assert.deepEqual(
      extra.filter(k => !system.test(k) && !(mac && k === 'TOOLSCRIPT_TASK')),
      [],
    )
    assert.equal('TOOLSCRIPT_TASK' in seen, mac)
    if (mac) assert.match(seen.TOOLSCRIPT_TASK!, /^[0-9a-f]{32}$/)
  })

  test('a non-zero exit code is data, with stdout and stderr apart', async t => {
    const r = await rigOf(t, [task('fail', ['exit', '3'])])
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'fail' })
    assert.deepEqual(
      { ...out, ms: typeof out.ms },
      {
        task: 'fail',
        exitCode: 3,
        signal: null,
        timedOut: false,
        ms: 'number',
        stdout: 'out',
        stderr: 'err',
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    )
  })

  test('the child runs in the folder of the task, with its own cwd and no input', async t => {
    const r = await rigOf(t, [task('cwd', ['cwd'], { cwd: ['sub'] })], { files: { 'sub/a.txt': 'a' } })
    if (r === undefined) return
    assert.equal((await r.call('run_task', { task: 'cwd' })).stdout, path.join(r.root, 'sub'))
  })

  test('output over the cap keeps the head and the tail, and sets the flags', async t => {
    const total = 600 * 1024
    const r = await rigOf(t, [task('flood', ['flood', String(total)]), task('small', ['flood', '100'])])
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'flood' })
    for (const [text, flag] of [
      [out.stdout, out.stdoutTruncated],
      [out.stderr, out.stderrTruncated],
    ] as const) {
      assert.equal(flag, true)
      assert.ok(text.startsWith('HEAD'), 'the head is kept')
      assert.ok(text.endsWith('TAIL'), 'the tail is kept')
      const cut = total - TASK_LIMITS.headBytes - TASK_LIMITS.tailBytes
      assert.ok(text.includes(`… [${cut} bytes cut] …`), 'the note says how much was cut')
      assert.equal(
        Buffer.byteLength(text),
        TASK_LIMITS.headBytes + TASK_LIMITS.tailBytes + Buffer.byteLength(`\n… [${cut} bytes cut] …\n`),
      )
    }
    const small = await r.call('run_task', { task: 'small' })
    assert.deepEqual([small.stdoutTruncated, small.stderrTruncated, small.stdout.length], [false, false, 100])
    assert.ok(small.stdout.startsWith('HEAD') && small.stdout.endsWith('TAIL'))
  })

  test('two calls at once do not overlap: the second starts after the first ended', async t => {
    const dir = folders(t)()
    const log = path.join(dir, 'stamp.log')
    const r = await rigOf(t, [task('slow', ['stamp', log, '400'])])
    if (r === undefined) return
    const [a, b] = await Promise.all([r.call('run_task', { task: 'slow' }), r.call('run_task', { task: 'slow' })])
    assert.deepEqual([a.exitCode, b.exitCode], [0, 0])
    const lines = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(l => l.split(' '))
    assert.deepEqual(
      lines.map(l => l[0]),
      ['start', 'end', 'start', 'end'],
      'the second started after the first ended',
    )
    const times = lines.map(l => Number(l[1]))
    assert.ok(times[2]! >= times[1]!, `${times}`)
  })

  test('a call that is cancelled while it waits for its turn starts nothing and does not hold up the next', async t => {
    const dir = folders(t)()
    const log = path.join(dir, 'stamp.log')
    const r = await rigOf(t, [task('slow', ['stamp', log, '500'])])
    if (r === undefined) return
    const first = r.call('run_task', { task: 'slow' })
    await until(() => fs.existsSync(log))
    const controller = new AbortController()
    const waiting = r.call('run_task', { task: 'slow' }, controller.signal)
    await sleep(100)
    controller.abort()
    await assert.rejects(waiting)
    const third = r.call('run_task', { task: 'slow' })
    await Promise.all([first, third])
    assert.deepEqual(
      fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(l => l.split(' ')[0]),
      ['start', 'end', 'start', 'end'],
      'the cancelled call ran nothing, and the third ran after the first',
    )
    assert.ok(await until(() => r.bound.provider.inFlight() === 0))
  })
})

describe('run_task: the end of a task and its tree', () => {
  test('a timeout gives timedOut, and the child and the grandchild it started are gone', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('hang', ['tree', dir], { timeoutSeconds: 1 })])
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'hang' })
    assert.equal(out.timedOut, true)
    assert.equal(out.exitCode, null)
    assert.ok(out.ms >= 900 && out.ms < 15_000, `${out.ms} ms`)
    const pids = await treePids(dir)
    assert.ok(await gone(pids.child, pids.grand), `child ${alive(pids.child)}, grandchild ${alive(pids.grand)}`)
  })

  test('a cancel of the call ends the tree, and the call fails with cancelled', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('hang', ['tree', dir])])
    if (r === undefined) return
    const controller = new AbortController()
    const call = r.call('run_task', { task: 'hang' }, controller.signal)
    const pids = await treePids(dir)
    assert.ok(alive(pids.child) && alive(pids.grand), 'both run before the cancel')
    controller.abort()
    await assert.rejects(call)
    assert.ok(await gone(pids.child, pids.grand), `child ${alive(pids.child)}, grandchild ${alive(pids.grand)}`)
    assert.ok(await until(() => r.bound.provider.inFlight() === 0), 'the handler of the call ended')
    // The next task runs: the cancelled one released its turn.
    assert.ok(r.bound.tasks.names.includes('hang'))
  })

  test('a shutdown ends the tree, and a later call is refused', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('hang', ['tree', dir]), task('after', ['argv'])])
    if (r === undefined) return
    const call = r.client.callTool({ name: 'run_task', arguments: { task: 'hang' } })
    const pids = await treePids(dir)
    await r.bound.provider.stopTasks()
    assert.ok(await gone(pids.child, pids.grand), `child ${alive(pids.child)}, grandchild ${alive(pids.grand)}`)
    const result = await call
    assert.equal(result.isError, true)
    assert.match((result.content as { text: string }[])[0]!.text, /^cancelled:/)
    assert.match(await r.fail('run_task', { task: 'after' }), /^cancelled: Workspace is closing/)
  })

  test('closing the provider ends the tree too', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('hang', ['tree', dir])])
    if (r === undefined) return
    const call = r.client.callTool({ name: 'run_task', arguments: { task: 'hang' } }).catch(() => undefined)
    const pids = await treePids(dir)
    await r.bound.provider.close()
    assert.ok(await gone(pids.child, pids.grand))
    await call
  })

  test('a process that the task leaves behind in its group or its job does not stay, and the call still returns', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('leaver', ['leaver', dir])])
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'leaver' })
    const grand = Number(fs.readFileSync(path.join(dir, 'grand.pid'), 'utf8'))
    try {
      assert.equal(out.exitCode, 0)
      assert.equal(out.timedOut, false)
      assert.ok(out.ms < 15_000, `${out.ms} ms`)
      assert.ok(await gone(grand), 'the grandchild is gone')
    } finally {
      try {
        process.kill(grand, 'SIGKILL')
      } catch {}
    }
  })
})

describe('run_task: the folder of a task', () => {
  const link = (target: string, at: string): boolean => trySymlink(target, at, win ? 'junction' : 'dir')

  test('a folder that is a link, a missing folder and an excluded folder make the task invalid, with a reason', async t => {
    const outside = folders(t)()
    const root = folders(t)()
    write(root, { 'real/a.txt': 'a', '.git/config': 'x' })
    fs.mkdirSync(path.join(outside, 'x'))
    const linked = link(outside, path.join(root, 'linked'))
    if (!linked) t.diagnostic('this system refuses to make a symlink: the link case is skipped')
    const opened = await open(root, {
      tasks: {
        [root]: [
          task('ok', ['argv'], { cwd: ['real'] }),
          task('missing', ['argv'], { cwd: ['nope'] }),
          task('git', ['argv'], { cwd: ['.git'] }),
          ...(linked
            ? [task('linked', ['argv'], { cwd: ['linked'] }), task('through', ['argv'], { cwd: ['linked', 'x'] })]
            : []),
        ],
      },
    })
    if ('unavailable' in opened) return void (mac ? t.skip(opened.unavailable) : assert.fail(opened.unavailable))
    t.after(() => opened.rig.close())
    const { bound } = opened.rig
    assert.deepEqual(bound.tasks.names, ['ok'])
    const reasons = Object.fromEntries(bound.tasks.invalid.map(x => [x.name, x.reason]))
    assert.equal(reasons.missing, 'its cwd is not a folder that exists inside the root entry')
    assert.equal(reasons.git, 'its cwd is an excluded folder')
    if (linked) {
      assert.equal(reasons.linked, 'its cwd goes through a link, and a task never follows one')
      assert.equal(reasons.through, 'its cwd goes through a link, and a task never follows one')
    }
    for (const reason of Object.values(reasons)) assert.ok(!reason.includes(root) && !reason.includes(outside))
  })

  test('a folder swapped for a link after the start is caught at the run, and nothing starts', async t => {
    const outside = folders(t)()
    const root = folders(t)()
    const dir = folders(t)()
    const log = path.join(dir, 'stamp.log')
    write(root, { 'work/a.txt': 'a' })
    const opened = await open(root, { tasks: { [root]: [task('stamp', ['stamp', log, '1'], { cwd: ['work'] })] } })
    if ('unavailable' in opened) return void (mac ? t.skip(opened.unavailable) : assert.fail(opened.unavailable))
    t.after(() => opened.rig.close())
    const { rig } = opened
    assert.equal((await rig.call('run_task', { task: 'stamp' })).exitCode, 0)
    fs.rmSync(path.join(root, 'work'), { recursive: true })
    if (!link(outside, path.join(root, 'work'))) return void t.skip('this system refuses to make a symlink')
    const before = fs.readFileSync(log, 'utf8')
    assert.equal(codeOf(await rig.fail('run_task', { task: 'stamp' })), 'link')
    await sleep(100)
    assert.equal(fs.readFileSync(log, 'utf8'), before, 'the second call started no child')
  })
})

describe('run_task: finding the program', () => {
  test('a bare name is resolved on the PATH of the server one time, at the start', async t => {
    const folder = path.dirname(process.execPath)
    const name = path.basename(process.execPath, win ? '.exe' : '')
    const system = { SystemRoot: process.env.SystemRoot }
    const r = await rigOf(t, [task('bare', ['argv', 'x'], { command: name, args: [CHILD, 'argv', 'x'] })], {
      env: { PATH: folder, ...system },
    })
    if (r === undefined) return
    assert.deepEqual(r.bound.tasks.names, ['bare'])
    assert.deepEqual(JSON.parse((await r.call('run_task', { task: 'bare' })).stdout), ['x'])
    const missing = await rigOf(t, [task('bare', ['argv'], { command: name })], {
      env: { PATH: path.join(tempDir(), 'empty') },
    })
    if (missing === undefined) return
    assert.equal(missing.bound.tasks.invalid[0]?.reason, 'its command was not found on PATH')
  })

  test(
    'on Windows a command that is a .cmd, .bat or .ps1 file makes the task invalid, and node with the script is the way',
    { skip: !win },
    async t => {
      const dir = folders(t)()
      for (const ext of ['cmd', 'bat', 'ps1']) fs.writeFileSync(path.join(dir, `tool.${ext}`), 'echo no')
      const r = await rigOf(
        t,
        [
          task('cmd', ['argv'], { command: path.join(dir, 'tool.cmd') }),
          task('bat', ['argv'], { command: path.join(dir, 'tool.bat') }),
          task('ps1', ['argv'], { command: path.join(dir, 'tool.ps1') }),
          task('bare', ['argv'], { command: 'tool' }),
          task('node', ['argv', 'ok']),
        ],
        { env: { PATH: `${dir};${path.dirname(process.execPath)}`, PATHEXT: '.CMD;.EXE' } },
      )
      if (r === undefined) return
      assert.deepEqual(r.bound.tasks.names, ['node'])
      assert.equal(r.bound.tasks.invalid.length, 4)
      for (const { reason } of r.bound.tasks.invalid)
        assert.match(reason, /on Windows its command must be an \.exe or \.com file/)
    },
  )

  test('outside Windows a file without the execute bit makes the task invalid', { skip: win }, async t => {
    const dir = folders(t)()
    const file = path.join(dir, 'tool')
    fs.writeFileSync(file, '#!/bin/sh\n')
    fs.chmodSync(file, 0o644)
    const r = await rigOf(t, [task('plain', ['argv'], { command: file })])
    if (r === undefined) return
    assert.equal(r.bound.tasks.invalid[0]?.reason, 'its command is not executable')
  })
})

describe('run_task: the cut of the output', () => {
  test('the head and the tail are cut on character borders, so no replacement character appears', async t => {
    const r = await rigOf(t, [task('wide', ['utf8', String(300 * 1024)])])
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'wide' })
    assert.equal(out.stdoutTruncated, true)
    assert.ok(!out.stdout.includes('�'), 'no split character')
    assert.ok(out.stdout.startsWith('aé') && out.stdout.endsWith('éb'))
    const cut = /… \[(\d+) bytes cut\] …/.exec(out.stdout)
    const kept = Buffer.byteLength(out.stdout) - Buffer.byteLength(`\n… [${cut![1]} bytes cut] …\n`)
    assert.equal(kept + Number(cut![1]), 1 + 2 * 300 * 1024 + 1, 'the note counts every byte that is not shown')
  })
})

describe('run_task: a cancel or a shutdown during the proof of the folder', () => {
  const slowProof = (name: string, cwd: string): ResolvedTask => ({
    name,
    file: process.execPath,
    args: [CHILD, 'stamp', path.join(cwd, 'stamp.txt'), '30000'],
    cwd,
    timeoutMs: 60_000,
    env: { ...process.env } as Record<string, string>,
    proveCwd: () => sleep(200),
  })

  test('a cancel at 100 ms starts no child', async t => {
    const dir = folders(t)()
    const runner = createTaskRunner({ valid: [slowProof('slow', dir)], invalid: [] })
    t.after(() => runner.stop())
    const controller = new AbortController()
    const call = runner.run('slow', controller.signal)
    await sleep(100)
    controller.abort()
    await assert.rejects(call, /cancelled/)
    await sleep(500)
    assert.equal(fs.existsSync(path.join(dir, 'stamp.txt')), false, 'the child never started')
  })

  test('a shutdown at 100 ms starts no child', async t => {
    const dir = folders(t)()
    const runner = createTaskRunner({ valid: [slowProof('slow', dir)], invalid: [] })
    const call = runner.run('slow', new AbortController().signal)
    call.catch(() => {})
    await sleep(100)
    await runner.stop()
    await assert.rejects(call, /closing/)
    await sleep(500)
    assert.equal(fs.existsSync(path.join(dir, 'stamp.txt')), false, 'the child never started')
  })
})

/** A task that is already resolved, run by `createTaskRunner` with no rig. */
const resolved = (
  dir: string,
  name: string,
  args: readonly string[],
  over: Partial<ResolvedTask> = {},
): ResolvedTask => ({
  name,
  file: process.execPath,
  args: [CHILD, ...args],
  cwd: dir,
  timeoutMs: 30_000,
  env: { ...process.env } as Record<string, string>,
  proveCwd: async () => {},
  ...over,
})

describe('the command line of a task on Windows', () => {
  test('argumentLine quotes by the rule of libuv', () => {
    const table: [string, string][] = [
      ['a', 'a'],
      ['', '""'],
      ['a b', '"a b"'],
      ['hello"world', '"hello\\"world"'],
      ['hello\\world', 'hello\\world'],
      ['hello\\"world', '"hello\\\\\\"world"'],
      ['hello world\\', '"hello world\\\\"'],
      ['C:\\Program Files\\x\\', '"C:\\Program Files\\x\\\\"'],
      ['é 日本語', '"é 日本語"'],
      ['a\tb', '"a\tb"'],
    ]
    for (const [arg, line] of table) assert.equal(argumentLine([arg]), line, JSON.stringify(arg))
    assert.equal(argumentLine(['a', '', 'b c']), 'a "" "b c"')
    assert.equal(argumentLine([]), '')
  })

  test('the arguments come back as given through the real command line parser', { skip: !win }, async t => {
    const args = [
      '',
      'a b',
      'a"b',
      'trailing\\',
      'a\\\\"b',
      'é 日本語 ü',
      'a && echo x',
      '%PATH%',
      '$(whoami)',
      '`',
      ';',
      "'x'",
      '*.ts',
      'C:\\Program Files\\x\\',
      'tab\there',
    ]
    const r = await rigOf(t, [task('argv', ['argv', ...args])])
    if (r === undefined) return
    assert.deepEqual(JSON.parse((await r.call('run_task', { task: 'argv' })).stdout), args)
  })

  test('a command line over the limit is the start error, and nothing starts', { skip: !win }, async t => {
    const dir = folders(t)()
    const long = Array.from({ length: 9 }, () => 'x'.repeat(4000))
    const runner = createTaskRunner({ valid: [resolved(dir, 'long', ['argv', ...long])], invalid: [] })
    t.after(() => runner.stop())
    await assert.rejects(
      runner.run('long', new AbortController().signal),
      (e: Error) => e.message === 'io: the task could not start (ENAMETOOLONG)',
    )
  })
})

describe('the reports of the helpers, and what is decided from them', () => {
  test('each line of a helper is one report, and nothing else is', () => {
    assert.deepEqual(parseReport('ready'), { kind: 'ready' })
    assert.deepEqual(parseReport('begin'), { kind: 'begin' })
    assert.deepEqual(parseReport('started'), { kind: 'started', pid: undefined })
    assert.deepEqual(parseReport('started:4242'), { kind: 'started', pid: 4242 })
    assert.deepEqual(parseReport('error:2'), { kind: 'error', code: 2 })
    assert.deepEqual(parseReport('exit:255'), { kind: 'exit', code: 255 })
    assert.deepEqual(parseReport('exit:3221225786'), { kind: 'exit', code: 3221225786 })
    assert.deepEqual(parseReport('signal:15'), { kind: 'signal', signal: 15 })
    assert.deepEqual(parseReport('stopped'), { kind: 'stopped' })
    assert.deepEqual(parseReport('left:3'), { kind: 'left', count: 3 })
    assert.deepEqual(parseReport('failed:job'), { kind: 'failed', step: 'job' })
    for (const bad of [
      '',
      'Begin',
      'failed:',
      'failed:C:\\secret',
      'error:ENOENT',
      'error:-1',
      'exit:',
      'exit:1 ',
      'signal:x',
      'started ',
      'started:x',
      'ps -ax output',
    ])
      assert.equal(parseReport(bad), undefined, bad)
  })

  test('the decision reads the reports only: no begin is a fallback, a lost helper is an error, never a second start', () => {
    const r = (...text: string[]): Report[] => text.map(t => parseReport(t)!)
    const table: [string[], ReturnType<typeof decide>][] = [
      [[], { kind: 'fallback', step: 'ended' }],
      [['ready'], { kind: 'fallback', step: 'ended' }],
      [['failed:job'], { kind: 'fallback', step: 'job' }],
      [['error:2'], { kind: 'start-error', code: 2 }],
      [['begin', 'error:13'], { kind: 'start-error', code: 13 }],
      [['begin', 'started:7', 'exit:0'], { kind: 'exit', code: 0 }],
      [['begin', 'started:7', 'exit:255', 'left:2'], { kind: 'exit', code: 255 }],
      [['begin', 'started:7', 'signal:15'], { kind: 'signal', signal: 15 }],
      [['begin', 'started:7', 'stopped'], { kind: 'stopped' }],
      [['begin'], { kind: 'lost' }],
      [['begin', 'started:7'], { kind: 'lost' }],
      [['begin', 'failed:assign'], { kind: 'lost' }],
    ]
    for (const [lines, expected] of table) assert.deepEqual(decide(r(...lines)), expected, lines.join(' '))
  })

  test('the start error numbers map to the Node codes, and the rest is error', () => {
    for (const [n, code] of [
      [2, 'ENOENT'],
      [3, 'ENOENT'],
      [5, 'EPERM'],
      [87, 'EINVAL'],
      [206, 'ENAMETOOLONG'],
      [13, 'error'],
    ] as const)
      assert.equal(startCode(true, n), code, `win ${n}`)
    for (const [n, code] of [
      [2, 'ENOENT'],
      [13, 'EACCES'],
      [8, 'ENOEXEC'],
      [7, 'E2BIG'],
      [20, 'ENOTDIR'],
      [87, 'error'],
    ] as const)
      assert.equal(startCode(false, n), code, `posix ${n}`)
  })

  test('the prctl number is a table of the machine type', () => {
    assert.equal(prctlNumber('linux', 'x64'), 157)
    assert.equal(prctlNumber('linux', 'arm64'), 167)
    assert.equal(prctlNumber('linux', 'ia32'), undefined)
    assert.equal(prctlNumber('darwin', 'arm64'), 0)
    assert.equal(prctlNumber('freebsd', 'x64'), undefined)
  })

  test('a NUL anywhere, or a Windows command line over the limit, is refused with nothing cut', () => {
    const base = { file: '/bin/x', line: '', args: ['a'], env: { A: 'b' } }
    assert.equal(taskRefusal(base, false), undefined)
    assert.equal(taskRefusal({ ...base, file: 'a\0b' }, false), 'EINVAL')
    assert.equal(taskRefusal({ ...base, args: ['a\0'] }, false), 'EINVAL')
    assert.equal(taskRefusal({ ...base, env: { 'A\0': 'b' } }, false), 'EINVAL')
    assert.equal(taskRefusal({ ...base, env: { A: '\0' } }, true), 'EINVAL')
    const long = 'x'.repeat(COMMAND_LINE_MAX)
    assert.equal(taskRefusal({ ...base, line: long }, true), 'ENAMETOOLONG')
    assert.equal(taskRefusal({ ...base, line: long }, false), undefined, 'the limit is the one of Windows')
  })

  test('the Windows environment is the task env plus the required names, sorted with letter case ignored', () => {
    const server = {
      SystemRoot: 'C:\\Windows',
      USERDOMAIN: 'D',
      LOGONSERVER: '\\\\L',
      path: 'p',
      Other: 'no',
      TEMP: 't',
    }
    assert.deepEqual(windowsEnv({ Zed: '1', abc: '2' }, server), [
      ['abc', '2'],
      ['LOGONSERVER', '\\\\L'],
      ['path', 'p'],
      ['SystemRoot', 'C:\\Windows'],
      ['TEMP', 't'],
      ['USERDOMAIN', 'D'],
      ['Zed', '1'],
    ])
    // A task variable of another letter case stands in for the required name, and no second one is added.
    assert.deepEqual(windowsEnv({ Path: 'mine', USERDOMAIN: '' }, { PATH: 'server', USERDOMAIN: 'D' }), [
      ['Path', 'mine'],
      ['USERDOMAIN', ''],
    ])
  })

  test('the frames hold the length and the fields, and a name or value with an unusual byte passes', () => {
    const win = windowsFrame({ file: 'f', line: 'l', cwd: 'c', out: 'o', err: 'e' }, [['N', 'é']])
    const body = Buffer.from(win.subarray(4)).toString('utf8')
    assert.equal(Buffer.from(win).readUInt32LE(0), win.length - 4)
    assert.deepEqual(body.split('\0'), ['f', 'l', 'c', 'o', 'e', 'N', 'é'])
    const posix = posixFrame({ A: 'b=c', PERL5OPT: '-e1' })
    assert.equal(Buffer.from(posix).readUInt32BE(0), posix.length - 4)
    assert.deepEqual(Buffer.from(posix.subarray(4)).toString('utf8').split('\0'), ['A=b=c', 'PERL5OPT=-e1'])
    assert.equal(Buffer.from(posixFrame({})).readUInt32BE(0), 0)
  })

  test('perl is /usr/bin/perl, a file, or nothing', { skip: win }, () => {
    const found = perlPath()
    assert.ok(found === undefined || found === '/usr/bin/perl')
  })

  test('PowerShell is the system file of Windows PowerShell, from SystemRoot, or nothing', { skip: !win }, () => {
    assert.match(powershellPath() ?? '', /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
    assert.equal(powershellPath({ SystemRoot: 'C:\\no\\such\\root' }), undefined)
    assert.equal(powershellPath({}), undefined)
    assert.equal(powershellPath({ SystemRoot: 'relative' }), undefined)
  })
})

describe('run_task: the exit and the start through the runner', () => {
  test('the exit code of the task is the exitCode, with no signal and no timeout', async t => {
    const dir = folders(t)()
    const codes = [0, 1, 3, 255]
    const runner = createTaskRunner({
      valid: codes.map(n => resolved(dir, `exit${n}`, ['exit', String(n)])),
      invalid: [],
    })
    t.after(() => runner.stop())
    for (const n of codes) {
      const out = await runner.run(`exit${n}`, new AbortController().signal)
      assert.deepEqual([out.exitCode, out.signal, out.timedOut, out.stdout, out.stderr], [n, null, false, 'out', 'err'])
    }
  })

  test('a program that is gone is the start error with ENOENT, and no helper failure', async t => {
    const dir = folders(t)()
    const notes: string[] = []
    const file = path.join(dir, 'removed.exe')
    const runner = createTaskRunner(
      { valid: [resolved(dir, 'gone', [], { file })], invalid: [] },
      { note: l => notes.push(l) },
    )
    t.after(() => runner.stop())
    await assert.rejects(
      runner.run('gone', new AbortController().signal),
      (e: Error) => e.message === 'io: the task could not start (ENOENT)',
    )
    assert.deepEqual(notes, [], 'a program that is gone is no failure of the helper')
  })

  test('a folder with a space and a letter outside ASCII is the folder of the task', async t => {
    const r = await rigOf(t, [task('where', ['cwd'], { cwd: ['sub dir é'] })], { files: { 'sub dir é/x.txt': '' } })
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'where' })
    assert.equal(out.stdout, path.join(r.root, 'sub dir é'))
  })

  test(
    'on Windows a PSModulePath of the task is kept, and PowerShell adds none of its own',
    { skip: !win },
    async t => {
      const r = await rigOf(t, [
        task('own', ['env'], { env: { PSModulePath: 'mine', Mixed_Case_1: 'ok' } }),
        task('none', ['env']),
      ])
      if (r === undefined) return
      const own = JSON.parse((await r.call('run_task', { task: 'own' })).stdout) as Record<string, string>
      assert.equal(own.PSModulePath, 'mine')
      assert.equal(own.Mixed_Case_1, 'ok')
      const none = JSON.parse((await r.call('run_task', { task: 'none' })).stdout) as Record<string, string>
      assert.deepEqual(
        Object.keys(none).filter(k => /^(PSModulePath|TS_.*)$/i.test(k)),
        [],
        'no variable of the helper, and no PSModulePath that PowerShell added',
      )
    },
  )
})

describe('run_task: the environment through the helper is the one of a direct spawn', () => {
  /** The names and values that the child sees, for a runner with the helper and one with none. */
  const both = async (
    t: TestContext,
    env: Record<string, string>,
  ): Promise<[Record<string, string>, Record<string, string>]> => {
    const dir = folders(t)()
    const seen: Record<string, string>[] = []
    for (const helper of [undefined, false as const]) {
      const runner = createTaskRunner(
        { valid: [resolved(dir, 'env', ['env'], { env })], invalid: [] },
        helper === undefined ? {} : { helper },
      )
      t.after(() => runner.stop())
      seen.push(JSON.parse((await runner.run('env', new AbortController().signal)).stdout))
    }
    return [seen[0]!, seen[1]!]
  }

  test(
    'a task env without USERDOMAIN and LOGONSERVER gets the same block as a direct spawn',
    { skip: !win },
    async t => {
      const { USERDOMAIN, LOGONSERVER, ...env } = process.env as Record<string, string>
      void USERDOMAIN
      void LOGONSERVER
      const [helper, direct] = await both(t, env)
      assert.deepEqual(helper, direct)
    },
  )

  test(
    'a task env that sets Path in another letter case keeps it, and no second PATH is added',
    { skip: !win },
    async t => {
      const { Path, PATH, ...rest } = process.env as Record<string, string>
      const [helper, direct] = await both(t, { ...rest, pAtH: Path ?? PATH ?? '' })
      assert.deepEqual(helper, direct)
      assert.equal(Object.keys(helper).filter(k => k.toUpperCase() === 'PATH').length, 1)
    },
  )

  test(
    'on POSIX PERL5OPT of the task reaches the task and not the helper, and the env is the given one',
    { skip: win },
    async t => {
      const env = { ...(process.env as Record<string, string>), PERL5OPT: '-Mstrict -e1', EMPTY: '', 'X Y': 'v=1 é' }
      const [helper, direct] = await both(t, env)
      assert.equal(helper.PERL5OPT, '-Mstrict -e1')
      const { TOOLSCRIPT_TASK: marker, ...rest } = helper
      void marker
      assert.deepEqual(rest, direct)
      assert.equal('TOOLSCRIPT_TASK' in helper, mac, 'only macOS adds the marker')
      assert.match(helper.TOOLSCRIPT_TASK ?? '00000000000000000000000000000000', /^[0-9a-f]{32}$/)
    },
  )
})

describe('run_task: a process whose parent exited ends with the task', () => {
  /** The pid of the grandchild, after the top process wrote `ready`. The test kills it at the end if the task did not. */
  const orphan = async (t: TestContext, dir: string): Promise<number> => {
    assert.ok(await until(() => fs.existsSync(path.join(dir, 'ready')), 15_000), 'the orphan child did not get ready')
    const pid = Number(fs.readFileSync(path.join(dir, 'grand.pid'), 'utf8'))
    t.after(() => {
      try {
        process.kill(pid)
      } catch {}
    })
    return pid
  }

  test('the time limit', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('orphan', ['orphan', dir, 'stay'], { timeoutSeconds: 3 })])
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'orphan' })
    assert.equal(out.timedOut, true)
    const grand = await orphan(t, dir)
    assert.ok(await gone(grand), 'the grandchild is gone')
  })

  test('a cancel of the call', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('orphan', ['orphan', dir, 'stay'])])
    if (r === undefined) return
    const controller = new AbortController()
    const call = r.call('run_task', { task: 'orphan' }, controller.signal)
    const grand = await orphan(t, dir)
    assert.ok(alive(grand), 'the grandchild runs before the cancel')
    controller.abort()
    await assert.rejects(call)
    assert.ok(await gone(grand), 'the grandchild is gone')
  })

  test('a shutdown', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('orphan', ['orphan', dir, 'stay'])])
    if (r === undefined) return
    const call = r.client.callTool({ name: 'run_task', arguments: { task: 'orphan' } })
    const grand = await orphan(t, dir)
    await r.bound.provider.stopTasks()
    assert.ok(await gone(grand), 'the grandchild is gone')
    assert.equal((await call).isError, true)
  })

  test('the normal exit of the top process', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('orphan', ['orphan', dir, 'exit'])])
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'orphan' })
    assert.deepEqual([out.exitCode, out.timedOut], [0, false])
    const grand = await orphan(t, dir)
    assert.ok(await gone(grand), 'the grandchild is gone')
  })

  test('a detached child of a living parent, as Playwright starts a browser, ends at a cancel', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('live', ['live', dir])])
    if (r === undefined) return
    const controller = new AbortController()
    const call = r.call('run_task', { task: 'live' }, controller.signal)
    const grand = await orphan(t, dir)
    assert.ok(alive(grand), 'the detached child runs before the cancel')
    controller.abort()
    await assert.rejects(call)
    assert.ok(await gone(grand, Number(fs.readFileSync(path.join(dir, 'top.pid'), 'utf8'))), 'both are gone')
  })

  test('a daemon that is an Apple or system program (/bin/sleep) whose parent exited', { skip: win }, async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('apple', ['orphan', dir, 'exit', 'apple'])])
    if (r === undefined) return
    await r.call('run_task', { task: 'apple' })
    const grand = await orphan(t, dir)
    const found = await gone(grand)
    // On macOS this is an observation: a program of the system may hide its environment from `ps`, so the marker
    // may not find it. On Linux the subreaper helper ends it, and that is the rule.
    if (mac)
      t.diagnostic(
        `macOS: a /bin/sleep daemon whose parent exited ${found ? 'was found by the marker and ended' : 'STAYED'}`,
      )
    else assert.ok(found, 'the grandchild is gone')
  })
})

describe('run_task: a helper that fails falls back to the direct spawn, and no task runs two times', () => {
  const fake = (windows: string, posix: string): string => path.join(import.meta.dirname, win ? windows : posix)
  const FAIL = fake('task-job-fail.ps1', 'task-reap-fail.pl')
  const END = fake('task-job-end.ps1', 'task-reap-end.pl')

  test('failed before the start: the task runs once, the note comes once, and the next task goes direct', async t => {
    const dir = folders(t)()
    const log = path.join(dir, 'stamp.log')
    const notes: string[] = []
    const runner = createTaskRunner(
      { valid: [resolved(dir, 'stamp', ['stamp', log, '50']), resolved(dir, 'out', ['exit', '0'])], invalid: [] },
      { helper: { script: FAIL }, note: line => notes.push(line) },
    )
    t.after(() => runner.stop())
    const first = await runner.run('stamp', new AbortController().signal)
    assert.equal(first.exitCode, 0)
    assert.equal(fs.readFileSync(log, 'utf8').match(/^start /gm)?.length, 1, 'one start')
    const second = await runner.run('out', new AbortController().signal)
    assert.deepEqual([second.exitCode, second.stdout], [0, 'out'], 'no text of the failed helper is in the output')
    assert.equal(notes.length, 1, 'one note for the process')
    assert.match(notes[0]!, /the task helper failed at the step job, so tasks now run by the direct spawn/)
    assert.match(notes[0]!, win ? /taskkill tree/ : /process group/)
    assert.doesNotMatch(notes[0]!, /[A-Za-z]:\\|\/tmp|\/home/, 'no path in the note')
  })

  test('a helper that ends after begin with no end report is an error, and the task never starts a second time', async t => {
    const dir = folders(t)()
    const log = path.join(dir, 'stamp.log')
    const notes: string[] = []
    const runner = createTaskRunner(
      { valid: [resolved(dir, 'stamp', ['stamp', log, '50'])], invalid: [] },
      { helper: { script: END }, note: line => notes.push(line) },
    )
    t.after(() => runner.stop())
    await assert.rejects(
      runner.run('stamp', new AbortController().signal),
      (e: Error) => e.message === 'io: the task ended with no result: its helper stopped',
    )
    await sleep(300)
    assert.ok(
      !fs.existsSync(log) || (fs.readFileSync(log, 'utf8').match(/^start /gm)?.length ?? 0) <= 1,
      'at most one start',
    )
    assert.deepEqual(notes, [], 'a task that began is no failure that falls back')
  })

  test(
    'a helper that takes 11 s to get ready is waited for: no fallback, and the call gets its report',
    { skip: !win },
    async t => {
      const dir = folders(t)()
      const log = path.join(dir, 'stamp.log')
      const notes: string[] = []
      const runner = createTaskRunner(
        { valid: [resolved(dir, 'stamp', ['stamp', log, '50'])], invalid: [] },
        { helper: { script: path.join(import.meta.dirname, 'task-job-slow.ps1') }, note: line => notes.push(line) },
      )
      t.after(() => runner.stop())
      const out = await runner.run('stamp', new AbortController().signal)
      assert.equal(out.exitCode, 7, 'the report of the helper is the result')
      assert.deepEqual(notes, [], 'a slow start is no failure')
      assert.ok(!fs.existsSync(log), 'the direct spawn did not run the task as well')
    },
  )

  test('two helpers that end before ready are the fallback', { skip: !win }, async t => {
    const dir = folders(t)()
    const notes: string[] = []
    const runner = createTaskRunner(
      { valid: [resolved(dir, 'out', ['exit', '0'])], invalid: [] },
      { helper: { script: path.join(import.meta.dirname, 'task-job-early.ps1') }, note: line => notes.push(line) },
    )
    t.after(() => runner.stop())
    const out = await runner.run('out', new AbortController().signal)
    assert.deepEqual([out.exitCode, out.stdout], [0, 'out'])
    assert.equal(notes.length, 1)
    assert.match(notes[0]!, /failed at the step exit4,/)
  })

  test('a start that fails at once leaves no listener, no live task and no timer, and the next call runs', async t => {
    const dir = folders(t)()
    const runner = createTaskRunner(
      { valid: [resolved(dir, 'bad', [], { file: '' }), resolved(dir, 'ok', ['exit', '0'])], invalid: [] },
      { helper: false },
    )
    t.after(() => runner.stop())
    const controller = new AbortController()
    await assert.rejects(runner.run('bad', controller.signal), (e: Error) =>
      /^io: the task could not start/.test(e.message),
    )
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'no abort listener is left')
    const began = Date.now()
    await runner.stop()
    assert.ok(Date.now() - began < 500, 'stop settles at once: no live entry')
  })

  test('the next call runs after a start that failed at once', async t => {
    const dir = folders(t)()
    const runner = createTaskRunner(
      { valid: [resolved(dir, 'bad', [], { file: '' }), resolved(dir, 'ok', ['exit', '0'])], invalid: [] },
      { helper: false },
    )
    t.after(() => runner.stop())
    await assert.rejects(runner.run('bad', new AbortController().signal))
    assert.equal((await runner.run('ok', new AbortController().signal)).exitCode, 0)
  })

  test('a cancel while the helper starts is no failure of the helper', async t => {
    const dir = folders(t)()
    const notes: string[] = []
    const runner = createTaskRunner(
      { valid: [resolved(dir, 'sleep', ['sleep'])], invalid: [] },
      { note: l => notes.push(l) },
    )
    t.after(() => runner.stop())
    const controller = new AbortController()
    const call = runner.run('sleep', controller.signal)
    call.catch(() => {})
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(call, /cancelled/)
    assert.deepEqual(notes, [])
  })
})

describe('the source of the task module', () => {
  const source = (...parts: string[]): string => fs.readFileSync(path.join(import.meta.dirname, '..', ...parts), 'utf8')

  test('no shell and no cross-spawn: the spawn sets neither', () => {
    for (const text of [source('src', 'host', 'workspace', 'task.ts'), source('src', 'host', 'taskjob.ts')]) {
      assert.doesNotMatch(text, /from 'cross-spawn'|crossSpawn\(|require\(/)
      assert.doesNotMatch(text, /\bshell\s*:/)
      assert.match(text, /from 'node:child_process'/)
      assert.match(text, /windowsHide: true/)
    }
  })

  test('no value of a task is part of PowerShell source or of its command line', () => {
    const host = source('src', 'host', 'taskjob.ts')
    assert.doesNotMatch(host, /-EncodedCommand|-Command\b|Invoke-Expression/i)
    assert.match(host, /'-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'\]/)
    assert.match(host, /\[\.\.\.SWITCHES, options\.script, pipe\]/)
    assert.doesNotMatch(
      source('runtime', 'task-job.ps1'),
      /Invoke-Expression|\biex\b|-EncodedCommand|Reflection\.Emit/i,
    )
    // The perl helper is the system file, with an empty environment, and no value of a task is on its command line but
    // the program and its arguments, which a direct spawn shows too.
    assert.match(host, /export const PERL = '\/usr\/bin\/perl'/)
    assert.match(host, /spawn\(perl, \[script, String\(prctl\), input\.file, \.\.\.input\.args\][\s\S]*?env: \{\}/)
    assert.doesNotMatch(source('runtime', 'task-reap.pl'), /^use |^require /m)
  })

  test('the job has KILL_ON_JOB_CLOSE and no breakaway flag, and nothing is written to the streams', () => {
    const script = source('runtime', 'task-job.ps1')
    assert.match(script, /LimitFlags = 0x2000/)
    assert.doesNotMatch(script, /LimitFlags\s*\|=|LimitFlags = 0x(?!2000;)|JOB_OBJECT_\w*BREAKAWAY/i)
    assert.doesNotMatch(
      script,
      /Write-Host|Write-Output|Write-Error|Console\]::Out|Out-Host|Console\.(Out|Error|Write)/,
    )
    // The one write that stays is the breadcrumb on the standard error of the helper, which the host reads. It can never be
    // a stream of a task: the task gets `nul` and its own two named pipes (STARTF_USESTDHANDLES), and the three standard
    // handles of the helper are made not inheritable before any task starts, so the task inherits none of them.
    assert.equal(script.match(/Console\]::Error/g)?.length, 1, 'one place writes to the error stream: Crumb')
    assert.match(
      script,
      /function Crumb\(\[string\]\$text\) \{ try \{ \[Console\]::Error\.WriteLine\("ts-helper: \$text"\) \} catch \{\} \}/,
    )
    assert.match(
      script,
      /foreach \(int which in new int\[\] \{ -10, -11, -12 \}\)[\s\S]*?SetHandleInformation\(h, 1, 0\)/,
    )
    assert.match(script, /si\.flags = 0x100;[\s\S]*?si\.hIn = nul; si\.hOut = output; si\.hErr = error;/)
    // No cmdlet before the compile (the first one makes PowerShell search every module of a runner), and the host gives the
    // helper a module path of the system folder only.
    const beforeCompile = script.slice(script.indexOf('param('), script.indexOf('Add-Type'))
    assert.doesNotMatch(beforeCompile.replace(/^\s*#.*$/gm, ''), /\b(Get|New|Set|Write|Out|Select|Where|ForEach)-\w+/)
    assert.match(
      source('src', 'host', 'taskjob.ts'),
      /env\.PSModulePath = path\.win32\.join\(systemRoot, 'System32', 'WindowsPowerShell', 'v1\.0', 'Modules'\)/,
    )
    assert.ok(
      script.indexOf('SetHandleInformation(h, 1, 0)') < script.indexOf('CreateProcessW(parts[0]'),
      'the handles are made not inheritable before the first task starts',
    )
  })
})

describe('run_task: the warm helper of Windows', { skip: !win }, () => {
  test('two tasks run on one helper, and the first one waits for the helper to be ready', async t => {
    const dir = folders(t)()
    const runner = createTaskRunner({ valid: [resolved(dir, 'out', ['exit', '0'])], invalid: [] })
    t.after(() => runner.stop())
    assert.equal(runner.helperPid(), undefined, 'no helper before the first task')
    await runner.run('out', new AbortController().signal)
    const pid = runner.helperPid()
    assert.ok(pid !== undefined && alive(pid), 'the helper lives after the first task')
    const again = await runner.run('out', new AbortController().signal)
    assert.equal(again.exitCode, 0)
    assert.equal(runner.helperPid(), pid, 'one helper pid for both tasks')
  })

  test('a task after a time limit runs on a new helper, started at once', async t => {
    const dir = folders(t)()
    const runner = createTaskRunner({
      valid: [resolved(dir, 'hang', ['sleep'], { timeoutMs: 1000 }), resolved(dir, 'out', ['exit', '0'])],
      invalid: [],
    })
    t.after(() => runner.stop())
    await runner.run('out', new AbortController().signal)
    const first = runner.helperPid()!
    const hung = await runner.run('hang', new AbortController().signal)
    assert.equal(hung.timedOut, true)
    assert.ok(await gone(first), 'the helper that held the job ended')
    assert.ok(await until(() => runner.helperPid() !== undefined), 'the next helper started off the path of a call')
    assert.notEqual(runner.helperPid(), first)
    assert.equal((await runner.run('out', new AbortController().signal)).exitCode, 0)
  })

  test('the helper ends after the idle time, and a task after that starts a new one', async t => {
    const dir = folders(t)()
    const runner = createTaskRunner(
      { valid: [resolved(dir, 'out', ['exit', '0'])], invalid: [] },
      { helper: { idleMs: 1500 } },
    )
    t.after(() => runner.stop())
    await runner.run('out', new AbortController().signal)
    const first = runner.helperPid()!
    assert.ok(await gone(first), 'the idle helper is gone')
    assert.equal(runner.helperPid(), undefined)
    assert.equal((await runner.run('out', new AbortController().signal)).exitCode, 0)
    assert.notEqual(runner.helperPid(), first)
  })

  test('a helper that another program kills during a task gives an error, no second start, and nothing stays', async t => {
    const dir = folders(t)()
    const runner = createTaskRunner({ valid: [resolved(dir, 'orphan', ['orphan', dir, 'stay'])], invalid: [] })
    t.after(() => runner.stop())
    const call = runner.run('orphan', new AbortController().signal)
    call.catch(() => {})
    assert.ok(await until(() => fs.existsSync(path.join(dir, 'ready'))), 'the task is ready')
    const grand = Number(fs.readFileSync(path.join(dir, 'grand.pid'), 'utf8'))
    process.kill(runner.helperPid()!)
    await assert.rejects(call, (e: Error) => /^io: the task ended with no result/.test(e.message))
    assert.ok(await gone(grand), 'the grandchild is gone')
  })
})

describe('run_task: the helper of Linux and macOS', { skip: win }, () => {
  test('a script that signals its own group ends as a direct spawn does: SIGTERM and nothing left', async t => {
    const dir = folders(t)()
    const pidFile = path.join(dir, 'sleep.pid')
    const runner = createTaskRunner({
      valid: [
        resolved(dir, 'group', [], {
          file: '/bin/sh',
          args: ['-c', `sleep 30 & echo $! > '${pidFile}'; kill -TERM 0`],
        }),
      ],
      invalid: [],
    })
    t.after(() => runner.stop())
    const out = await runner.run('group', new AbortController().signal)
    assert.deepEqual([out.exitCode, out.signal, out.timedOut], [null, 'SIGTERM', false])
    const sleeper = Number(fs.readFileSync(pidFile, 'utf8'))
    assert.ok(await gone(sleeper), 'the background process of the script is gone')
  })

  test('a program that is gone is the start error ENOENT, one time, with no fallback', async t => {
    const dir = folders(t)()
    const notes: string[] = []
    const runner = createTaskRunner(
      { valid: [resolved(dir, 'gone', [], { file: path.join(dir, 'removed') })], invalid: [] },
      { note: l => notes.push(l) },
    )
    t.after(() => runner.stop())
    await assert.rejects(
      runner.run('gone', new AbortController().signal),
      (e: Error) => e.message === 'io: the task could not start (ENOENT)',
    )
    assert.deepEqual(notes, [])
  })

  test(
    'without /usr/bin/perl the direct spawn takes the call: this one is skipped where perl is there',
    { skip: perlPath() !== undefined },
    async t => {
      const dir = folders(t)()
      const notes: string[] = []
      const runner = createTaskRunner(
        { valid: [resolved(dir, 'out', ['exit', '0'])], invalid: [] },
        { note: l => notes.push(l) },
      )
      t.after(() => runner.stop())
      assert.equal((await runner.run('out', new AbortController().signal)).exitCode, 0)
      assert.match(notes[0]!, /failed at the step perl/)
    },
  )
})

describe('run_task: the server is killed hard', () => {
  test('the task and its orphan are gone inside 10 s of a SIGKILL of the host', async t => {
    const dir = folders(t)()
    // Node 22.13 needs the flag to run a .ts file. The stderr of the host shows why it did not get ready.
    const host = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        path.join(import.meta.dirname, 'task-host-child.ts'),
        dir,
        'stay',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    )
    let stderr = ''
    host.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk).slice(-2000)))
    t.after(() => host.kill('SIGKILL'))
    assert.ok(
      await until(() => fs.existsSync(path.join(dir, 'ready'))),
      `the orphan case is ready; the host said: ${stderr || '(nothing)'}`,
    )
    const top = Number(fs.readFileSync(path.join(dir, 'top.pid'), 'utf8'))
    const grand = Number(fs.readFileSync(path.join(dir, 'grand.pid'), 'utf8'))
    t.after(() => {
      for (const pid of [top, grand])
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
    })
    assert.ok(alive(top) && alive(grand), 'both run before the kill')
    host.kill('SIGKILL')
    assert.ok(await gone(top, grand), `top ${alive(top)}, grandchild ${alive(grand)}`)
  })
})
