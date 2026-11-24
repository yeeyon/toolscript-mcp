// The confined file system of the Workspace (issue #144, docs/adr/0144-workspace-provider.md, section Confinement).
// Rule: no result holds a byte or a name that did not come through a proven handle: an open file or folder that is
// shown to be inside the root, with no link on the way. This module never follows a symlink or a junction, and it
// refuses a file with more than one hard link. Each OS has its own proof:
//   Linux    open one part at a time with O_NOFOLLOW, relative to the held folder (/proc/self/fd/<fd>/<part>), so a
//            later swap of a name changes nothing that is held.
//   macOS    open the full path with O_NOFOLLOW_ANY: the kernel refuses a symlink in any part.
//   Windows  open the full path, then two times realpath.native and lstat must give the identity of the handle.
//            A process that swaps a folder at each lookup can still win (the ADR names this case).
// The first use tests the method. When the test fails, Workspace is unavailable, with the reason.
// `Hook` runs before each lookup of a name, so a test can swap a folder between two lookups.

import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { WorkspaceError, fold, isInside } from '../../core/workspace.ts'

const realpathNative = promisify(fs.realpath.native)

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
/** `O_NOFOLLOW_ANY` of macOS (sys/fcntl.h): fails when any part of the path is a symlink. Node has no name for it. */
const O_NOFOLLOW_ANY = 0x20000000

export type Kind = 'file' | 'folder' | 'link' | 'other'

/** What a name in a folder is, without following it. `real`: the name as the volume spells it. */
export type Entry = { readonly kind: Kind; readonly size: number; readonly real: string }

/** Runs before each lookup of a name. A test swaps a folder in it. */
export type Hook = (lookup: 'open' | 'realpath' | 'lstat' | 'readdir') => void | Promise<void>

/** A proven open file. The caller reads through `handle` and closes it. `parts`: its path as the volume spells it. */
export type Opened = { readonly handle: FileHandle; readonly size: number; readonly parts: readonly string[] }

/** A proven folder. `parts`: its path from the root as the volume spells it. */
export type Dir = {
  readonly parts: readonly string[]
  /** The names in the folder. They are candidates: open or look at each one before it is returned. */
  names(): Promise<string[]>
  /** What `name` is, or undefined when it is gone. `spell`: also the name as the volume spells it. */
  lstat(name: string, spell?: boolean): Promise<Entry | undefined>
  openFile(name: string): Promise<Opened>
  openDir(name: string): Promise<Dir>
  close(): Promise<void>
}

export type Method = 'proc' | 'nofollow-any' | 'realpath'

export type Confined = {
  readonly method: Method
  /** The root folder, after a check that the root is still the folder that was opened. Never close it. */
  root(): Promise<Dir>
  dir(parts: readonly string[]): Promise<Dir>
  file(parts: readonly string[]): Promise<Opened>
  close(): Promise<void>
}

export type ConfinedOptions = {
  /** `process.platform` unless a test says another one. */
  readonly platform?: string
  readonly hook?: Hook
}

const unavailable = (why: string): WorkspaceError =>
  new WorkspaceError('unavailable', `Workspace is not available on this system: ${why}`)

/** The error of a failed call as a WorkspaceError. The text names the code of the error and no path. */
const mapError = (err: unknown): WorkspaceError => {
  if (err instanceof WorkspaceError) return err
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return new WorkspaceError('not-found', 'there is nothing at this path')
  if (code === 'ELOOP' || code === 'EMLINK') return new WorkspaceError('link', 'the path goes through a link')
  if (code === 'EISDIR') return new WorkspaceError('not-file', 'the path is a folder')
  return new WorkspaceError('io', `the file system refused the call (${typeof code === 'string' ? code : 'error'})`)
}

const linkError = (): WorkspaceError =>
  new WorkspaceError('link', 'the path goes through a link: Workspace never follows a symlink or a junction')

const kindOf = (st: fs.Stats | fs.BigIntStats): Kind =>
  st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'folder' : 'other'

const idOf = (st: fs.BigIntStats): string => `${st.dev}:${st.ino}`

