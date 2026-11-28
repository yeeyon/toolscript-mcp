// `toolscript-mcp doctor` checks a whole setup in one pass: Node, the config, the servers, the policy, the sandbox,
// the run log and the files in HOME. It prints one line for each finding to stderr, with the next step for a problem.
// Like tools and runs, it prints no description, argument, env or header value, or token. It changes no setting: it
// writes and removes one temp file, and a connect can refresh OAuth tokens, which the token store then holds.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import type { SettledState } from '../core/catalog.ts'
import { configPath, launchText, pathWord, type ServerKey } from '../core/config.ts'
import { WORKSPACE_KEY } from '../core/workspace.ts'
import {
  aclFinding,
  brokerFail,
  CHECK_NAMES,
  checkLine,
  doctorExit,
  fail,
  info,
  lazyFindings,
  nodeFinding,
  ok,
  policyFindings,
  serverFinding,
  shareFindings,
  staleStoreKeys,
  taskEndFinding,
  warn,
  workspaceAclFinding,
  type CheckName,
  type Finding,
} from '../core/doctor.ts'
import { appPath, brokerFolder, oauthFolder, runLogFile } from '../core/paths.ts'
import { shownName } from '../core/policy.ts'
import { errorText, takeMessages, type RunnerDone, type RunnerError } from '../core/protocol.ts'
import { futureLine, isFuture } from '../core/runlog.ts'
import { classify } from '../core/share.ts'
import { isLazy } from '../core/lazy.ts'
import { brokerFileBeside, idOf, openLink } from './brokerlink.ts'
import { connectStates, readRunLog, type CheckIo } from './diagnose.ts'
import { LAYERS, RUNNER, launch, makeExchangeDir, removeExchangeDir } from './launch.ts'
import { storeFile } from './oauth.ts'
import { createGuard } from './childguard.ts'
import { GUARD_ENV, offLine, windowsFailure } from '../core/childguard.ts'
import { probeHelper } from './taskjob.ts'
import { loadToolsCache, toolsKey } from './toolscache.ts'
import { loadConfig, loginFor, otherConfig, type Loaded } from './start.ts'
import { bindFromConfig, linkOf, type Binding } from './workspace/bind.ts'

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
  /** The binding of the built-in Workspace, or undefined when the config has no `workspace` section. */
  readonly workspace: Promise<Binding | undefined>
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

/**
 * The user's SID, then `SID|Allow or Deny|rights` for each access rule of the folder, by SID and not by a name that the
 * system language changes. It is empty when the read fails. The path goes in as an argument, not in the script.
 */
export const readAcl = async (folder: string): Promise<string> => {
  const script =
    '$u = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $u; ' +
    '(New-Object System.IO.DirectoryInfo $args[0]).GetAccessControl().GetAccessRules($true, $true, ' +
    '[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { ' +
    '$_.IdentityReference.Value + "|" + $_.AccessControlType + "|" + $_.FileSystemRights }'
  try {
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `& { ${script} } '${folder.replaceAll("'", "''")}'`],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true },
    )
    return stdout
  } catch {
    return ''
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

/** `dir`, or its deepest parent that exists, and whether it is a folder. */
const deepestExisting = async (dir: string): Promise<{ path: string; folder: boolean }> => {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    try {
      return { path: d, folder: (await fs.promises.stat(d)).isDirectory() }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || path.dirname(d) === d) throw err
    }
  }
}

/**
 * The folder of toolscript-mcp in HOME. A temp file goes into the folder, or into its deepest parent that exists when
 * the folder does not exist, and is gone at the end. doctor makes no folder.
 */
const writable = async (dir: string): Promise<Finding> => {
  try {
    const { path: base, folder } = await deepestExisting(dir)
    if (!folder)
      return fail(
        base === path.resolve(dir)
          ? `${dir} is not a folder. Move the file, so toolscript-mcp can make the folder`
          : `${base} is not a folder, so toolscript-mcp cannot make ${dir}. Move the file`,
      )
    const probe = path.join(base, `.doctor-${randomUUID()}.tmp`)
    await fs.promises.writeFile(probe, '', { flag: 'wx', mode: 0o600 })
    await fs.promises.rm(probe, { force: true })
    return ok(
      base === path.resolve(dir) ? `${dir} is writable` : `${dir} does not exist yet, and toolscript-mcp can make it`,
    )
  } catch (err) {
    return fail(`${dir} is not writable: ${errorText(err)}`)
  }
}

