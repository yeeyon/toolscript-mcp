// The variables that a stdio child inherits are the first SDK's list, as our own constant: the v2 client package adds six
// Windows variables, and no child may see a new one (issue #154, PR 6). The first SDK's function is the reference, run in a
// child on each platform branch with every variable of both lists set.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { defaultEnvironment, inheritedNames } from '../src/core/childenv.ts'

const ALL = [...new Set([...inheritedNames('win32'), ...inheritedNames('linux')])]
// A real value where this machine has one: a Node child on Windows needs a true SYSTEMROOT to start.
const WITH_ALL: Record<string, string> = Object.fromEntries(
  ALL.map(name => [name, process.env[name] ?? `value of ${name}`]),
)
// The extra names that the v2 package inherits on Windows, and a shell function that no list passes on.
const EXTRA: Record<string, string> = {
  ComSpec: 'c',
  PATHEXT: 'p',
  WINDIR: 'w',
  PROGRAMDATA: 'd',
  NUMBER_OF_PROCESSORS: '1',
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`the inherited environment on ${platform} is the one of the first SDK`, () => {
    const env = {
      ...WITH_ALL,
      ...EXTRA,
      FUNC: '() { :; }',
      ...(platform === 'win32' ? { PROGRAMFILES: '() x' } : { HOME: '() x' }),
    }
    // On this machine the child must still start: keep the real root of the system.
    if (process.env.SYSTEMROOT !== undefined) env.SYSTEMROOT = process.env.SYSTEMROOT
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'childenv-child.mjs'), platform], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(defaultEnvironment(platform, env), JSON.parse(run.stdout) as Record<string, string>)
  })
}

test('no variable of the v2 package is in the list', () => {
  for (const name of Object.keys(EXTRA)) assert.ok(!inheritedNames('win32').includes(name), name)
})
