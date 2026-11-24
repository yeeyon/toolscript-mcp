// The named tasks of the built-in Workspace (issue #144, pull request C): `run_task` on real temp trees, with real
// child processes (tests/task-child.mjs). Each fixture checks what the child saw (its argv and environment), the pids
// that are gone, and the times that the children wrote, never a success text. A task is NOT contained: no test claims it.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  TASK_ENV_NAMES,
  TASK_LIMITS,
  commandProblem,
  cwdParts,
  isBareName,
  taskEnv,
  type TaskConfig,
} from '../src/core/task.ts'
import { findOnPath, launchProblem } from '../src/host/workspace/task.ts'
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

/** Waits until `check` is true, at most `ms`. */
const until = async (check: () => boolean, ms = 6000): Promise<boolean> => {
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
    assert.deepEqual(
      extra.filter(k => !system.test(k)),
      [],
    )
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
    assert.ok(out.ms >= 900 && out.ms < 6000, `${out.ms} ms`)
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

  test('a process that the task leaves behind in its group does not stay (outside Windows), and the call still returns', async t => {
    const dir = folders(t)()
    const r = await rigOf(t, [task('leaver', ['leaver', dir])])
    if (r === undefined) return
    const out = await r.call('run_task', { task: 'leaver' })
    const grand = Number(fs.readFileSync(path.join(dir, 'grand.pid'), 'utf8'))
    try {
      assert.equal(out.exitCode, 0)
      assert.equal(out.timedOut, false)
      assert.ok(out.ms < 6000, `${out.ms} ms`)
      // Windows cannot find the descendants of a process that has exited: the test kills the leftover itself.
      if (!win) assert.ok(await gone(grand), 'the grandchild is gone')
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

describe('the source of the task module', () => {
  test('no shell and no cross-spawn: the spawn sets neither', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'host', 'workspace', 'task.ts'), 'utf8')
    assert.doesNotMatch(source, /from 'cross-spawn'|crossSpawn\(|require\(/)
    assert.doesNotMatch(source, /\bshell\s*:/)
    assert.match(source, /from 'node:child_process'/)
    assert.match(source, /windowsHide: true/)
  })
})
