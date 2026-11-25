// The Windows job helper of a Workspace task (issue #149). A Windows PowerShell 5.1 script (runtime/task-job.ps1)
// puts itself in a Job Object that ends with its last handle, then starts the task inside it. When the helper ends, so
// does every process in the job, also one whose parent already exited, which `taskkill /T` cannot find.
//
// No value of a task is in the command line of PowerShell or in its source: they travel as data, in a file in a private
// folder that the helper reads and removes. The helper reports its steps over a named pipe that this file listens on,
// apart from its exit code and from the streams of the task, so a failed helper never reads as an exit code of the task.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The helper script. `import.meta.url` gives the same folder in `src/host/` and in `dist/host/main.js`, as `RUNNER` does. */
export const TASK_JOB = fileURLToPath(new URL('../../runtime/task-job.ps1', import.meta.url))

/** The helper has this long to report that the job is made, then it counts as failed. */
export const HELPER_START_MS = 10_000

/** After the helper ended with no connection yet, the pipe gets this long for a message that is still on its way. */
const LATE_MS = 300

/**
 * What the helper reports. `began`: the job is made and the task starts now, so the helper counts as having started it
 * from here on. `started`: the task runs. `start-error`: the program did not start, with a Node code. `failed`: the
 * helper could not make the job, with the step.
 */
export type JobReport =
  | { readonly kind: 'began' }
  | { readonly kind: 'started' }
  | { readonly kind: 'start-error'; readonly code: string }
  | { readonly kind: 'failed'; readonly step: string }

/** One line of the helper as a report. A text that is not in the list is no report, and its parts are checked. */
export const parseReport = (line: string): JobReport | undefined => {
  if (line === 'begin') return { kind: 'began' }
  if (line === 'started') return { kind: 'started' }
  const code = /^error:([A-Z]{3,12}|error)$/.exec(line)
  if (code !== null) return { kind: 'start-error', code: code[1]! }
  const step = /^failed:([a-z]{1,12})$/.exec(line)
  if (step !== null) return { kind: 'failed', step: step[1]! }
  return undefined
}

/** The Windows PowerShell 5.1 of this system, from the `SystemRoot` of the server, or undefined when it is not a file. */
export const powershellPath = (env: Readonly<Record<string, string | undefined>> = process.env): string | undefined => {
  const root = env.SystemRoot ?? env.SYSTEMROOT
  if (root === undefined || !path.win32.isAbsolute(root)) return undefined
  const file = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    return fs.statSync(file).isFile() ? file : undefined
  } catch {
    return undefined
  }
}

export type HelperInput = {
  readonly powershell: string
  readonly script: string
  /** The program of the task, the arguments as one command-line text, its folder and its whole environment. */
  readonly file: string
  readonly line: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export type Helper = {
  readonly proc: ChildProcess
  /** Settles when the helper ended and the pipe has no report left, so a report is never missed behind the exit. */
  readonly afterExit: () => Promise<void>
  /** Closes the pipe and removes the folder of the data. */
  readonly cleanup: () => void
}

/**
 * Starts the helper for one task. `onReport` is called for each report. It throws when the data cannot be written or
 * the process cannot start: the caller takes that as a failed helper that never started the task.
 */
export const startHelper = (input: HelperInput, onReport: (report: JobReport) => void): Helper => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-task-'))
  const cleanup = (): void => {
    server.close()
    socket?.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const pipe = `ts-task-${randomBytes(16).toString('hex')}`
  const data = path.join(dir, 'task.json')
  let socket: net.Socket | undefined
  let closed: Promise<void> | undefined
  const server = net.createServer(connection => {
    socket = connection
    server.close()
    let rest = ''
    closed = new Promise<void>(resolve => connection.once('close', () => resolve()))
    connection.setEncoding('utf8')
    connection.on('data', (text: string) => {
      rest += text
      for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
        const report = parseReport(rest.slice(0, end))
        rest = rest.slice(end + 1)
        if (report !== undefined) onReport(report)
      }
    })
    connection.on('error', () => {})
  })
  // A pipe that cannot be made is a failed helper: no helper would find it.
  server.on('error', () => onReport({ kind: 'failed', step: 'channel' }))
  try {
    fs.writeFileSync(data, JSON.stringify({ file: input.file, args: input.line, cwd: input.cwd, env: input.env }))
    server.listen(`\\\\.\\pipe\\${pipe}`)
    const proc = spawn(
      input.powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', input.script, pipe, data],
      { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    return {
      proc,
      afterExit: async () => {
        if (closed === undefined) await new Promise(resolve => setTimeout(resolve, LATE_MS))
        if (closed !== undefined)
          await Promise.race([closed, new Promise(resolve => setTimeout(resolve, LATE_MS * 5).unref())])
      },
      cleanup,
    }
  } catch (err) {
    cleanup()
    throw err
  }
}