/** `lstat`, or undefined when nothing is there. */
const lstatOrNothing = async (file: string): Promise<fs.Stats | undefined> => {
  try {
    return await fs.promises.lstat(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw mapError(err)
  }
}

/** The checks of a file after its open: a plain file with one name. */
const checkedFile = async (handle: FileHandle, parts: readonly string[]): Promise<Opened> => {
  try {
    const st = await handle.stat({ bigint: true })
    if (!st.isFile()) throw new WorkspaceError('not-file', 'the path is not a file')
    if (st.ino === 0n) throw unavailable('the volume gives no file identity')
    if (st.nlink > 1n) throw new WorkspaceError('hard-link', 'the file has more than one name (a hard link)')
    return { handle, size: Number(st.size), parts }
  } catch (err) {
    await handle.close().catch(() => {})
    throw mapError(err)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The test of the method

/**
 * Tests the proof of this OS on a temp folder, one time for each process and platform. A failed test makes Workspace
 * unavailable. A pass shows that the method refuses a link in a part, and on Linux that a held folder ignores a later
 * swap of its name.
 */
const tested = new Map<string, Promise<void>>()

const methodTest = async (platform: string): Promise<void> => {
  const tmp = await fs.promises.mkdtemp(path.join(await realpathNative(os.tmpdir()), 'toolscript-ws-'))
  try {
    const real = await realpathNative(tmp)
    await fs.promises.mkdir(path.join(real, 'a'))
    await fs.promises.writeFile(path.join(real, 'a', 'f.txt'), 'inside')
    const expectFail = async (open: () => Promise<FileHandle>, what: string) => {
      const handle = await open().catch(() => undefined)
      if (handle !== undefined) {
        await handle.close()
        throw unavailable(what)
      }
    }
    if (platform === 'linux') {
      await fs.promises.symlink(path.join(real, 'a'), path.join(real, 'l'), 'dir')
      const R = await fs.promises.open(real, O_RDONLY | O_DIRECTORY)
      try {
        const at = (h: FileHandle, name: string) => `/proc/self/fd/${h.fd}/${name}`
        const A = await fs.promises.open(at(R, 'a'), O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        try {
          await expectFail(
            () => fs.promises.open(at(R, 'l'), O_RDONLY | O_DIRECTORY | O_NOFOLLOW),
            'O_NOFOLLOW opened a symlink',
          )
          // A held folder keeps its identity when its name is swapped for a link.
          await fs.promises.rename(path.join(real, 'a'), path.join(real, 'a2'))
          await fs.promises.symlink(real, path.join(real, 'a'), 'dir')
          const f = await fs.promises.open(at(A, 'f.txt'), O_RDONLY | O_NOFOLLOW)
          const text = await f.readFile('utf8').finally(() => f.close())
          if (text !== 'inside') throw unavailable('a held folder followed a swapped name')
          await expectFail(
            () => fs.promises.open(at(R, 'a'), O_RDONLY | O_DIRECTORY | O_NOFOLLOW),
            'O_NOFOLLOW opened a swapped link',
          )
        } finally {
          await A.close()
        }
      } finally {
        await R.close()
      }
    } else if (platform === 'darwin') {
      await fs.promises.symlink(path.join(real, 'a'), path.join(real, 'l'), 'dir')
      const good = await fs.promises.open(path.join(real, 'a', 'f.txt'), O_RDONLY | O_NOFOLLOW_ANY)
      await good.close()
      await expectFail(
        () => fs.promises.open(path.join(real, 'l', 'f.txt'), O_RDONLY | O_NOFOLLOW_ANY),
        'O_NOFOLLOW_ANY opened a path with a symlink in a middle part',
      )
    } else if (platform === 'win32') {
      await fs.promises.symlink(path.join(real, 'a'), path.join(real, 'j'), 'junction')
      if (!(await fs.promises.lstat(path.join(real, 'j'))).isSymbolicLink())
        throw unavailable('a junction shows as a folder')
      const through = path.join(real, 'j', 'f.txt')
      if (fold(await realpathNative(through)) === fold(through))
        throw unavailable('realpath does not resolve a junction')
      const h = await fs.promises.open(path.join(real, 'a', 'f.txt'), 'r')
      try {
        if ((await h.stat({ bigint: true })).ino === 0n) throw unavailable('the volume gives no file identity')
      } finally {
        await h.close()
      }
    } else throw unavailable(`${platform} has no confined file system yet`)
  } catch (err) {
    throw err instanceof WorkspaceError
      ? err
      : unavailable(`the method test failed (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

const ensureMethod = (platform: string): Promise<void> => {
  let test = tested.get(platform)
  if (test === undefined) tested.set(platform, (test = methodTest(platform)))
  return test
}

// ---------------------------------------------------------------------------------------------------------------
// Linux: one part at a time, relative to a held folder

const procDir = (handle: FileHandle, parts: readonly string[], owned: boolean, hook: Hook): Dir => {
  const at = (name: string) => `/proc/self/fd/${handle.fd}/${name}`
  /** An open that failed on `name`: a link when `name` is one, else the error. */
  const refused = async (err: unknown, name: string): Promise<WorkspaceError> => {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EMLINK') {
      const st = await lstatOrNothing(at(name)).catch(() => undefined)
      if (st?.isSymbolicLink()) return linkError()
      if (st !== undefined && code === 'ENOTDIR') return new WorkspaceError('not-folder', 'the path is not a folder')
    }
    return mapError(err)
  }
  const dir: Dir = {
    parts,
    names: async () => {
      await hook('readdir')
      return fs.promises.readdir(`/proc/self/fd/${handle.fd}`).catch(err => Promise.reject(mapError(err)))
    },
    lstat: async name => {
      await hook('lstat')
      const st = await lstatOrNothing(at(name))
      return st === undefined ? undefined : { kind: kindOf(st), size: st.size, real: name }
    },
    openFile: async name => {
      await hook('open')
      const opened = await fs.promises.open(at(name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch(async err => {
        throw await refused(err, name)
      })
      return checkedFile(opened, [...parts, name])
    },
    openDir: async name => {
      await hook('open')
      const opened = await fs.promises.open(at(name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch(async err => {
        throw await refused(err, name)
      })
      return procDir(opened, [...parts, name], true, hook)
    },
    close: async () => {
      if (owned) await handle.close().catch(() => {})
    },
  }
  return dir
}

// ---------------------------------------------------------------------------------------------------------------
// Windows and macOS: the full path, proven as a whole

/** The parts of `real` below `root` as the volume spells them, or undefined when `real` is not below it. */
const below = (real: string, root: string, platform: string): string[] | undefined => {
  if (!isInside(real, root, platform)) return undefined
  const all = real.split(/[\\/]+/).filter(p => p !== '')
  return all.slice(root.split(/[\\/]+/).filter(p => p !== '').length)
}

const sameParts = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((part, i) => fold(part) === fold(b[i]!))

const pathConfined = (root: string, rootId: string, platform: string, hook: Hook): Confined => {
  const windows = platform === 'win32'
  const full = (parts: readonly string[]) => path.join(root, ...parts)

  /** The real parts of `real`, or a `link` error when it is outside the root. */
  const insideParts = (real: string): string[] => {
    const parts = below(real, root, platform)
    if (parts === undefined) throw linkError()
    return parts
  }

  // Windows: `realpath.native` and `lstat` must agree, two times, with the identity of the handle. The names can
  // differ in case or by a short name. A link in a part is then found by `lstat` on each part.
  const proveWindows = async (parts: readonly string[], handle: FileHandle): Promise<string[]> => {
    const st = await handle.stat({ bigint: true })
    if (st.ino === 0n) throw unavailable('the volume gives no file identity')
    const id = idOf(st)
    let real: string | undefined
    for (let round = 0; round < 2; round++) {
      await hook('realpath')
      const now = await realpathNative(full(parts))
      if (real === undefined) real = now
      else if (now !== real) throw linkError()
      await hook('lstat')
      const ls = await fs.promises.lstat(now, { bigint: true })
      if (ls.isSymbolicLink() || idOf(ls) !== id) throw linkError()
    }
    const seen = insideParts(real!)
    if (!sameParts(seen, parts)) {
      if (seen.length !== parts.length) throw linkError()
      for (let i = 1; i <= parts.length; i++) {
        await hook('lstat')
        if ((await lstatOrNothing(full(parts.slice(0, i))))?.isSymbolicLink()) throw linkError()
      }
    }
    return seen
  }

  // macOS: the open refused a link already. `realpath` gives the spelling that the volume uses.
  const spellMac = async (parts: readonly string[]): Promise<string[]> => {
    await hook('realpath')
    const seen = insideParts(await realpathNative(full(parts)))
    if (seen.length !== parts.length) throw linkError()
    return seen
  }

  const opened = async (parts: readonly string[], folder: boolean): Promise<{ handle: FileHandle; real: string[] }> => {
    await hook('open')
    const handle = await (
      windows
        ? fs.promises.open(full(parts), 'r')
        : fs.promises.open(full(parts), O_RDONLY | O_NOFOLLOW_ANY | (folder ? O_DIRECTORY : O_NONBLOCK))
    ).catch(err => Promise.reject(mapError(err)))
    try {
      return { handle, real: windows ? await proveWindows(parts, handle) : await spellMac(parts) }
    } catch (err) {
      await handle.close().catch(() => {})
      throw mapError(err)
    }
  }

  const makeDir = (parts: readonly string[], id: string): Dir => ({
    parts,
    names: async () => {
      await hook('readdir')
      const names = await fs.promises.readdir(full(parts)).catch(err => Promise.reject(mapError(err)))
      // The names are candidates, and the folder must be the one that was proven.
      await hook('lstat')
      const ls = await fs.promises.lstat(full(parts), { bigint: true }).catch(err => Promise.reject(mapError(err)))
      if (ls.isSymbolicLink() || idOf(ls) !== id) throw linkError()
      return names
    },
    lstat: async (name, spell = false) => {
      await hook('lstat')
      const st = await lstatOrNothing(full([...parts, name]))
      if (st === undefined) return undefined
      const kind = kindOf(st)
      const real =
        spell && kind !== 'link' ? (insideParts(await realpathNative(full([...parts, name]))).at(-1) ?? name) : name
      return { kind, size: st.size, real }
    },
    openFile: name => file([...parts, name]),
    openDir: name => dir([...parts, name]),
    close: async () => {},
  })

  const dir = async (parts: readonly string[]): Promise<Dir> => {
    const { handle, real } = await opened(parts, true)
    try {
      const st = await handle.stat({ bigint: true })
      if (!st.isDirectory()) throw new WorkspaceError('not-folder', 'the path is not a folder')
      return makeDir(real, idOf(st))
    } finally {
      await handle.close().catch(() => {})
    }
  }

  const file = async (parts: readonly string[]): Promise<Opened> => {
    const { handle, real } = await opened(parts, false)
    return checkedFile(handle, real)
  }

  const check = async () => {
    await hook('lstat')
    const st = await fs.promises.stat(root, { bigint: true }).catch(() => undefined)
    if (st === undefined || idOf(st) !== rootId)
      throw new WorkspaceError(
        'root-changed',
        'the workspace root is not the folder that toolscript-mcp opened at its start',
      )
  }

  return {
    method: windows ? 'realpath' : 'nofollow-any',
    root: async () => {
      await check()
      return makeDir([], rootId)
    },
    dir: async parts => {
      await check()
      return dir(parts)
    },
    file: async parts => {
      await check()
      return file(parts)
    },
    close: async () => {},
  }
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Opens the confined file system for `root`, a real path: the folder is held open from now on. Fails with an
 * `unavailable` WorkspaceError when the method test of this OS fails.
 */
export const openConfined = async (
  root: string,
  { platform = process.platform, hook = () => {} }: ConfinedOptions = {},
): Promise<Confined> => {
  await ensureMethod(platform)
  const rootStat = await fs.promises.stat(root, { bigint: true }).catch(err => Promise.reject(mapError(err)))
  if (!rootStat.isDirectory()) throw new WorkspaceError('not-folder', 'the workspace root is not a folder')
  if (rootStat.ino === 0n) throw unavailable('the volume gives no file identity')
  const rootId = idOf(rootStat)
  if (platform !== 'linux') return pathConfined(root, rootId, platform, hook)

  const held = await fs.promises.open(root, O_RDONLY | O_DIRECTORY)
  const dir = async (parts: readonly string[]): Promise<Dir> => {
    const now = await fs.promises.stat(root, { bigint: true }).catch(() => undefined)
    if (now === undefined || idOf(now) !== rootId)
      throw new WorkspaceError(
        'root-changed',
        'the workspace root is not the folder that toolscript-mcp opened at its start',
      )
    let current = procDir(held, [], false, hook)
    for (const name of parts) {
      const next = await current.openDir(name).catch(async err => {
        await current.close()
        throw err
      })
      await current.close()
      current = next
    }
    return current
  }
  return {
    method: 'proc',
    root: () => dir([]),
    dir,
    file: async parts => {
      const last = parts.at(-1)
      if (last === undefined) throw new WorkspaceError('not-file', 'the path is the root, which is a folder')
      const parent = await dir(parts.slice(0, -1))
      try {
        return await parent.openFile(last)
      } finally {
        await parent.close()
      }
    },
    close: () => held.close().catch(() => {}),
  }
}
