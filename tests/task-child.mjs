// The child of the task tests (issue #144, pull request C): `node tests/task-child.mjs <mode> [arguments]`.
//   argv            prints its arguments as JSON, so a test sees exactly what reached the child
//   env             prints its environment as JSON
//   cwd             prints its folder
//   exit <n>        writes `out` to stdout and `err` to stderr, and exits with n
//   tree <dir>      starts a grandchild that sleeps, writes `child.pid`, `grand.pid` and then `ready` in dir, and sleeps
//   leaver <dir>    starts a grandchild that keeps stdout open and sleeps, writes its pid to dir/grand.pid, and exits 0
//   flood <bytes>   writes `HEAD`, then filler, then `TAIL`, `bytes` in all, to stdout and the same to stderr
//   stamp <file> <ms>  appends `start <time>` to file, sleeps ms, appends `end <time>`
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
} else if (mode === 'stamp') {
  fs.appendFileSync(rest[0], `start ${Date.now()}\n`)
  setTimeout(() => fs.appendFileSync(rest[0], `end ${Date.now()}\n`), Number(rest[1]))
} else if (mode === 'sleep') forever()
else {
  process.stderr.write('unknown mode')
  process.exitCode = 9
}
