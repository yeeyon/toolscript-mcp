// Helpers of the Workspace tests: a temp tree, a bound provider and a client of it. Temp folders only, with a fake HOME.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TaskConfig } from '../src/core/task.ts'
import { DEFAULT_SKIP } from '../src/core/workspace.ts'
import { bindWorkspace, type Bound, type BindInput } from '../src/host/workspace/bind.ts'

/** A random text for a secret: no test names a real one. */
export const marker = (): string => `SECRET-${randomBytes(8).toString('hex')}`

/**
 * A new temp folder with its real path, which the test removes with `rm`. `WS_TEST_TREES` names the folder to make it in,
 * so a Docker run can put the trees on a bind mount of a Windows folder (a volume that ignores case).
 */
export const tempDir = (): string =>
  fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.WS_TEST_TREES ?? os.tmpdir(), 'ws-test-')))

/** Removes a folder. A process that Windows still ends can hold it for a moment, so a busy folder is tried again. */
export const rm = (dir: string): void =>
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })

/** Writes `files` (a path with `/` to its text or bytes) under `root`, and makes the folders. */
export const write = (root: string, files: Record<string, string | Uint8Array>): void => {
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
  }
}

export type Rig = {
  readonly root: string
  readonly home: string
  readonly config: string
  readonly bound: Bound
  readonly client: Client
  /** The structured result of a call that worked. */
  readonly call: (tool: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>
  /** The message of a call that failed. */
  readonly fail: (tool: string, args?: Record<string, unknown>) => Promise<string>
  readonly close: () => Promise<void>
}

export type RigOptions = Partial<Pick<BindInput, 'hook' | 'limits' | 'platform' | 'env' | 'locks'>> & {
  /** The tasks of each entry, by the path of the entry. */
  readonly tasks?: Readonly<Record<string, readonly TaskConfig[]>>
  /** The `write` grant of every entry. Default false. */
  readonly write?: boolean
  readonly exclude?: readonly string[]
  readonly skip?: readonly string[]
  /** The folder of the session: the root unless set. */
  readonly start?: string
  /** The entries of `workspace.roots`: the root alone unless set. */
  readonly roots?: readonly string[]
  readonly lines?: string[]
}

/** The result of `open`: a rig, or the reason that Workspace is unavailable on this system. */
export type Opened = { readonly rig: Rig } | { readonly unavailable: string }

/**
 * Binds a provider to `root` (a real path) and connects a client to it, as `connectAll` does. The files that the
 * test holds are in `root` already. The fake HOME and the config path are in new temp folders.
 */
export const open = async (root: string, options: RigOptions = {}): Promise<Opened> => {
  const home = tempDir()
  const config = path.join(home, 'toolscript.json')
  fs.writeFileSync(config, '{}')
  const binding = await bindWorkspace({
    workspace: {
      roots: (options.roots ?? [root]).map(p => ({
        path: p,
        write: options.write === true,
        ...(options.tasks?.[p] !== undefined && { tasks: options.tasks[p] }),
      })),
      exclude: options.exclude ?? [],
      skip: options.skip ?? DEFAULT_SKIP,
    },
    start: options.start ?? root,
    home,
    configFile: config,
    log: line => options.lines?.push(line),
    ...(options.hook !== undefined && { hook: options.hook }),
    ...(options.limits !== undefined && { limits: options.limits }),
    ...(options.locks !== undefined && { locks: options.locks }),
    ...(options.platform !== undefined && { platform: options.platform }),
    ...(options.env !== undefined && { env: options.env }),
  })
  if (!binding.ok) {
    rm(home)
    return { unavailable: binding.reason }
  }
  const { bound } = binding
  const client = new Client({ name: 'workspace-test', version: '0' })
  await client.connect(await bound.provider.serve())
  const run = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    client.callTool({ name: tool, arguments: args }, undefined, signal === undefined ? undefined : { signal })
  return {
    rig: {
      root,
      home,
      config,
      bound,
      client,
      call: async (tool, args = {}, signal) => {
        const r = await run(tool, args, signal)
        assert.ok(r.isError !== true, `${tool} failed: ${JSON.stringify(r.content)}`)
        return r.structuredContent
      },
      fail: async (tool, args = {}) => {
        const r = await run(tool, args)
        if (r.isError !== true)
          assert.fail(`${tool} did not fail: ${JSON.stringify(r.structuredContent)?.slice(0, 200)}`)
        const [block] = r.content as { type: string; text: string }[]
        return block!.text
      },
      close: async () => {
        await client.close()
        await bound.provider.close()
        rm(home)
      },
    },
  }
}

/** The code at the start of an error message: `link: the path ...` gives `link`. */
export const codeOf = (message: string): string => message.split(':')[0]!

/** A symlink, or undefined when this system refuses to make one (Windows without the right). */
export const trySymlink = (target: string, link: string, type: 'file' | 'dir' | 'junction'): boolean => {
  try {
    fs.symlinkSync(target, link, type)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false
    throw err
  }
}
