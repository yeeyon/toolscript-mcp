// The confined file system of the Workspace (issue #144, docs/adr/0144-workspace-provider.md, section Confinement).
// Rule: no result holds a byte or a name that did not come through a proven handle: an open file or folder that is
// shown to be inside the root, with no link on the way. This module never follows a symlink or a junction, and it
// refuses a file with more than one hard link. Each OS has its own proof:
//   Linux    open one part at a time with O_NOFOLLOW, relative to the held folder (/proc/self/fd/<fd>/<part>), so a
//            later swap of a name changes nothing that is held.
//   macOS    open the full path with O_NOFOLLOW_ANY: the kernel refuses a symlink in any part.
//   Windows  open the full path, then two times realpath.native and lstat must give the identity of the handle.
//            A process that swaps a folder at each lookup can still win (the ADR names this case). The names and the
//            entries of a folder are read by path, each read between two proofs of the folder (see `makeDir`).
// The first use tests the method. When the test fails, Workspace is unavailable, with the reason.
// `Hook` runs before each lookup of a name, so a test can swap a folder between two lookups.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { WorkspaceError, fold, isInside, realParts, showPath } from '../../core/workspace.ts'

const realpathNative = promisify(fs.realpath.native)

const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
/** `O_NOFOLLOW_ANY` of macOS (sys/fcntl.h): fails when any part of the path is a symlink. Node has no name for it. */
const O_NOFOLLOW_ANY = 0x20000000

export type Kind = 'file' | 'folder' | 'link' | 'other'

/** What a name in a folder is, without following it. `real`: the name as the volume spells it. */
export type Entry = { readonly kind: Kind; readonly size: number; readonly real: string }

/** Runs before each lookup of a name. A test swaps a folder in it. */
export type Hook = (lookup: 'open' | 'realpath' | 'lstat' | 'readdir') => void | Promise<void>

/**
 * A proven open file. The caller reads through `handle` and closes it. `parts`: its path as the volume spells it.
 * `mode`: the permission bits.
 */
export type Opened = {
  readonly handle: FileHandle
  readonly size: number
  readonly parts: readonly string[]
  readonly mode: number
}

/**
 * A proven existing file that a change reads and then replaces. Linux replaces it with a temp file and a rename in the
 * held folder, so a failed write leaves the old file. Windows and macOS write in place, through the proven handle, so a
 * write that fails part way can leave the file damaged. The caller closes it.
 */
