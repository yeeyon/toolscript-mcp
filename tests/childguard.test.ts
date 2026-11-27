// The child guard (src/core/childguard.ts, src/host/childguard.ts): the switch, the lines, the watchdog on Linux and
// macOS, and the failures that must leave a server running. The kill of a whole host is in tests/lazy.e2e.mjs.

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ASR_RULE,
  GUARD_ENV,
  WATCHDOG,
  guardExeName,
  guardLine,
  guardWanted,
  minusLine,
  offLine,
  plusLine,
  windowsFailure,
} from '../src/core/childguard.ts'
import { childGuardFolder, guardedDirs } from '../src/core/paths.ts'
import { createGuard } from '../src/host/childguard.ts'
import { readTable } from '../bench/memory.mjs'

const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolscript-childguard-test-')))
// Each process that a test starts, with its creation time: the cleanup ends only a process that still matches both.
const started = new Map<number, number | undefined>()
after(async () => {
  const table = await readTable().catch(() => [])
  for (const [pid, t] of started)
    if (table.some(p => p.pid === pid && p.t === t))
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (check: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 25))
  return check()
}
/** A child that ignores stdin EOF, the leader of its own group, as the host starts every stdio child. */
const sleeper = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
  child.unref()
  await remember(child.pid!)
  return child.pid!
}
const remember = async (pid: number): Promise<void> => {
  started.set(pid, (await readTable()).find((p: { pid: number }) => p.pid === pid)?.t)
}

describe('the switch and the lines', () => {
  test('on outside Windows unless the value is 0, on Windows only when the value is 1', () => {
    for (const platform of ['linux', 'darwin']) {
      assert.equal(guardWanted(platform, undefined), true)
      assert.equal(guardWanted(platform, '1'), true)
      assert.equal(guardWanted(platform, '0'), false)
    }
    assert.equal(guardWanted('win32', undefined), false)
    assert.equal(guardWanted('win32', '0'), false)
    assert.equal(guardWanted('win32', 'true'), false)
    assert.equal(guardWanted('win32', '1'), true)
  })

  test('the lines hold a pid and nothing else, and a bad pid gives none', () => {
    assert.equal(plusLine(42), '+42\n')
    assert.equal(minusLine(42), '-42\n')
    assert.equal(guardLine(42), 'guard 42\n')
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) {
      assert.equal(plusLine(bad), undefined)
      assert.equal(minusLine(bad), undefined)
      assert.equal(guardLine(bad), undefined)
    }
  })

  test('the watchdog uses the kill form that dash accepts', () => {
    assert.match(WATCHDOG, /kill -s KILL -- -\$p/)
    assert.doesNotMatch(WATCHDOG, /kill -KILL/)
  })

  test('the Windows failure names the rule and the variable, and the program is named by the hash', () => {
    const text = windowsFailure('the compile failed')
    assert.ok(text.includes(ASR_RULE) && text.includes(GUARD_ENV))
    assert.match(offLine('x'), /^child guard: off, x\. A host that is killed leaves its servers running$/)
    assert.equal(guardExeName('abcdef0123456789ffff'), 'child-guard-abcdef0123456789.exe')
  })

  test('the folder of the program is guarded against a nested call', () => {
    assert.ok(guardedDirs(home, '').includes(childGuardFolder(home)))
  })
})

