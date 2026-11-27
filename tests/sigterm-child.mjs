// A child for tests/childtransport.test.ts: it ignores the end of its stdin, as a server that ignores EOF does, and exits
// cleanly on SIGTERM after it writes a marker file (its first argument).
//
//   node tests/sigterm-child.mjs /tmp/marker

import fs from 'node:fs'

const [marker] = process.argv.slice(2)
process.on('SIGTERM', () => {
  fs.writeFileSync(marker, 'cleaned up')
  process.exit(0)
})
process.stdin.resume()
process.stdin.on('end', () => {})
setInterval(() => {}, 1000)
fs.writeFileSync(`${marker}.started`, String(process.pid))
