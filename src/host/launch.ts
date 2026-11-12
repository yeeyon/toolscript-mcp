// Starts runtime/runner.mjs as the sandbox process, with the layers of this OS.
// The vm context of the runner, Node's --permission (read-only access to the
// runner and the exchange dir) and a host kill timer apply on every OS.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The bundled runner. This file is two levels below the package root in src/ and in dist/. */
export const RUNNER = fileURLToPath(new URL('../../runtime/runner.mjs', import.meta.url))

/** The layers that differ between systems. */
export type Layers = {
  /** `ulimit -t`: the kernel stops the process after its CPU seconds. */
  readonly cpuLimit: boolean
  /** The environment variables of the process, with their values. */
  readonly env: 'none' | 'SYSTEMROOT only'
  readonly network: 'sandbox-exec' | 'unshare -rn when the kernel allows it' | 'none'
}

export type LaunchOptions = {
  /** The Node binary. On Linux and macOS it can also be a name on PATH, or a version-manager shim. */
  readonly node: string
  readonly runner: string
  /** From makeExchangeDir. */
  readonly xdir: string
  /** The wall-clock limit of the run. The runner reports it by itself, and the host kill timer is the backstop. */
  readonly timeoutMs: number
  /** The runner's stdin: `{"code", "timeoutMs", "lib"}` as JSON. */
  readonly input: string
  /** The environment of the Linux and macOS launch script, which finds node and unshare on its PATH. The sandbox process never gets it. */
  readonly env?: NodeJS.ProcessEnv
}

/** How the process ended. `timeout`: the host kill timer stopped it. `failed`: it never started. */
export type Ending =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'timeout'; readonly limitMs: number }
  | { readonly kind: 'failed'; readonly error: Error }

export type Sandbox = {
  readonly child: ChildProcessWithoutNullStreams
  /** Settles after the process ended and its stdout and stderr closed. Never rejects. */
  readonly ended: Promise<Ending>
}

/**
 * The runner gets this long after its own timer to send its timeout message.
 * A busy loop blocks that timer, so then the host kill timer ends the run.
 */
export const KILL_GRACE_MS = 1000

type Command = { readonly file: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv }

// No network: sandbox-exec on macOS, a new network namespace (unshare -rn) on
// Linux where the kernel lets a user make one. env -i starts Node with no
// environment variables, so a program that gets out of the vm context cannot
// read secrets there. env -i also clears PATH, so the shell finds node first.
// A version-manager shim is a script that needs the environment, so the shell
// asks it for the real binary.
const NO_NETWORK = '(version 1)(allow default)(deny network*)'
const LAUNCH = [
  'ulimit -t "$1"',
  'profile=$2',
  'node=$(command -v "$3") || { echo "toolscript-mcp: $3: not found" >&2; exit 127; }',
  'case $(head -c 2 "$node") in "#!") node=$("$node" -p process.execPath) || exit 127 ;; esac',
  'set -- env -i "$node" --permission --allow-fs-read="$4" --allow-fs-read="$5" "$4" "$5"',
  'if [ -x /usr/bin/sandbox-exec ]; then',
  '  exec /usr/bin/sandbox-exec -p "$profile" "$@"',
  'fi',
  'if unshare -rn true 2>/dev/null; then',
  '  exec unshare -rn "$@"',
  'fi',
  'exec "$@"',
].join('\n')

const posix = (o: LaunchOptions, runner: string, xdir: string): Command => ({
  file: '/bin/sh',
  args: [
    '-c',
    LAUNCH,
    'toolscript-mcp',
    String(Math.max(1, Math.ceil(o.timeoutMs / 1000))),
    NO_NETWORK,
    o.node,
    runner,
    xdir,
  ],
  env: o.env ?? process.env,
})

// On Windows, libuv copies these variables from the host into a child whose
// env leaves them out, so each one is set here. Node aborts at start without
// SYSTEMROOT (Assertion failed: ncrypto::CSPRNG), so that one keeps its value.
const WINDOWS_COPIED = [
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]

const windows = (o: LaunchOptions, runner: string, xdir: string): Command => ({
  file: o.node,
  args: ['--permission', `--allow-fs-read=${runner}`, `--allow-fs-read=${xdir}`, runner, xdir],
  env: { ...Object.fromEntries(WINDOWS_COPIED.map(name => [name, ''])), SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
})

const SANDBOXES = {
  linux: {
    layers: { cpuLimit: true, env: 'none', network: 'unshare -rn when the kernel allows it' },
    command: posix,
  },
  darwin: { layers: { cpuLimit: true, env: 'none', network: 'sandbox-exec' }, command: posix },
  win32: { layers: { cpuLimit: false, env: 'SYSTEMROOT only', network: 'none' }, command: windows },
} as const satisfies Record<string, { layers: Layers; command: typeof posix }>

// Other POSIX systems run the Linux launch script: it skips unshare where it fails.
const SANDBOX =
  process.platform === 'win32' || process.platform === 'darwin' ? SANDBOXES[process.platform] : SANDBOXES.linux

/** The layers of the sandbox on this system. */
export const LAYERS: Layers = SANDBOX.layers

/** A new, empty exchange dir under the temp dir. Remove it with removeExchangeDir. */
export const makeExchangeDir = (): Promise<string> => fs.promises.mkdtemp(path.join(os.tmpdir(), 'toolscript-'))

// On Windows a file of a process that just ended can stay locked for a moment.
export const removeExchangeDir = (xdir: string): Promise<void> =>
  fs.promises.rm(xdir, { recursive: true, force: true, maxRetries: 5 })

/** Starts the sandbox process and its kill timer, and writes `input` to its stdin. */
export const launch = (o: LaunchOptions): Sandbox => {
  // --allow-fs-read takes real paths: on macOS the temp dir is under a link, and
  // --permission stops a main script whose path goes through a link before it starts.
  const command = SANDBOX.command(o, fs.realpathSync(o.runner), fs.realpathSync(o.xdir))
  const child = spawn(command.file, command.args, { env: command.env, stdio: 'pipe', windowsHide: true })
  child.stdin.on('error', () => {}) // a process that ends early does not read stdin
  child.stdin.end(o.input)

  // kill returns false once the process has exited, so a run that ends at the limit is no timeout.
  let timedOut = false
  const timer = setTimeout(() => (timedOut = child.kill('SIGKILL')), o.timeoutMs + KILL_GRACE_MS)
  let failed: Error | undefined
  const ended = new Promise<Ending>(resolve => {
    child.on('error', error => {
      if (child.pid === undefined) failed = error
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve(
        failed !== undefined
          ? { kind: 'failed', error: failed }
          : timedOut
            ? { kind: 'timeout', limitMs: o.timeoutMs }
            : { kind: 'exit', code, signal },
      )
    })
  })
  return { child, ended }
}
