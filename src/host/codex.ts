// The Codex read of init (issue #86). Path A: the Codex CLI (`codex mcp list --json`, then `codex mcp get <name> --json`
// for each server). Path B: `$CODEX_HOME/config.toml`, through the strict reader of src/core/toml.ts. The CLI starts with
// no shell, in the home folder (never the project: Codex would load the project config there), with a time limit and an
// output cap for each call. Its output is parsed and never printed: a failure gives one fixed reason.

import crossSpawn from 'cross-spawn'
import fs from 'node:fs'
import path from 'node:path'
import { HIDDEN_KEYS, parseCodexGet, parseCodexList, SHOWN_KEYS, type CodexRaw } from '../core/codex.ts'
import type { Env } from '../core/config.ts'
import type { ClientFile, ClientRead } from '../core/init.ts'
import { readCodexToml, TOML_MAX } from '../core/toml.ts'
import { endTree } from './broker.ts'

export type CodexLimits = {
  /** For each call of the CLI. */
  readonly timeoutMs: number
  /** Of the output of each call. */
  readonly maxBytes: number
  readonly maxServers: number
}

export const CODEX_LIMITS: CodexLimits = { timeoutMs: 10_000, maxBytes: 1_000_000, maxServers: 64 }

/** The file read of the host: text, nothing there, or a reason. */
export type FileRead = { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'unreadable'; error: string }

type Run =
  | { readonly ok: true; readonly out: string }
  | { readonly ok: false; readonly missing: boolean; readonly why: string }