/** The OAuth stores that no server of this config uses. The folder is shared, so a store can belong to another config. */
const staleStores = async (home: string, loaded: Loaded): Promise<Finding[]> => {
  if (!loaded.ok) return []
  const folder = oauthFolder(home)
  let files: string[]
  try {
    files = await fs.promises.readdir(folder)
  } catch (err) {
    // POSIX gives ENOTDIR when a file is where a parent folder goes, Windows ENOENT. The files check reports that file.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
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
        info(
          `OAuth tokens that no server of this config uses: ${keys.map(shownName).join(', ')}. They can belong to another config, or the server is gone or its URL changed. If no other config uses the server, you can delete its file in ${folder}`,
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

  // One line: off, the root with its grants, or the reason. On Windows, also the access rules of the root. A section
  // with errors, or a clash of keys, shows in the servers check as an invalid entry.
  workspace: async ({ io, loaded, workspace }) => {
    if (!loaded.ok) return []
    const entry = loaded.config.servers.get(WORKSPACE_KEY as ServerKey)
    if (entry?.kind === 'invalid') return []
    const bound = await workspace
    if (bound === undefined) return [info('off: the config has no "workspace" section')]
    if (!bound.ok) return [fail(`unavailable: ${bound.reason}`)]
    const { root, write, method, tasks } = bound.bound
    return [
      ok(
        `root ${root}, ${write ? 'read and write (edit and write ask the person)' : 'read-only'}, confined by ${method}${tasks.names.length > 0 ? `, tasks: ${tasks.names.join(', ')}` : ''}`,
      ),
      ...tasks.invalid.map(t => warn(`task ${t.name} is invalid: ${t.reason}`)),
      // One real start of the helper that ends a task with its tree. It runs no task of the config.
      ...(tasks.names.length > 0 ? [taskEndFinding(process.platform, await probeHelper())] : []),
      ...(io.platform === 'win32' ? [workspaceAclFinding(await readAcl(root))] : []),
    ]
  },

  share: async ({ loaded }) => (loaded.ok ? shareFindings(loaded.config) : []),

  broker: async ({ io, loaded }) => {
    if (!loaded.ok || !loaded.config.share.on) return []
    const { servers, bridges } = loaded.config
    const linked = [...servers].some(([key, server]) => {
      const c = classify(key, server, bridges)
      return c !== undefined && c.class !== 'session'
    })
    if (!linked) return []
    const file = brokerFileBeside(import.meta.url)
    const answered = await (async (): Promise<Finding> => {
      try {
        // The handshake only: no entry goes over, so no downstream server starts. It may start the broker.
        const { socket } = await openLink({ home: io.home, brokerFile: file })
        socket.destroy()
        return ok(`build ${idOf(file!).slice(0, 8)}: the broker answered and proved the key`)
      } catch (err) {
        return brokerFail(errorText(err), io.platform)
      }
    })()
    // Only here, never in the server: one hidden read of the access rules of the broker folder.
    const folder = brokerFolder(io.home)
    return io.platform === 'win32' && fs.existsSync(folder) ? [answered, aclFinding(await readAcl(folder))] : [answered]
  },

  // Reads the cache file only. No server starts for this line.
  lazy: async ({ io, loaded }) => {
    if (!loaded.ok) return []
    const { config } = loaded
    const cache = await loadToolsCache(io.home, () => {})
    return lazyFindings(config, key => {
      const server = config.servers.get(key)
      return server?.kind === 'stdio' && isLazy(key, server, config.bridges, true)
        ? cache.get(toolsKey(server))?.tools.length
        : undefined
    })
  },

  // Starts the guard and waits for it, then ends it: on Windows this compiles the program the first time.
  'child-guard': async ({ io }) => {
    const guard = createGuard({ home: io.home, log: () => {}, platform: io.platform, env: io.env })
    if (guard.state().state === 'unwanted')
      return [
        info(
          io.platform === 'win32'
            ? `off on Windows (opt-in). Set ${GUARD_ENV}=1 to turn it on: a compiled program then ends the servers of a host that was killed`
            : `off by ${GUARD_ENV}=0. A host that is killed leaves its servers running`,
        ),
      ]
    guard.start()
    const settled = await guard.settled()
    guard.close()
    if (settled.state === 'on') return [ok(`${settled.how} ends the servers of a host that was killed`)]
    const why = settled.state === 'failed' ? settled.why : 'it did not start'
    return [warn(offLine(io.platform === 'win32' ? windowsFailure(why) : why))]
  },

  policy: async ({ loaded, states }) => {
    if (!loaded.ok || states === undefined) return [info('skipped, because the config did not load')]
    return policyFindings(loaded.config.policy, loaded.config.guards, await states)
  },

  sandbox: async ({ loaded }) => [
    ...layerFindings(),
    await smokeRun(loaded.ok ? loaded.config.sandbox.node : process.execPath),
  ],

  'run-log': async c => {
    const { io, loaded } = c
    const log = runLogFile(io.home)
    if (loaded.ok && !loaded.config.log)
      return [
        warn(`off: the config sets "log": false, so toolscript-mcp writes no run log, and runs cannot check a run`),
      ]
    const head = ok(`${loaded.ok ? 'on' : 'on, unless the config sets "log": false'}: ${log}`)
    const entries = await readRunLog(io.home).catch((err: unknown) => errorText(err))
    if (typeof entries === 'string') return [head, warn(`cannot read the run log: ${entries}`)]
    // The rule of runs, so that both show the same newest run.
    const now = new Date()
    const readable = entries.filter(e => e !== 'unreadable')
    const future = readable.filter(e => isFuture(e, now)).length
    const skipped = future === 0 ? [] : [info(futureLine(future))]
    const newest = readable.findLast(e => !isFuture(e, now))
    if (newest === undefined) return [head, info('no run yet'), ...skipped]
    // The ending is a fact about the last task, not about the setup: only a run that did not end done is a problem.
    const text = `newest run: ${shownName(newest.time)} ${newest.ending} ${newest.ms} ms`
    if (newest.ending !== 'done')
      return [head, warn(`${text}. Run \`${command(c, 'runs')}\` to see its calls and the next step`), ...skipped]
    return [head, newest.calls.length === 0 ? info(`${text}. It called no tool`) : ok(text), ...skipped]
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
  const workspace = (loaded.ok ? bindFromConfig(loaded.config, file, io) : undefined) ?? Promise.resolve(undefined)
  const states = loaded.ok
    ? workspace.then(binding => connectStates(loaded.config.servers, io, file, 'doctor', binding && linkOf(binding)))
    : undefined
  const context: Context = { io, file, loaded, states, workspace }
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
  const bound = await workspace
  if (bound?.ok) await bound.bound.provider.close()
  io.print(checks.map(checkLine).join('\n'))
  return doctorExit(checks)
}
