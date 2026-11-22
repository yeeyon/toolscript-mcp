// For scripts/start-time.mjs: finds the broker that a run left in its temp home and checks that the process under that
// pid is still that broker before the script ends it. A pid can be reused after the broker left without a log line.

import { spawnSync } from 'node:child_process'

/** The last `start pid` line of a broker.log that no `exit` line follows: `{ pid, at }` (epoch ms), or undefined. */
export const lastLiveStart = log => {
  const lines = log.split('\n')
  let live
  for (const line of lines) {
    const start = /^(\S+) start pid (\d+)$/.exec(line)
    if (start) live = { pid: Number(start[2]), at: Date.parse(start[1]) }
    else if (/^\S+ exit$/.test(line)) live = undefined
  }
  return live !== undefined && Number.isFinite(live.at) ? live : undefined
}

/** The creation time (epoch ms) and the command line of a process, or undefined when it is gone or cannot be read. */
export const processInfo = pid => {
  const win = process.platform === 'win32'
  const r = win
    ? spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o'); $p.CommandLine }`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
      )
    : spawnSync('ps', ['-o', 'lstart=', '-o', 'args=', '-p', String(Number(pid))], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, LC_ALL: 'C' },
      })
  if (r.status !== 0 || typeof r.stdout !== 'string' || r.stdout.trim() === '') return undefined
  if (win) {
    const [when, ...rest] = r.stdout.trim().split(/\r?\n/)
    const start = Date.parse(when)
    return Number.isFinite(start) ? { start, command: rest.join('\n') } : undefined
  }
  // lstart is 24 characters in the C locale ("Sun Nov 22 10:00:00 2026").
  const text = r.stdout.replace(/^\s+/, '')
  const start = Date.parse(text.slice(0, 24))
  return Number.isFinite(start) ? { start, command: text.slice(24).trim() } : undefined
}

/**
 * True when the process is the broker whose start line was logged at `at`: its command line names the broker file
 * (`broker.js` of the build under test) and it was created no later than the log line and not long before it. Process
 * creation times come in whole seconds on some systems, so the bounds are loose; a reused pid starts after the log line.
 */
export const isBroker = (info, at, file, fold = process.platform === 'win32') => {
  if (info === undefined) return false
  const norm = text => (fold ? text.toLowerCase() : text).replaceAll('\\', '/')
  if (!norm(info.command).includes(norm(file))) return false
  return info.start <= at + 1500 && at - info.start < 60_000
}
