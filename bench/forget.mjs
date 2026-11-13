// Removes the Claude Code project folder of a bench run. Runs use
// --no-session-persistence, so no transcript is written, but Claude Code still
// saves an MCP result too large to show in ~/.claude/projects/<cwd>/<session>/.
// A folder is removed only when its name is exactly the name Claude Code gives
// one of the given run cwds and it is a direct child of ~/.claude/projects.
//
//   node bench/forget.mjs <out dir>    removes the folders of every run in <out dir>

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECTS = path.join(os.homedir(), '.claude', 'projects')

const projectName = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** Removes the project folder of each run cwd, and returns the folders it removed. */
export const forgetRuns = cwds => {
  const removed = []
  for (const cwd of cwds) {
    if (path.basename(cwd) !== 'cwd' || !path.isAbsolute(cwd)) throw new Error(`not a bench run cwd: ${cwd}`)
    const names = new Set([projectName(cwd)])
    if (fs.existsSync(cwd)) names.add(projectName(fs.realpathSync.native(cwd)))
    for (const name of names) {
      const dir = path.join(PROJECTS, name)
      if (path.dirname(dir) !== PROJECTS || !fs.existsSync(dir)) continue
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
  }
  return removed
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2])
  const cwds = fs
    .readdirSync(out, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(out, d.name, 'cwd')))
    .flatMap(d => {
      const cwd = path.join(out, d.name, 'cwd')
      return [cwd, path.join(fs.realpathSync.native(out), d.name, 'cwd')]
    })
  for (const removed of forgetRuns(cwds)) console.log(`removed ${removed}`)
}
