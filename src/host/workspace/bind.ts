// Binds a session to its Workspace root, one time at the start (issue #144): the real path of each entry of
// `workspace.roots`, the refusal of a bad root, the choice of the session root, the first-use test of the confined
// file system, and the provider. The result is either a `Bound` workspace or a reason in our own text. Each reason names
// the entry by its place and never shows a path. The server never reads the section again after this.

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Config } from '../../core/config.ts'
import { appPath } from '../../core/paths.ts'
import { fileUriPath, narrowRoot } from '../../core/roots.ts'
import {
  LIMITS,
  WorkspaceError,
  bindRoot,
  makeExcluder,
  rootProblem,
  type RealRoot,
  type WorkspaceConfig,
} from '../../core/workspace.ts'
import { openConfined, type Hook, type Method } from './confined.ts'
import { createProvider, type Provider, type ProviderOptions } from './provider.ts'
import { createTaskRunner, resolveTasks, type InvalidTask, type TaskRunner, type TaskSet } from './task.ts'

const realpathNative = promisify(fs.realpath.native)

/** What `connectAll` needs: a new link to the provider, or why there is none. */
export type WorkspaceLink =
  | { readonly ok: true; readonly serve: () => Promise<Transport> }
  | { readonly ok: false; readonly reason: string }

export type Bound = {
  /** The real path of the session root. */
  readonly root: string
  /** The `write` grant of the entry that the root is in: `edit` and `write` are listed only with it. */
  readonly write: boolean
  readonly method: Method
  readonly provider: Provider
  /** The tasks of the entry that the root is in: the names that can run, and the ones that cannot, with the reason. */
  readonly tasks: { readonly names: readonly string[]; readonly invalid: readonly InvalidTask[] }
}

export type Binding = { readonly ok: true; readonly bound: Bound } | { readonly ok: false; readonly reason: string }

export type BindInput = {
  readonly workspace: WorkspaceConfig
  /** The folder where the client started the server. */
  readonly start: string
  readonly home: string
  readonly configFile: string
  readonly log: (line: string) => void
  readonly platform?: string
  readonly hook?: Hook
  readonly limits?: ProviderOptions['limits']
  /** The environment of the server: its `PATH` finds the command of a task, and a short list of it reaches the task. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly locks?: ProviderOptions['locks']
  /**
   * The `uri` of the client roots (issue #150), settled one time. They only narrow the root of the session: each one
   * is proven here, and one that fails a step grants nothing. Absent: the root is the bound root.
   */
  readonly clientRoots?: () => Promise<readonly unknown[]>
}

const real = (file: string): Promise<string> => realpathNative(file)

/**
 * The root after the client roots: the bound root, or a folder inside it. Each entry goes through `fileUriPath`, then
 * `realpath`, then it must be a folder that `rootProblem` accepts. An entry that fails a step grants nothing and is
 * dropped. The log says how many were dropped and never shows a URI.
 */
const narrowed = async (
  bound: string,
  uris: readonly unknown[],
  homeReal: string,
  platform: string,
  log: (line: string) => void,
): Promise<string> => {
  const read = uris.slice(0, LIMITS.roots)
  const kept: string[] = []
  for (const uri of read) {
    const text = fileUriPath(uri, platform)
    const found =
      text === undefined
        ? undefined
        : await real(text).then(
            async p => ((await fs.promises.stat(p)).isDirectory() ? p : undefined),
            () => undefined,
          )
    if (found !== undefined && rootProblem(found, homeReal, platform) === undefined) kept.push(found)
  }
  if (kept.length < read.length)
    log(`Workspace: ${read.length - kept.length} of ${read.length} client roots were dropped`)
  const root = narrowRoot(bound, kept, platform)
  if (root !== bound) log(`Workspace: a client root narrowed the root to ${root}`)
  return root
}

