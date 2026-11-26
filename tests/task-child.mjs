// The child of the task tests (issue #144, pull request C): `node tests/task-child.mjs <mode> [arguments]`.
//   argv            prints its arguments as JSON, so a test sees exactly what reached the child
//   env             prints its environment as JSON
//   cwd             prints its folder
//   exit <n>        writes `out` to stdout and `err` to stderr, and exits with n
//   tree <dir>      starts a grandchild that sleeps, writes `child.pid`, `grand.pid` and then `ready` in dir, and sleeps
//   leaver <dir>    starts a grandchild that keeps stdout open and sleeps, writes its pid to dir/grand.pid, and exits 0
//   flood <bytes>   writes `HEAD`, then filler, then `TAIL`, `bytes` in all, to stdout and the same to stderr
//   stamp <file> <ms>  appends `start <time>` to file, sleeps ms, appends `end <time>`
//   orphan <dir> <stay|exit>  starts a middle process that starts a detached grandchild, writes its pid to dir/grand.pid and
//                   exits. Then it writes `ready` in dir and sleeps (stay), or exits 0 (exit). The grandchild's parent is gone.
//                   A third argument `apple` makes the grandchild /bin/sleep: the default is a `node` process that sleeps.
//   live <dir>      starts a detached `node` child, writes top.pid, grand.pid and ready, and stays: its parent is alive
//   nap             sleeps 120 s, then ends by itself
//   sleep           sleeps for ever

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [mode, ...rest] = process.argv.slice(2)
const forever = () => setInterval(() => {}, 1000)

if (mode === 'argv') process.stdout.write(JSON.stringify(rest))
else if (mode === 'env') process.stdout.write(JSON.stringify(process.env))
else if (mode === 'cwd') process.stdout.write(process.cwd())
else if (mode === 'exit') {
  process.stdout.write('out')
  process.stderr.write('err')
  process.exitCode = Number(rest[0])
} else if (mode === 'tree' || mode === 'leaver') {
  const dir = rest[0]
  // On Windows, libuv puts each Node process in a job that ends with it, so a plain grandchild would die with its
  // parent and prove nothing about the tree. A detached one leaves the job: only the walk of `taskkill /T` reaches it.
  // Elsewhere the grandchild stays in the process group, which is how the tree ends.
  const win = process.platform === 'win32'
  const [program, args] = win ? ['ping', ['-n', '120', '127.0.0.1']] : ['sleep', ['120']]
  const grand = spawn(program, args, {
    stdio: mode === 'leaver' ? 'inherit' : 'ignore',
    windowsHide: true,
    detached: win && mode === 'tree',
  })
  fs.writeFileSync(path.join(dir, 'grand.pid'), String(grand.pid))
  if (mode === 'tree') {
    fs.writeFileSync(path.join(dir, 'child.pid'), String(process.pid))
    fs.writeFileSync(path.join(dir, 'ready'), '1')
    forever()
  } else process.exit(0)
} else if (mode === 'flood') {
  const size = Number(rest[0])
  const body = `HEAD${'x'.repeat(size - 8)}TAIL`
  process.stdout.write(body)
  process.stderr.write(body)
} else if (mode === 'utf8') {
  // 'a' then two-byte characters: the 64 KiB head ends in the middle of one, and so does the tail start.
  const body = `a${'é'.repeat(Number(rest[0]))}b`
  process.stdout.write(body)
} else if (mode === 'stamp') {
  fs.appendFileSync(rest[0], `start ${Date.now()}\n`)
  setTimeout(() => fs.appendFileSync(rest[0], `end ${Date.now()}\n`), Number(rest[1]))
} else if (mode === 'orphan') {
  const [dir, then, kind = 'node'] = rest
  fs.writeFileSync(path.join(dir, 'top.pid'), String(process.pid))
  const mid = spawn(process.execPath, [process.argv[1], 'orphan-mid', dir, kind], {
    stdio: 'ignore',
    windowsHide: true,
  })
  mid.once('exit', () => {
    fs.writeFileSync(path.join(dir, 'ready'), '1')
    if (then === 'exit') process.exit(0)
  })
  // A top process that stays ends by itself in 120 s, so no test leaves it behind.
  if (then !== 'exit') setTimeout(() => process.exit(0), 120_000)
} else if (mode === 'orphan-mid') {
  // The daemon is `ping` on Windows. Elsewhere it is a `node` process by default, as a build daemon or a browser is, or
  // an Apple or system program (`apple`: /bin/sleep), which macOS may not show a marker for.
  const win = process.platform === 'win32'
  const [program, args] = win
    ? ['ping', ['-n', '120', '127.0.0.1']]
    : rest[1] === 'apple'
      ? ['sleep', ['120']]
      : [process.execPath, [process.argv[1], 'nap']]
  const grand = spawn(program, args, { stdio: 'ignore', windowsHide: true, detached: true })
  grand.unref()
  fs.writeFileSync(path.join(rest[0], 'grand.pid'), String(grand.pid))
  process.exit(0)
} else if (mode === 'live') {
  // A child that a living parent started with `detached: true`, as Playwright starts a browser. The parent stays.
  const grand = spawn(process.execPath, [process.argv[1], 'nap'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  })
  fs.writeFileSync(path.join(rest[0], 'top.pid'), String(process.pid))
  fs.writeFileSync(path.join(rest[0], 'grand.pid'), String(grand.pid))
  fs.writeFileSync(path.join(rest[0], 'ready'), '1')
  setTimeout(() => process.exit(0), 120_000)
} else if (mode === 'nap') setTimeout(() => process.exit(0), 120_000)
else if (mode === 'sleep') forever()
else {
  process.stderr.write('unknown mode')
  process.exitCode = 9
}