export type Updatable = {
  readonly parts: readonly string[]
  readonly size: number
  /** At most `max` bytes, or undefined when the file holds more. */
  read(max: number): Promise<Buffer | undefined>
  replace(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
}

export type NameRead = {
  readonly keep: (name: string) => boolean
  readonly room: number
  readonly alive: () => boolean
}

/** One stream over the folder at `at`, closed on every path. Errors are mapped, so no path is in their text. */
const readNames = async (at: string, { keep, room, alive }: NameRead): Promise<{ names: string[]; more: boolean }> => {
  const stream = await fs.promises.opendir(at, { bufferSize: 512 }).catch(err => Promise.reject(mapError(err)))
  const names: string[] = []
  let more = false
  let read = 0
  try {
    for await (const { name } of stream) {
      if (++read % 1024 === 0 && !alive()) {
        more = true
        break
      }
      if (!keep(name)) continue
      if (names.length >= room) {
        more = true
        break
      }
      names.push(name)
    }
  } catch (err) {
    throw mapError(err)
  } finally {
    await stream.close().catch(() => {})
  }
  return { names, more }
}

/** A proven folder. `parts`: its path from the root as the volume spells it. */
export type Dir = {
  readonly parts: readonly string[]
  /**
   * The names in the folder, read as a stream: `keep` drops a name (it is not counted), the read stops when `room` kept
   * names are held and one more kept name was read (`more`), and `alive` runs at least once for each 1,024 names read
   * (it throws to cancel, and false ends the read with `more`). They are candidates: open or look at each one before it
   * is returned.
   */
  names(read: NameRead): Promise<{ names: string[]; more: boolean }>
  /** What `name` is, or undefined when it is gone. `spell`: also the name as the volume spells it. */
  lstat(name: string, spell?: boolean): Promise<Entry | undefined>
  /** `spell` on the three opens: `name` comes from the text of a path, so on Linux the real name is looked up (`spellOf`). */
  openFile(name: string, spell?: boolean): Promise<Opened>
  openDir(name: string, spell?: boolean): Promise<Dir>
  /** The file `name` for a change. */
  openUpdate(name: string, spell?: boolean): Promise<Updatable>
  /** Makes the file `name` with `bytes`, or fails with `exists`. A write that fails removes the new file. */
  create(name: string, bytes: Uint8Array): Promise<void>
  /** The proven folder `name`, made when it is missing. */
  mkdir(name: string): Promise<Dir>
  close(): Promise<void>
}

export type Method = 'proc' | 'nofollow-any' | 'realpath'

export type Confined = {
  readonly method: Method
  /** The root folder, after a check that the root is still the folder that was opened. Never close it. */
  root(): Promise<Dir>
  dir(parts: readonly string[]): Promise<Dir>
  file(parts: readonly string[]): Promise<Opened>
  /** The existing file at `parts` for a change. */
  update(parts: readonly string[]): Promise<Updatable>
  /**
   * Makes the file at `parts` with `bytes`, and the missing folders above it. `guard` runs on the real parts of each
   * folder and of the file before anything is made below it, and throws to stop. Returns the parts of the file.
   */
  create(parts: readonly string[], bytes: Uint8Array, guard: (parts: readonly string[]) => void): Promise<string[]>
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
  if (code === 'EEXIST')
    return new WorkspaceError(
      'exists',
      'something is already at this path. To replace a file, read it and pass its hash as expectedHash',
    )
  return new WorkspaceError('io', `the file system refused the call (${typeof code === 'string' ? code : 'error'})`)
}

const linkError = (): WorkspaceError =>
  new WorkspaceError('link', 'the path goes through a link: Workspace never follows a symlink or a junction')

const kindOf = (st: fs.Stats | fs.BigIntStats): Kind =>
  st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'folder' : 'other'

export type FileId = { readonly dev: bigint; readonly ino: bigint }

const idOf = (st: fs.BigIntStats): FileId => ({ dev: st.dev, ino: st.ino })

/**
 * True when the stat of an open handle and the stat of its path name one file. On Windows the handle must be on the
 * volume of the root (`rootDev`, from a handle of the root), and the path stat may give `dev` 0 (Node 22.13): the file
 * id alone is then compared, which is sound on one volume. On the other systems `dev` and `ino` must both match.
 */
export const sameFile = (handle: FileId, atPath: FileId, rootDev: bigint, platform: string): boolean =>
  handle.ino === atPath.ino &&
  (platform === 'win32'
    ? handle.dev === rootDev && (atPath.dev === 0n || atPath.dev === handle.dev)
    : handle.dev === atPath.dev)

/**
 * True when two stats name one file. Node 22.13 on Windows gives `dev` 0 for `lstat` and `stat` of a path, and the volume
 * serial for `fstat`, so on Windows a `dev` of 0 matches any: the file id alone is then compared. A real `dev` that differs never matches.
 */
const sameId = (a: FileId, b: FileId): boolean =>
  a.ino === b.ino && (a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n)))

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
    return { handle, size: Number(st.size), parts, mode: Number(st.mode & 0o7777n) }
  } catch (err) {
    await handle.close().catch(() => {})
    throw mapError(err)
  }
}

/**
 * The bytes of an open file, or undefined when it holds more than `max`. It reads at most `max + 1` bytes through the
 * handle, so a file that grew after its size was read, or one that never ends, costs a bounded read.
 */
export const readCapped = async (handle: Pick<FileHandle, 'read'>, max: number): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= max) {
    const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, max + 1 - total))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    chunks.push(buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  return total > max ? undefined : Buffer.concat(chunks, total)
}

/** Writes all of `bytes` from the start of the file. `handle.write` can write less than it is given. */
const writeAll = async (handle: FileHandle, bytes: Uint8Array): Promise<void> => {
  for (let at = 0; at < bytes.length; ) {
    const { bytesWritten } = await handle.write(bytes, at, bytes.length - at, at)
    at += bytesWritten
  }
}

