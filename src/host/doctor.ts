// `toolscript-mcp doctor` checks a whole setup in one pass: Node, the config, the servers, the policy, the sandbox,
// the run log and the files in HOME. It prints one line for each finding to stderr, with the next step for a problem.
// Like tools and runs, it prints no description, argument, env or header value, or token. It changes no file.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import type { SettledState } from '../core/catalog.ts'
import { configPath, launchText, pathWord } from '../core/config.ts'
import {
  CHECK_NAMES,
  checkLine,
  doctorExit,
  fail,
  info,
  nodeFinding,
  ok,
  policyFindings,
  serverFinding,
  staleStoreKeys,
  warn,
  type CheckName,
  type Finding,
} from '../core/doctor.ts'
import { appPath, oauthFolder, runLogFile } from '../core/paths.ts'
import { shownName } from '../core/policy.ts'
import { errorText, takeMessages, type RunnerDone, type RunnerError } from '../core/protocol.ts'
import { runsReport } from '../core/runlog.ts'
import { connectStates, readRunLog, toolsFor, type CheckIo } from './diagnose.ts'
import { LAYERS, RUNNER, launch, makeExchangeDir, removeExchangeDir } from './launch.ts'
import { storeFile } from './oauth.ts'
import { loadConfig, loginFor, otherConfig, type Loaded } from './start.ts'

export const DOCTOR_USAGE = 'usage: toolscript-mcp doctor [--config <path>] [--help]'

/** The longest wait for `<sandbox.node> --version`. */
const VERSION_TIMEOUT_MS = 10_000
/** The time limit of the run of `return 1`. */
const SMOKE_TIMEOUT_MS = 15_000
const SMOKE_CODE = 'return 1'
const MAX_STDERR_CHARS = 300

type Context = {
  readonly io: CheckIo
  readonly file: string
  readonly loaded: Loaded
  /** The servers once each one connected or failed, or undefined without a config. The policy check reads them too. */
  readonly states: Promise<readonly SettledState[]> | undefined
}

/** A command of the CLI with `--config` when the config is not the usual one. */
const command = ({ io, file }: Context, words: string): string => {
  const other = otherConfig(file, io.env, io.platform, io.home)
  return `${launchText(io.launch, io.platform)} ${words}${other === undefined ? '' : ` --config ${pathWord(other, io.platform)}`}`
}

const nodeVersion = async (node: string): Promise<Finding> => {
  try {
    const { stdout } = await promisify(execFile)(node, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    })
    return nodeFinding(`sandbox.node ${node}:`, stdout)
  } catch (err) {
    return fail(`cannot run sandbox.node ${node}: ${errorText(err)}`)
  }
}

/** The text of a run that did not return 1. */
const smokeProblem = (outcome: RunnerDone | RunnerError | undefined, stderr: string, ended: string): string => {
  if (outcome?.t === 'done') return `the run of "${SMOKE_CODE}" returned ${outcome.value}, not 1`
  if (outcome?.t === 'error') return `the run of "${SMOKE_CODE}" failed: ${outcome.message}`
  const tail = stderr.trim()
  return `the sandbox gave no answer: ${ended}${tail === '' ? '' : `. Its stderr ends with: ${tail}`}`
}