export const bindWorkspace = async ({
  workspace,
  start,
  home,
  configFile,
  log,
  platform = process.platform,
  hook,
  limits,
  env = process.env,
  locks,
  clientRoots,
}: BindInput): Promise<Binding> => {
  const refuse = (reason: string): Binding => ({ ok: false, reason })
  const homeReal = await real(home).catch(() => home)
  const roots: RealRoot[] = []
  for (const [i, root] of workspace.roots.entries()) {
    const place = `workspace.roots[${i}].path`
    const found = await real(root.path).then(
      async p => ((await fs.promises.stat(p)).isDirectory() ? p : undefined),
      () => undefined,
    )
    if (found === undefined) return refuse(`${place} is not a folder that exists`)
    const problem = rootProblem(found, homeReal, platform)
    if (problem !== undefined) return refuse(`${place} is refused: ${problem}`)
    roots.push({ path: found, write: root.write })
  }
  const bound = bindRoot(roots, await real(start).catch(() => path.resolve(start)), platform)
  if (!bound.ok) return refuse(bound.reason)
  const problem = rootProblem(bound.root, homeReal, platform)
  if (problem !== undefined)
    return refuse(`the folder where the client started toolscript-mcp is refused as a root: ${problem}`)
  // The roots of the client only narrow the bound root. This is settled one time, before the provider exists.
  const root =
    clientRoots === undefined
      ? bound.root
      : await narrowed(bound.root, await clientRoots().catch(() => []), homeReal, platform, log)
  try {
    const confined = await openConfined(root, { platform, ...(hook !== undefined && { hook }) })
    const forbidden = [await real(configFile).catch(() => path.resolve(configFile)), appPath(homeReal)]
    const excluded = makeExcluder(root, workspace.exclude, forbidden)
    // The tasks of the entry that the root is in. A session whose entry has none runs none, and the tasks of another
    // entry are never looked at.
    const entry = roots[bound.index]!
    const configured = workspace.roots[bound.index]!.tasks ?? []
    let own: Awaited<ReturnType<typeof openConfined>> | undefined
    let set: TaskSet = { valid: [], invalid: [] }
    let tasks: TaskRunner | undefined
    if (configured.length > 0) {
      // The folder of a task is relative to the entry. The root of the session can be a folder inside the entry.
      own = entry.path === root ? undefined : await openConfined(entry.path, { platform })
      const proofFs = own ?? confined
      const entryExcluded = own === undefined ? excluded : makeExcluder(entry.path, workspace.exclude, forbidden)
      set = await resolveTasks({
        tasks: configured,
        entry: entry.path,
        source: env,
        platform,
        proof: async parts => {
          const dir = await proofFs.dir(parts)
          try {
            if (entryExcluded(dir.parts)) throw new WorkspaceError('excluded', 'the path is excluded from Workspace')
            return dir.parts
          } finally {
            await dir.close()
          }
        },
      })
      tasks = createTaskRunner(set)
    }
    const made = createProvider({
      confined,
      root,
      home: homeReal,
      write: entry.write,
      excluded,
      skip: workspace.skip,
      ...(workspace.gitignore === false && { gitignore: false }),
      windows: platform === 'win32',
      log,
      ...(limits !== undefined && { limits }),
      ...(tasks !== undefined && { tasks }),
      ...(locks !== undefined && { locks }),
    })
    // The handle of an entry other than the root closes with the provider.
    const provider: Provider =
      own === undefined ? made : { ...made, close: async () => (await made.close(), await own.close()) }
    return {
      ok: true,
      bound: {
        root,
        write: entry.write,
        method: confined.method,
        provider,
        tasks: { names: set.valid.map(t => t.name), invalid: set.invalid },
      },
    }
  } catch (err) {
    if (err instanceof WorkspaceError) return refuse(err.message)
    return refuse('Workspace could not open its root')
  }
}

/**
 * The binding of a loaded config for a command of the CLI (`tools`, `doctor`): the root is the folder where the
 * command runs. Undefined when the config has no `workspace` section. The caller closes `bound.provider`.
 */
export const bindFromConfig = (
  config: Config,
  file: string,
  io: { readonly home: string; readonly platform: string },
): Promise<Binding> | undefined =>
  config.workspace === undefined
    ? undefined
    : bindWorkspace({
        workspace: config.workspace,
        start: process.cwd(),
        home: io.home,
        configFile: file,
        log: () => {},
        platform: io.platform,
      })

/** The link that `connectAll` takes for a binding. */
export const linkOf = (binding: Binding): WorkspaceLink =>
  binding.ok ? { ok: true, serve: binding.bound.provider.serve } : { ok: false, reason: binding.reason }