const REFUSED_WRITE = (code: unknown): string =>
  `the file system refused the write (${typeof code === 'string' ? code : 'error'})`

/** A replace that failed in the atomic way: the temp file is gone and the old file is as it was. */
const unchanged = (err: unknown): WorkspaceError =>
  err instanceof WorkspaceError
    ? err
    : new WorkspaceError('io', `${REFUSED_WRITE((err as NodeJS.ErrnoException)?.code)}. The file is unchanged`)

/** A write in place that failed: the file can hold part of the new bytes. */
const damaged = (parts: readonly string[], err: unknown): WorkspaceError =>
  new WorkspaceError(
    'io',
    `${REFUSED_WRITE((err as NodeJS.ErrnoException)?.code)} while it wrote ${showPath(parts)} in place, so that file can be damaged. Read it again before any other change`,
  )

/** A new file whose write failed. It is removed, so nothing is left. */
const notMade = (err: unknown): WorkspaceError =>
  new WorkspaceError('io', `${REFUSED_WRITE((err as NodeJS.ErrnoException)?.code)}. No file was made`)

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

/**
 * The `statfs` types of the file systems known NOT to open a file under a name that `readdir` does not list. A folder
 * on one of them pays nothing for an ASCII name. A name with a character outside ASCII pays the read on every type: a
 * casefolded folder (ext4 `chattr +F`, f2fs, tmpfs) opens `.ſſh` as `.ssh`, and `fold` keeps `ſ` (`readsNames`). Every other type (vfat, NTFS, SMB1, SMB2/3, NFS, 9p, FUSE, VirtualBox shares, and a type
 * that nobody listed) and a `statfs` that fails pay the one read of the names, because a missed alias leaks an excluded file.
 */
const PLAIN = new Set([
  0xef53, // ext2, ext3, ext4
  0x58465342, // xfs
  0x9123683e, // btrfs
  0x01021994, // tmpfs
  0x794c7630, // overlayfs
  0x858458f6, // ramfs
  0x2fc12fc1, // zfs
  0xf2f52010, // f2fs
])

/** True when a folder on the file system of this `statfs` type can open a name that it does not list. */
export const canHoldAliases = (type: number | bigint): boolean => !PLAIN.has(Number(type) >>> 0)

/** True when the part `name` of a path text needs the read of the names: its file system can alias, or it is not ASCII. */
export const readsNames = (aliasing: boolean, name: string): boolean => aliasing || /[^\x00-\x7f]/.test(name)

/** At most this many `lstat` calls to find the real name of a part. */
const ALIAS_LOOKS = 20_000