/** Runs `return 1` in the sandbox, with the launch of run_code. */
const smokeRun = async (node: string): Promise<Finding> => {
  const xdir = await makeExchangeDir()
  const started = performance.now()
  try {
    const sandbox = launch({ node, runner: RUNNER, xdir, timeoutMs: SMOKE_TIMEOUT_MS, code: SMOKE_CODE })
    let buffer = ''
    let stderr = ''
    let outcome: RunnerDone | RunnerError | undefined
    sandbox.child.stdout.setEncoding('utf8')
    sandbox.child.stdout.on('data', (piece: string) => {
      const taken = takeMessages(buffer + piece)
      buffer = taken.rest
      for (const m of taken.messages) if (m.t === 'done' || m.t === 'error') outcome = m
    })
    sandbox.child.stderr.setEncoding('utf8')
    sandbox.child.stderr.on('data', (piece: string) => (stderr = (stderr + piece).slice(-MAX_STDERR_CHARS)))
    const ending = await sandbox.ended
    const ms = Math.round(performance.now() - started)
    if (outcome?.t === 'done' && outcome.value === '1') return ok(`a run of "${SMOKE_CODE}" returned 1 in ${ms} ms`)
    const ended =
      ending.kind === 'failed'
        ? `it did not start with Node ${node}: ${ending.error.message}`
        : ending.kind === 'timeout'
          ? `it did not end within ${SMOKE_TIMEOUT_MS / 1000} s`
          : `it ended with ${ending.signal ?? `exit code ${ending.code}`}`
    return fail(smokeProblem(outcome, stderr, ended))
  } catch (err) {
    return fail(`cannot start the sandbox: ${errorText(err)}`)
  } finally {
    await removeExchangeDir(xdir).catch(() => {})
  }
}

/** The layers that differ between systems, as LAYERS names them for this one. */
const layerFindings = (): Finding[] => [
  LAYERS.network === 'none'
    ? warn('no network block on this system: a program can reach the network')
    : ok(`network block: ${LAYERS.network}`),
  LAYERS.cpuLimit
    ? ok('CPU limit: ulimit -t')
    : warn('no CPU limit on this system: only the host kill timer ends a busy run, at sandbox.timeoutSeconds'),
  ok(`environment of the sandbox: ${LAYERS.env}`),
]

/** Makes `dir` when it does not exist, and removes each folder that it made, from the deepest up. */
const withFolder = async <T>(dir: string, use: (made: boolean) => Promise<T>): Promise<T> => {
  const made = await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    return await use(made !== undefined)
  } finally {
    if (made !== undefined)
      // rmdir removes only an empty folder: a file that a running server writes meanwhile stays.
      for (let d = path.resolve(dir); ; d = path.dirname(d)) {
        await fs.promises.rmdir(d).catch(() => {})
        if (d === path.resolve(made) || path.dirname(d) === d) break
      }
  }
}

/** The folder of toolscript-mcp in HOME, with a temp file that is gone at the end. */
const writable = async (dir: string): Promise<Finding> => {
  try {
    return await withFolder(dir, async made => {
      const probe = path.join(dir, `.doctor-${randomUUID()}.tmp`)
      await fs.promises.writeFile(probe, '', { flag: 'wx', mode: 0o600 })
      await fs.promises.rm(probe, { force: true })
      return ok(made ? `${dir} does not exist yet, and toolscript-mcp can make it` : `${dir} is writable`)
    })
  } catch (err) {
    return fail(`${dir} is not writable: ${errorText(err)}`)
  }
}

/** The OAuth stores of servers that the config no longer has, or whose URL changed. */
const staleStores = async (home: string, loaded: Loaded): Promise<Finding[]> => {
  if (!loaded.ok) return []
  const folder = oauthFolder(home)
  let files: string[]
  try {
    files = await fs.promises.readdir(folder)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    return [warn(`cannot read ${folder}: ${errorText(err)}`)]
  }
  const used = new Set(
    [...loaded.config.servers].flatMap(([key, s]) =>
      s.kind === 'http' && s.oauth !== undefined ? [path.basename(storeFile(home, key, s.url))] : [],
    ),
  )
  const keys = staleStoreKeys(files, used)
  return keys.length === 0
    ? []
    : [
        warn(
          `OAuth tokens that no server of the config uses: ${keys.map(shownName).join(', ')}. The server is gone or its URL changed. Delete the file of each in ${folder} if you do not need it`,
        ),
      ]
}