const seconds = (ms: number) => (ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`)

/** One call of the CLI. The reason of a failure is a fixed text: no output of the CLI goes into it. */
const runCodex = (args: readonly string[], env: Env, home: string, limits: CodexLimits): Promise<Run> =>
  new Promise(resolve => {
    // The lookup uses the PATH of `env` only: an env with no PATH has no codex, and the process PATH is not asked.
    if (!Object.entries(env).some(([k, v]) => k.toUpperCase() === 'PATH' && v)) {
      return resolve({ ok: false, missing: true, why: 'cannot start' })
    }
    const childEnv: NodeJS.ProcessEnv = { ...env, CODEX_HOME: env.CODEX_HOME || path.join(home, '.codex') }
    let child
    try {
      child = crossSpawn('codex', [...args], {
        cwd: home,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch {
      return resolve({ ok: false, missing: true, why: 'cannot start' })
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (run: Run) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(run)
    }
    const stop = (why: string) => {
      finish({ ok: false, missing: false, why })
      void endTree(child)
    }
    const timer = setTimeout(() => stop(`no answer in ${seconds(limits.timeoutMs)}`), limits.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limits.maxBytes) return stop(`more than ${limits.maxBytes} bytes of output`)
      chunks.push(chunk)
    })
    child.on('error', err =>
      finish({ ok: false, missing: (err as NodeJS.ErrnoException).code === 'ENOENT', why: 'cannot start' }),
    )
    child.on('close', code =>
      finish(
        code === 0
          ? { ok: true, out: Buffer.concat(chunks).toString('utf8') }
          : { ok: false, missing: false, why: `exit code ${code ?? 'none'}` },
      ),
    )
  })

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A name that goes to the command line as it is: no option, and no character that cmd.exe reads. */
const ASKABLE = /^[A-Za-z0-9_.][A-Za-z0-9 _.-]*$/

type Servers = (readonly [string, CodexRaw])[]

/** Path A. `missing`: there is no codex on PATH, which is no problem. */
const viaCli = async (
  env: Env,
  home: string,
  limits: CodexLimits,
): Promise<{ ok: true; servers: Servers; notes: string[] } | { ok: false; missing: boolean; why: string }> => {
  const list = await runCodex(['mcp', 'list', '--json'], env, home, limits)
  if (!list.ok) return { ok: false, missing: list.missing, why: `codex mcp list --json: ${list.why}` }
  const names = parseCodexList(parseJson(list.out))
  if (names === undefined)
    return { ok: false, missing: false, why: 'codex mcp list --json: the output is not the expected JSON' }
  const notes =
    names.length > limits.maxServers
      ? [`init read the first ${limits.maxServers} Codex servers and left out the rest.`]
      : []
  const servers: (readonly [string, CodexRaw])[] = []
  const wanted = names.slice(0, limits.maxServers)
  for (let at = 0; at < wanted.length; at += 8) {
    const batch = await Promise.all(
      wanted
        .slice(at, at + 8)
        .map(async ({ name, authStatus }): Promise<readonly [string, CodexRaw] | { why: string }> => {
          // The tool lists are in `get` only, and a rule must never be looser than Codex: no list, no import.
          if (!ASKABLE.test(name)) return [name, { skip: 'init cannot ask Codex for the tool lists of this name' }]
          const got = await runCodex(['mcp', 'get', name, '--json'], env, home, limits)
          if (!got.ok) return { why: `codex mcp get: ${got.why}` }
          const raw = parseCodexGet(parseJson(got.out), authStatus)
          return raw === undefined ? { why: 'codex mcp get --json: the output is not the expected JSON' } : [name, raw]
        }),
    )
    for (const item of batch) {
      if ('why' in item) return { ok: false, missing: false, why: item.why }
      servers.push(item)
    }
  }
  return { ok: true, servers, notes }
}

/** Path B, from the text of config.toml. */
const viaToml = (text: string, limits: CodexLimits): { servers: Servers; notes: string[] } | { why: string } => {
  const read = readCodexToml(text)
  if (!read.ok) return { why: read.why }
  const servers = read.servers.map((s): readonly [string, CodexRaw] => [
    s.name,
    'skip' in s ? { skip: s.skip } : { via: 'config.toml', fields: s.fields },
  ])
  const notes =
    servers.length > limits.maxServers
      ? [`init read the first ${limits.maxServers} Codex servers and left out the rest.`]
      : []
  return { servers: servers.slice(0, limits.maxServers), notes }
}

/** The keys of each server table of config.toml that `codex mcp get --json` does not show, or undefined when the file cannot be read. */
const unseenKeys = async (
  file: string,
  readText: (file: string) => Promise<FileRead>,
): Promise<Map<string, string[]> | undefined> => {
  const read = await readText(file)
  if (read.kind !== 'text' || read.text.length > TOML_MAX) return undefined
  const toml = readCodexToml(read.text)
  if (!toml.ok) return undefined
  return new Map(
    toml.servers.flatMap(s =>
      'fields' in s
        ? [
            [
              s.name,
              Object.keys(s.fields)
                .filter(k => !SHOWN_KEYS.includes(k))
                .sort(),
            ] as const,
          ]
        : [],
    ),
  )
}

/**
 * The Codex servers as a `ClientRead`: from the CLI, else from config.toml. `start`: the folder of the session. init
 * reads the user scope only, and says so when the project has a `.codex/config.toml`. A failed CLI call gives a note
 * and the read of config.toml. No codex on PATH gives no note.
 */
export const readCodexClient = async (
  file: ClientFile,
  env: Env,
  home: string,
  start: string,
  readText: (file: string) => Promise<FileRead>,
  limits: CodexLimits = CODEX_LIMITS,
): Promise<ClientRead> => {
  const at = { ...file, path: path.resolve(file.path) }
  const notes: string[] = []
  const project = path.join(start, '.codex', 'config.toml')
  if (
    await fs.promises.stat(project).then(
      s => s.isFile(),
      () => false,
    )
  )
    notes.push(
      `init did not read ${project}: Codex loads it only for a project that it trusts, and init cannot see that trust.`,
    )
  const cli = await viaCli(env, home, limits)
  if (cli.ok) {
    // `get --json` does not show every key of config.toml: the file gives the names of the others.
    const seen = await unseenKeys(at.path, readText)
    const servers = cli.servers.map(([name, raw]): readonly [string, CodexRaw] => {
      const extra = seen?.get(name)
      return 'fields' in raw && extra !== undefined && extra.length > 0
        ? [name, { ...raw, unseen: extra }]
        : [name, raw]
    })
    const hidden =
      seen === undefined
        ? [
            `Codex does not show these keys of a server through its CLI: ${HIDDEN_KEYS.join(', ')}. init could not read ${at.path}, so it cannot say which servers set them.`,
          ]
        : []
    return { ...at, kind: 'codex', servers, notes: [...notes, ...cli.notes, ...hidden] }
  }
  if (!cli.missing) notes.push(`${cli.why}. init read ${at.path} instead.`)
  const read = await readText(at.path)
  if (read.kind !== 'text') return { ...at, ...read, notes }
  if (read.text.length > TOML_MAX) return { ...at, kind: 'unreadable', error: 'the file is larger than 1 MB', notes }
  const toml = viaToml(read.text, limits)
  if ('why' in toml) return { ...at, kind: 'unreadable', error: `init cannot read it as TOML (${toml.why})`, notes }
  return { ...at, kind: 'codex', servers: toml.servers, notes: [...notes, ...toml.notes] }
}
