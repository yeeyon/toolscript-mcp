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
import {
  WorkspaceError,
  bindRoot,
  makeExcluder,
  rootProblem,
  type RealRoot,
  type WorkspaceConfig,
} from '../../core/workspace.ts'
import { openConfined, type Hook, type Method } from './confined.ts'
import { createProvider, type Provider, type ProviderOptions } from './provider.ts'

const realpathNative = promisify(fs.realpath.native)

/** What `connectAll` needs: a new link to the provider, or why there is none. */
export type WorkspaceLink =
  | { readonly ok: true; readonly serve: () => Promise<Transport> }
  | { readonly ok: false; readonly reason: string }

export type Bound = {
  /** The real path of the session root. */
  readonly root: string
  /** The grant of the entry that the root is in. Before the editing tools, it has no effect. */
  readonly write: boolean
  readonly method: Method
  readonly provider: Provider
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
}

const real = (file: string): Promise<string> => realpathNative(file)

export const bindWorkspace = async ({
  workspace,
  start,
  home,
  configFile,
  log,
  platform = process.platform,
  hook,
  limits,
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
  try {
    const confined = await openConfined(bound.root, { platform, ...(hook !== undefined && { hook }) })
    const forbidden = [await real(configFile).catch(() => path.resolve(configFile)), appPath(homeReal)]
    const provider = createProvider({
      confined,
      excluded: makeExcluder(bound.root, workspace.exclude, forbidden),
      skip: workspace.skip,
      windows: platform === 'win32',
      log,
      ...(limits !== undefined && { limits }),
    })
    return {
      ok: true,
      bound: { root: bound.root, write: roots[bound.index]!.write, method: confined.method, provider },
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