describe('the watchdog (Linux and macOS)', { skip: process.platform === 'win32' }, () => {
  const lines: string[] = []
  const make = (extra: Record<string, unknown> = {}) =>
    createGuard({ home, log: line => lines.push(line), platform: process.platform, env: {}, ...extra })

  test('a child that was removed is left alone when the guard ends', async () => {
    const guard = make()
    const pid = await sleeper()
    guard.add(pid)
    assert.equal(guard.state().state, 'on')
    guard.remove(pid)
    guard.close()
    await new Promise(r => setTimeout(r, 400))
    assert.ok(alive(pid), 'the host stopped it, so the guard must not touch it')
    process.kill(-pid, 'SIGKILL')
    started.delete(pid)
  })

  test('a child that is still listed loses its group when the guard ends, as when the host dies', async () => {
    const guard = make()
    const pid = await sleeper()
    guard.add(pid)
    guard.close()
    assert.ok(await until(() => !alive(pid), 3000), 'the group was ended')
    started.delete(pid)
  })

  test('a guard that never had a child starts no process', () => {
    const guard = make()
    assert.equal(guard.state().state, 'starting')
    guard.close()
  })

  test('off by 0: no process, no line', async () => {
    const before = lines.length
    const guard = make({ env: { [GUARD_ENV]: '0' } })
    assert.equal(guard.state().state, 'unwanted')
    guard.add(await sleeper())
    assert.equal(lines.length, before)
    assert.equal((await guard.settled()).state, 'unwanted')
  })

  test('no shell: one line, the child still runs', async () => {
    lines.length = 0
    const guard = make({ shell: path.join(home, 'no-such-shell') })
    const pid = await sleeper()
    guard.add(pid)
    guard.add(await sleeper())
    assert.equal(guard.state().state, 'failed')
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /^child guard: off, there is no .*no-such-shell\. A host that is killed/)
    assert.ok(alive(pid))
    guard.close()
    await new Promise(r => setTimeout(r, 200))
    assert.ok(alive(pid))
    process.kill(-pid, 'SIGKILL')
    started.delete(pid)
  })
})

describe('the Windows program', { skip: process.platform !== 'win32' }, () => {
  const lines: string[] = []
  const make = (extra: Record<string, unknown> = {}) =>
    createGuard({
      home,
      log: line => lines.push(line),
      platform: 'win32',
      env: { [GUARD_ENV]: '1', ...process.env },
      ...extra,
    })

  test('not turned on: nothing starts and no program is written', async () => {
    const guard = createGuard({ home, log: line => lines.push(line), platform: 'win32', env: {} })
    guard.add(1234)
    assert.equal((await guard.settled()).state, 'unwanted')
    assert.equal(fs.existsSync(childGuardFolder(home)), false)
  })

  test('no csc.exe: one line that names the rule and the variable, and nothing else changes', async () => {
    lines.length = 0
    const guard = make({ csc: path.join(home, 'no-csc.exe') })
    guard.add(process.pid)
    const settled = await guard.settled()
    assert.equal(settled.state, 'failed')
    assert.equal(lines.length, 1)
    assert.ok(lines[0]!.includes(ASR_RULE) && lines[0]!.includes(GUARD_ENV), lines[0])
    guard.add(process.pid)
    guard.close()
    assert.equal(lines.length, 1, 'one line only')
  })

  test('a compile that fails leaves no program and no temp file', async () => {
    lines.length = 0
    // A "compiler" that exits at once with an error, and a source that exists.
    const source = path.join(home, 'x.cs')
    fs.writeFileSync(source, '// nothing')
    const guard = make({ csc: process.execPath, source })
    guard.start()
    const settled = await guard.settled()
    assert.equal(settled.state, 'failed')
    assert.match(lines[0]!, /compile/)
    const folder = childGuardFolder(home)
    assert.deepEqual(fs.existsSync(folder) ? fs.readdirSync(folder) : [], [])
  })

  test('a process that the host did not start is not adopted, and one that it started is', async () => {
    lines.length = 0
    const guard = make()
    guard.start()
    assert.equal((await guard.settled()).state, 'on', lines.join('\n'))
    // A child of this process: adopted.
    const mine = await sleeper()
    // A process whose parent is not this process: a node starts a sleeper and leaves, so its ppid names a dead process.
    const maker = spawn(
      process.execPath,
      [
        '-e',
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true }); c.unref(); console.log(c.pid)",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    )
    let text = ''
    maker.stdout.on('data', d => (text += d))
    await new Promise(resolve => maker.on('close', resolve))
    const orphan = Number(text.trim())
    assert.ok(orphan > 0 && alive(orphan))
    await remember(orphan)
    guard.add(mine)
    guard.add(orphan)
    await new Promise(r => setTimeout(r, 1500))
    guard.close()
    assert.ok(await until(() => !alive(mine), 5000), 'the process of the host was in the job')
    started.delete(mine)
    assert.ok(alive(orphan), 'a process that the host did not start was left alone')
    process.kill(orphan, 'SIGKILL')
    started.delete(orphan)
  })

  test('a missing source is a failure with its reason', async () => {
    lines.length = 0
    const guard = make({ source: path.join(home, 'gone.cs') })
    guard.start()
    assert.equal((await guard.settled()).state, 'failed')
    assert.match(lines[0]!, /source of the guard program is missing/)
  })
})
