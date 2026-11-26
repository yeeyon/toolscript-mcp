// TEMPORARY diagnostic (revert before the PR leaves draft): a preload for the node 22.13 Windows leg of CI. A test file
// process that is still alive after 150 s writes its file, its uptime and its active resources to stderr every 30 s, so
// the log names the file that hangs and the handles that keep it alive (a timer, a pipe, a child process).
import path from 'node:path'

const started = Date.now()
const file = path.basename(process.argv[1] ?? '?')
const timer = setInterval(() => {
  const seconds = Math.round((Date.now() - started) / 1000)
  if (seconds < 150) return
  const counts = {}
  for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1
  process.stderr.write(`diag-handles: ${file} alive ${seconds} s: ${JSON.stringify(counts)}\n`)
}, 30_000)
timer.unref()