const CHECKS: Record<CheckName, (c: Context) => Promise<readonly Finding[]>> = {
  node: async ({ loaded }) => [
    nodeFinding('this Node', process.version),
    ...(loaded.ok ? [await nodeVersion(loaded.config.sandbox.node)] : []),
  ],

  config: async c => {
    const { loaded, file } = c
    if (loaded.ok) return [ok(file)]
    if (loaded.missing)
      return [
        fail(
          `no config at ${file}. Run \`${command(c, 'init')}\` to write one from the MCP servers of your clients, or name the config with --config`,
        ),
      ]
    return loaded.lines.map(line => fail(line.trim()))
  },

  servers: async c => {
    const { io, file, loaded, states } = c
    if (!loaded.ok || states === undefined) return [info('skipped, because the config did not load')]
    const settled = await states
    if (settled.length === 0)
      return [
        warn(
          `the config has no server. Run \`${command(c, 'init --list')}\` to see the servers of your clients, then add one with init --add`,
        ),
      ]
    const login = loginFor(io.launch, file, io.env, io.platform, io.home)
    return settled.map(s => {
      const entry = loaded.config.servers.get(s.key)
      return serverFinding(s, entry !== undefined && entry.kind !== 'invalid' && entry.untrusted === true, login(s.key))
    })
  },

  policy: async ({ loaded, states }) => {
    if (!loaded.ok || states === undefined) return [info('skipped, because the config did not load')]
    return policyFindings(loaded.config.policy, loaded.config.bridges, await states)
  },

  sandbox: async ({ loaded }) => [
    ...layerFindings(),
    await smokeRun(loaded.ok ? loaded.config.sandbox.node : process.execPath),
  ],

  'run-log': async c => {
    const { io, file, loaded } = c
    const log = runLogFile(io.home)
    if (loaded.ok && !loaded.config.log)
      return [
        warn(`off: the config sets "log": false, so toolscript-mcp writes no run log, and runs cannot check a run`),
      ]
    const head = ok(`${loaded.ok ? 'on' : 'on, unless the config sets "log": false'}: ${log}`)
    const entries = await readRunLog(io.home).catch((err: unknown) => errorText(err))
    if (typeof entries === 'string') return [head, warn(`cannot read the run log: ${entries}`)]
    const report = runsReport(entries, { server: undefined, last: 1, since: undefined }, toolsFor(io, file))
    const newest = report.lines[0]!
    if (newest === 'no run yet') return [head, info(newest)]
    return [
      head,
      report.ok
        ? ok(`newest run: ${newest}`)
        : warn(`newest run: ${newest}. Run \`${command(c, 'runs')}\` to see its calls and the next step`),
    ]
  },

  files: async ({ io, loaded }) => [await writable(appPath(io.home)), ...(await staleStores(io.home, loaded))],
}

/** Runs `doctor` with these arguments and returns the exit code. */
export const runDoctor = async (args: readonly string[], io: CheckIo): Promise<number> => {
  let values
  try {
    ;({ values } = parseArgs({
      args: [...args],
      options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    }))
  } catch (err) {
    io.print(`${errorText(err)}\n${DOCTOR_USAGE}`)
    return 2
  }
  if (values.help) {
    io.print(DOCTOR_USAGE)
    return 0
  }
  const file = configPath(values.config, io.env, io.platform, io.home)
  const loaded = loadConfig(file, io.env, io.platform)
  const states = loaded.ok ? connectStates(loaded.config.servers, io, file, 'doctor') : undefined
  const context: Context = { io, file, loaded, states }
  // The checks run at once, and print in the order of CHECK_NAMES.
  const found = await Promise.all(
    CHECK_NAMES.map(name =>
      CHECKS[name](context).then(
        findings => findings.map(f => ({ ...f, name })),
        (err: unknown) => [{ ...fail(`the check stopped: ${errorText(err)}`), name }],
      ),
    ),
  )
  const checks = found.flat()
  io.print(checks.map(checkLine).join('\n'))
  return doctorExit(checks)
}