const lstatBig = async (file: string): Promise<fs.BigIntStats | undefined> => {
  try {
    return await fs.promises.lstat(file, { bigint: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw mapError(err)
  }
}

const procDir = (handle: FileHandle, parts: readonly string[], owned: boolean, hook: Hook): Dir => {
  const at = (name: string) => `/proc/self/fd/${handle.fd}/${name}`
  let aliasing: Promise<boolean> | undefined
  const canAlias = () =>
    (aliasing ??= fs.promises.statfs(`/proc/self/fd/${handle.fd}`).then(
      s => canHoldAliases(s.type),
      () => true,
    ))
  /**
   * The name that this folder lists for what `name` opened (`id`). A volume can open a file under a name that it does not
   * list (a short name, another case): the exclusion checks need the listed one. A listed `name` stands. Else the
   * listed name with the identity `id` is it, the names that fold to `name` first. No match fails with `not-found`.
   * Reading the names is no lookup of a name, so it calls no hook. A folder on another file system keeps `name`.
   */
  const spellOf = async (name: string, id: FileId): Promise<string> => {
    if (!readsNames(await canAlias(), name)) return name
    const stream = await fs.promises
      .opendir(`/proc/self/fd/${handle.fd}`, { bufferSize: 512 })
      .catch(err => Promise.reject(mapError(err)))
    const near: string[] = []
    const rest: string[] = []
    const folded = fold(name)
    try {
      for await (const { name: listed } of stream) {
        if (listed === name) return name
        if (near.length + rest.length < ALIAS_LOOKS) (fold(listed) === folded ? near : rest).push(listed)
      }
    } catch (err) {
      throw mapError(err)
    } finally {
      await stream.close().catch(() => {})
    }
    for (const listed of [...near, ...rest]) {
      const st = await lstatBig(at(listed)).catch(() => undefined)
      if (st !== undefined && st.ino === id.ino && st.dev === id.dev) return listed
    }
    throw new WorkspaceError('not-found', 'there is nothing at this path')
  }
  /** `spellOf` for an open handle. A failure closes the handle. */
  const spelled = async (opened: FileHandle, name: string): Promise<string> => {
    try {
      return await spellOf(name, idOf(await opened.stat({ bigint: true })))
    } catch (err) {
      await opened.close().catch(() => {})
      throw mapError(err)
    }
  }
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
    names: async read => {
      await hook('readdir')
      return readNames(`/proc/self/fd/${handle.fd}`, read)
    },
    lstat: async (name, spell = false) => {
      await hook('lstat')
      const st = await lstatBig(at(name))
      if (st === undefined) return undefined
      let real = name
      if (spell) {
        const listed = await spellOf(name, idOf(st)).catch(err => {
          if (err instanceof WorkspaceError && err.code === 'not-found') return undefined
          throw err
        })
        if (listed === undefined) return undefined
        real = listed
      }
      return { kind: kindOf(st), size: Number(st.size), real }
    },
    openFile: async (name, spell = false) => {
      await hook('open')
      const opened = await fs.promises.open(at(name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch(async err => {
        throw await refused(err, name)
      })
      return checkedFile(opened, [...parts, spell ? await spelled(opened, name) : name])
    },
    openDir: async (name, spell = false) => {
      await hook('open')
      const opened = await fs.promises.open(at(name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch(async err => {
        throw await refused(err, name)
      })
      return procDir(opened, [...parts, spell ? await spelled(opened, name) : name], true, hook)
    },
    openUpdate: async (name, spell = false) => {
      const opened = await dir.openFile(name, spell)
      // Windows and macOS open the file for writing, and the system refuses a read-only file or a read-only volume. A
      // temp file and a rename ignore the mode of the old file, so Linux asks the system on the proven handle (the magic
      // link of the open file, which is the file itself) and refuses in the same way, with the same code of error.
      await fs.promises.access(`/proc/self/fd/${opened.handle.fd}`, fs.constants.W_OK).catch(async err => {
        await opened.handle.close().catch(() => {})
        throw mapError(err)
      })
      return {
        parts: opened.parts,
        size: opened.size,
        read: max => readCapped(opened.handle, max),
        // A temp file in the held folder, with the mode of the old file, then a rename of one name over the other. Both
        // names are relative to the held folder, so a swap of a folder above it changes nothing here.
        replace: async bytes => {
          const temp = `.toolscript-ws-${randomBytes(8).toString('hex')}.tmp`
          let made = false
          try {
            await hook('open')
            const h = await fs.promises.open(at(temp), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            made = true
            try {
              await h.chmod(opened.mode)
              await writeAll(h, bytes)
              await h.sync()
            } finally {
              await h.close()
            }
            await hook('open')
            await fs.promises.rename(at(temp), at(opened.parts.at(-1) ?? name))
            made = false
          } catch (err) {
            throw unchanged(err)
          } finally {
            if (made) await fs.promises.unlink(at(temp)).catch(() => {})
          }
        },
        close: () => opened.handle.close().catch(() => {}),
      }
    },
    create: async (name, bytes) => {
      await hook('open')
      const h = await fs.promises.open(at(name), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o666).catch(async err => {
        throw (err as NodeJS.ErrnoException).code === 'EEXIST' ? mapError(err) : await refused(err, name)
      })
      try {
        await writeAll(h, bytes)
        await h.sync()
      } catch (err) {
        await h.close().catch(() => {})
        await fs.promises.unlink(at(name)).catch(() => {})
        throw notMade(err)
      }
      await h.close()
    },
    mkdir: async name => {
      await hook('open')
      await fs.promises.mkdir(at(name)).catch(err => {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw mapError(err)
      })
      // The name can be a link by now (made by another process): the open proves it.
      return dir.openDir(name, true)
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
  return realParts(real, platform).slice(realParts(root, platform).length)
}

const sameParts = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((part, i) => fold(part) === fold(b[i]!))

const pathConfined = (root: string, rootId: FileId, platform: string, hook: Hook): Confined => {
  // On Windows `rootId` comes from a handle of the root, so its `dev` is the volume serial on every Node.
  const rootDev = rootId.dev
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
    // A file id names one file on one volume only: a handle on another volume than the root is refused, before the rounds.
    if (id.dev !== rootDev)
      throw new WorkspaceError(
        'link',
        'the path is on another volume than the root: Workspace does not cross to another volume',
      )
    let real: string | undefined
    for (let round = 0; round < 2; round++) {
      await hook('realpath')
      const now = await realpathNative(full(parts))
      if (real === undefined) real = now
      else if (now !== real) throw linkError()
      await hook('lstat')
      const ls = await fs.promises.lstat(now, { bigint: true })
      if (ls.isSymbolicLink() || !sameFile(id, idOf(ls), rootDev, platform)) throw linkError()
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

  // `how`: for reading, for a change in place, or to make a new file (which fails with `exists` when a name is there).
  const OPEN = {
    read: { windows: 'r', mac: O_RDONLY },
    update: { windows: 'r+', mac: O_RDWR },
    create: { windows: 'wx', mac: O_WRONLY | O_CREAT | O_EXCL },
  } as const
  const opened = async (
    parts: readonly string[],
    folder: boolean,
    how: keyof typeof OPEN = 'read',
  ): Promise<{ handle: FileHandle; real: string[] }> => {
    await hook('open')
    const handle = await (
      windows
        ? fs.promises.open(full(parts), OPEN[how].windows)
        : fs.promises.open(full(parts), OPEN[how].mac | O_NOFOLLOW_ANY | (folder ? O_DIRECTORY : O_NONBLOCK), 0o666)
    ).catch(async err => {
      // macOS: `O_DIRECTORY` on a file gives ENOTDIR, as a file in a middle part does. Only a last part that exists and is
      // no folder is `not-folder`. A middle part that is a file, or a link, is the same as on the other systems.
      if (!windows && folder && (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
        const st = await lstatOrNothing(full(parts)).catch(() => undefined)
        if (st?.isSymbolicLink()) throw linkError()
        if (st !== undefined && !st.isDirectory()) throw new WorkspaceError('not-folder', 'the path is not a folder')
      }
      throw mapError(err)
    })
    try {
      return { handle, real: windows ? await proveWindows(parts, handle) : await spellMac(parts) }
    } catch (err) {
      await handle.close().catch(() => {})
      throw mapError(err)
    }
  }

  /** Kind and size of the entry at `file` through a handle: undefined when nothing is there, null when `lstat` must answer. */
  const statByHandle = async (file: string): Promise<{ kind: Kind; size: number } | undefined | null> => {
    await hook('open')
    let handle: FileHandle
    try {
      handle = await fs.promises.open(file, O_RDONLY | O_NOFOLLOW_ANY | O_NONBLOCK)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      if (code === 'ELOOP') return { kind: 'link', size: 0 }
      return null
    }
    try {
      const st = await handle.stat()
      return { kind: kindOf(st), size: st.size }
    } catch {
      return null
    } finally {
      await handle.close().catch(() => {})
    }
  }

  // A folder is proven once, at its open. Its names and the metadata of its entries are then read by path, and Node has
  // no lookup relative to a handle on these systems. So each such read is bracketed: the folder must show as the
  // proven one (no link, same identity) right before the read and right after it, and a call that fails either proof
  // drops what it read. A swap of the folder around one read needs the folder to be inside at each proof and outside
  // at the read, in turn: the alternating case of the ADR (section What stays possible). A swap that holds for two
  // reads in a row, or for a proof, is refused.
  const makeDir = (parts: readonly string[], id: FileId): Dir => {
    const proven = async () => {
      await hook('lstat')
      const ls = await fs.promises.lstat(full(parts), { bigint: true }).catch(err => Promise.reject(mapError(err)))
      if (ls.isSymbolicLink() || !sameId(idOf(ls), id)) throw linkError()
    }
    return {
      parts,
      names: async read => {
        await proven()
        await hook('readdir')
        const seen = await readNames(full(parts), read)
        await proven()
        return seen
      },
      lstat: async (name, spell = false) => {
        await proven()
        // macOS `stat` (`spell`): the kind and the size come from a handle that the kernel opened with no link in any
        // part, so a swap of the folder cannot show them from outside. `null`: the open gave no answer, so `lstat` does.
        const held = spell && platform === 'darwin' ? await statByHandle(full([...parts, name])) : null
        let st: { kind: Kind; size: number } | undefined
        if (held !== null) st = held
        else {
          await hook('lstat')
          const ls = await lstatOrNothing(full([...parts, name]))
          st = ls === undefined ? undefined : { kind: kindOf(ls), size: ls.size }
        }
        let seen: Entry | undefined
        if (st !== undefined) {
          const kind = st.kind
          let real = name
          if (spell && kind !== 'link') {
            await hook('realpath')
            const spelled = await realpathNative(full([...parts, name])).catch(err => Promise.reject(mapError(err)))
            real = insideParts(spelled).at(-1) ?? name
          }
          seen = { kind, size: st.size, real }
        }
        await proven()
        return seen
      },
      openFile: name => file([...parts, name]),
      openDir: name => dir([...parts, name]),
      openUpdate: name => update([...parts, name]),
      create: async (name, bytes) => {
        await proven()
        await createFile([...parts, name], bytes)
      },
      mkdir: async name => {
        await proven()
        await hook('open')
        await fs.promises.mkdir(full([...parts, name])).catch(err => {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw mapError(err)
        })
        // The name can be a link by now: the proof of the folder refuses it.
        return dir([...parts, name])
      },
      close: async () => {},
    }
  }

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

  // In place, through the proven handle: the new bytes, then the cut to their length, so the file is never empty.
  const update = async (parts: readonly string[]): Promise<Updatable> => {
    const { handle, real } = await opened(parts, false, 'update')
    const proven = await checkedFile(handle, real)
    return {
      parts: proven.parts,
      size: proven.size,
      read: max => readCapped(handle, max),
      replace: async bytes => {
        try {
          await writeAll(handle, bytes)
          await handle.truncate(bytes.length)
          await handle.sync()
        } catch (err) {
          throw damaged(proven.parts, err)
        }
      },
      close: () => handle.close().catch(() => {}),
    }
  }

  // The folder above is proven. The file is made with O_EXCL (a link at the name is `exists`) and then proven as an open
  // file is. On Windows a swap between the make and the proof leaves an empty file outside (the ADR names it).
  const createFile = async (parts: readonly string[], bytes: Uint8Array): Promise<string[]> => {
    const { handle, real } = await opened(parts, false, 'create')
    try {
      await writeAll(handle, bytes)
      await handle.sync()
    } catch (err) {
      await handle.close().catch(() => {})
      await fs.promises.unlink(full(real)).catch(() => {})
      throw notMade(err)
    }
    await handle.close()
    return real
  }

  const check = async () => {
    await hook('lstat')
    const st = await fs.promises.stat(root, { bigint: true }).catch(() => undefined)
    if (st === undefined || !sameId(idOf(st), rootId))
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
    update: async parts => {
      await check()
      return update(parts)
    },
    create: async (parts, bytes, guard) => {
      await check()
      const last = parts.at(-1)
      if (last === undefined) throw new WorkspaceError('not-file', 'the path is the root, which is a folder')
      // Each folder is proven before the next is made below it: the first missing one is made, and the guard has seen
      // the real spelling of every folder above it.
      let parent = makeDir([], rootId)
      guard(parent.parts)
      for (let k = 1; k < parts.length; k++) {
        const next = await dir(parts.slice(0, k)).catch(err => {
          if (!(err instanceof WorkspaceError && err.code === 'not-found')) throw err
          return parent.mkdir(parts[k - 1]!)
        })
        guard(next.parts)
        parent = next
      }
      guard([...parent.parts, last])
      await parent.create(last, bytes)
      return [...parent.parts, last]
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
  if (platform !== 'linux') {
    // Windows takes the identity of the root from a handle, so its `dev` is the volume serial on every Node.
    const rootStat =
      platform === 'win32'
        ? await fs.promises.open(root, 'r').then(
            h => h.stat({ bigint: true }).finally(() => h.close().catch(() => {})),
            err => Promise.reject(mapError(err)),
          )
        : await fs.promises.stat(root, { bigint: true }).catch(err => Promise.reject(mapError(err)))
    if (!rootStat.isDirectory()) throw new WorkspaceError('not-folder', 'the workspace root is not a folder')
    if (rootStat.ino === 0n) throw unavailable('the volume gives no file identity')
    return pathConfined(root, idOf(rootStat), platform, hook)
  }

  // Linux holds the root from now on, so the open comes first and then the proof that the held folder is the folder
  // at the path, with no link: a swap of the path around the open leaves the two different, or a link, and fails.
  await hook('open')
  const held = await fs.promises
    .open(root, O_RDONLY | O_DIRECTORY)
    .catch(err =>
      Promise.reject(
        (err as NodeJS.ErrnoException).code === 'ENOTDIR'
          ? new WorkspaceError('not-folder', 'the workspace root is not a folder')
          : mapError(err),
      ),
    )
  const rootId = await (async () => {
    try {
      const heldStat = await held.stat({ bigint: true })
      if (heldStat.ino === 0n) throw unavailable('the volume gives no file identity')
      await hook('lstat')
      const pathStat = await fs.promises.lstat(root, { bigint: true })
      if (pathStat.isSymbolicLink() || !sameId(idOf(pathStat), idOf(heldStat)))
        throw new WorkspaceError(
          'root-changed',
          'the workspace root is not the folder that toolscript-mcp opened at its start',
        )
      return idOf(heldStat)
    } catch (err) {
      await held.close().catch(() => {})
      throw mapError(err)
    }
  })()
  const dir = async (parts: readonly string[]): Promise<Dir> => {
    const now = await fs.promises.stat(root, { bigint: true }).catch(() => undefined)
    if (now === undefined || !sameId(idOf(now), rootId))
      throw new WorkspaceError(
        'root-changed',
        'the workspace root is not the folder that toolscript-mcp opened at its start',
      )
    let current = procDir(held, [], false, hook)
    for (const name of parts) {
      const next = await current.openDir(name, true).catch(async err => {
        await current.close()
        throw err
      })
      await current.close()
      current = next
    }
    return current
  }
  const split = (parts: readonly string[]): string => {
    const last = parts.at(-1)
    if (last === undefined) throw new WorkspaceError('not-file', 'the path is the root, which is a folder')
    return last
  }
  return {
    method: 'proc',
    root: () => dir([]),
    dir,
    file: async parts => {
      const last = split(parts)
      const parent = await dir(parts.slice(0, -1))
      try {
        return await parent.openFile(last, true)
      } finally {
        await parent.close()
      }
    },
    update: async parts => {
      const last = split(parts)
      const parent = await dir(parts.slice(0, -1))
      try {
        const opened = await parent.openUpdate(last, true)
        // The folder stays open until the change is done: the temp file and the rename use its handle.
        return {
          ...opened,
          close: async () => {
            await opened.close()
            await parent.close()
          },
        }
      } catch (err) {
        await parent.close()
        throw err
      }
    },
    create: async (parts, bytes, guard) => {
      const last = split(parts)
      let parent = await dir([])
      try {
        guard(parent.parts)
        for (const name of parts.slice(0, -1)) {
          const next = await parent.openDir(name, true).catch(err => {
            if (!(err instanceof WorkspaceError && err.code === 'not-found')) throw err
            return parent.mkdir(name)
          })
          await parent.close()
          parent = next
          guard(parent.parts)
        }
        guard([...parent.parts, last])
        await parent.create(last, bytes)
        return [...parent.parts, last]
      } finally {
        await parent.close()
      }
    },
    close: () => held.close().catch(() => {}),
  }
}
