// The fake server of the hard-kill-while-starting case of tests/lazy.e2e.mjs. The launch (command, args, env) is the same
// in both phases of the case, so the cache key of the launch is too. Which behavior it has comes from the file
// `slow` in the folder named by SLOW_START_DIR. Without it, it is tests/pid-server.mjs. With it, it writes its pid and
// the pid of its parent to `started` and then never answers `initialize`: it holds no timer, so it ends when its stdin
// ends, as a server that reads its stdin does.

import fs from 'node:fs'
import path from 'node:path'

const folder = process.env.SLOW_START_DIR
if (folder !== undefined && fs.existsSync(path.join(folder, 'slow'))) {
  fs.writeFileSync(path.join(folder, 'started'), `${process.pid} ${process.ppid}`)
  process.stdin.resume()
} else {
  await import('./pid-server.mjs')
}
