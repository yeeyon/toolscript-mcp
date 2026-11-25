# Workspace provider for issue #144

Status: accepted. Three pull requests build it: A (read), B (edit), C (tasks). [Issue #144](https://github.com/yeeyon/toolscript-mcp/issues/144)

## Decision

toolscript-mcp gets a built-in Workspace. Its tools are named `mcp__workspace__<tool>` and work on one approved folder.
The host runs a second MCP server in its own process and links to it with the SDK `InMemoryTransport`.
That link is one more server of `connectAll` in `src/host/downstream.ts`. So `search_tools`, the policy, the approval
prompt, cancellation, the call time limit and the run log treat it as any server.
The public server still lists only `search_tools` and `run_code`. The sandbox gets no new capability.

- `parseConfig` reads the `workspace` section, and an unknown key in it is an error. A valid section adds the server entry
  `workspace`, with `kind: "workspace"`.
- The entry is `untrusted`. Each result is file content, a file name or task output, so each run that reads one is wrapped.
- The broker never shares the entry. It is never lazy, and its tool list is never cached on disk.
- With no `workspace` section, the key `workspace` stays free for an entry of `mcpServers`, as today.
- With both, the key `workspace` is an invalid entry whose reason names both. The other servers work.
- The provider is `toolscript-workspace` version `1.0.0`. A change that breaks a schema raises the major version.
  The tool list is the capability list: a tool that the grant does not allow is not listed.

## Options rejected

| Option | Why not |
| --- | --- |
| A bundled stdio server | One more process for each session, and the broker needs a rule to never share a grant. The file system boundary is the same work. |
| Catalog entries with direct dispatch in `run.ts` | A second way to list and call a tool. Marks, errors and cancellation can drift from the SDK path. |
| No Workspace until a native binding exists | Plain Node gives exact confinement on Linux. See [Confinement](#confinement). The owner works on Windows, and the package must install with no compiler. |
| One pass: open, `realpath`, then `lstat` identity | Measured on Windows: a swap at each lookup read a file outside the root, and wrote one. See [What was measured](#what-was-measured). |
| Exclusive folder handles on Windows (share mode 0) | The open fails while an editor watches the folder, and it blocks other programs. |
| A `dryRun` flag on `edit` | The policy matches names. A flag cannot give preview and change separate permissions. |
| Several files in one `edit` call | It adds partial states and no guarantee. A program previews each file, then edits each file. |
| Regular expressions in `search` | A pattern from the model can stall the host. The program filters the lines in the sandbox. |
| `.gitignore` rules, or `git ls-files` | A matcher of our own or a child process. A fixed skip list comes first. It is a follow-up. |
| MCP client roots | They are advisory. This version does not read them. A later version can use them only to narrow. |
| A shell, or `cross-spawn`, for tasks | A shell parses the command line. `cross-spawn` starts `cmd.exe` for a `.cmd` file. |

## Config

Workspace is off without this section. The server reads the section one time, at the start.
The policy reload of each run never reads it, so no reload can widen a root, a write grant or a task.

```json
{
  "workspace": {
    "roots": [
      {
        "path": "C:/Users/me/Projects/app",
        "write": true,
        "tasks": { "test": { "command": "node", "args": ["--test"], "cwd": ".", "timeoutSeconds": 60, "env": { "CI": "1" } } }
      },
      { "path": "C:/Users/me/Projects" }
    ],
    "exclude": ["fixtures/secrets/**", "*.sqlite"], "skip": ["node_modules", "dist"]
  }
}
```

- `roots`: 1 to 16 entries. `path` is absolute and must be a folder at the start. `write` is `false` by default.
- `tasks`: names of 1 to 32 characters from `a-z`, `0-9`, `-` and `_`, at most 32 for an entry. Only `command` is
  required. Pull request A reads `path` and `write` only, so `tasks` is an unknown key there, and `write: true` has no
  tool to enable yet. Pull request C reads `tasks`. See [Tasks](#tasks).
- `exclude`: globs of paths that no tool reads, lists or writes, added to the built-in list. No key removes a built-in
  exclusion. A glob with no `/` matches the name of any part, at any depth. A glob with `/` matches the path from the
  root, and a folder that it names takes each path below it. Up to 64 globs of 200 characters, with at most 6 wildcards.
- `skip`: folder names that `list` and `search` do not enter. It replaces the default list.
- An error in the section, or a clash with an `mcpServers` entry of the key `workspace`, makes only the entry
  `workspace` invalid. The other servers start. Every error names its key and holds no value of the file.

The provider refuses a root in these cases, and the reason says which. A refused entry makes Workspace unavailable for
the whole session: another entry does not rescue it. The reason names the entry by its place and shows no path.

- The real path is a drive or file system root, the home folder, or a folder that holds the home folder.
- A part of the real path matches a built-in exclusion, such as `.git`, `.ssh` or `.toolscript-mcp`.
- On Windows, the real path is a network path.
- The entry is not a folder that exists.

### The root of a session

The server binds the root one time, at the start, from the real path of each entry and of its start folder.

1. If the start folder is inside one or more entries, the deepest entry gives the grants. The session root is the start folder.
2. Else, if the config has exactly one entry, the session root is the path of that entry.
3. Else Workspace is unavailable. The reason says to start the client in one of the entries.

The session root must pass the same refusals as an entry. The compare of paths ignores case on Windows and macOS.
A backslash separates the parts of a real path on Windows only. On Linux and macOS it is a letter of a name, so the start
folder `/home/me/projects\app` is not inside the entry `/home/me/projects/app`.

A start folder alone never grants access. The model never names a root. Two sessions in two worktrees have two roots,
and they share no state. The provider records the identity of the root folder. If another folder replaces the root,
each call fails until a restart.

## Tools

Paths in arguments and results are relative to the session root and use `/`. The path `.` is the root. Results are sorted by path.

```ts
// A. Read class: allowed with no policy rule.
list   { path?: string, depth?: number, include?: string[] }
    -> { entries: { path: string, type: "file" | "folder" | "link" | "other", size?: number }[], truncated: boolean }
search { query: string, path?: string, include?: string[], ignoreCase?: boolean, maxMatches?: number }
    -> { matches: { path: string, line: number, column: number, text: string }[], truncated: boolean, filesScanned: number, skipped: number }
read   { path: string } -> { path: string, content: string, hash: string, encoding: "utf-8" | "utf-8-bom", size: number }
stat   { path: string } -> { path: string, type: "file" | "folder" | "other" | "missing", size?: number }
// B. diff is read class and never writes. edit and write are write class, listed only with "write": true.
diff   { path: string, expectedHash?: string, edits?: Edit[], content?: string } -> Change
edit   { path: string, expectedHash: string, edits: Edit[] }                     -> Change
write  { path: string, content: string, expectedHash?: string }                  -> Change
type Edit   = { old: string, new: string, all?: boolean }
type Change = { path: string, applied: boolean, created: boolean, changed: boolean, oldHash: string | null, newHash: string,
                diff: string, diffTruncated: boolean, added: number, removed: number, warnings: string[] }
// C. Exec class, listed only when the root has a valid task.
run_task { task: string } -> { task: string, exitCode: number | null, signal: string | null, timedOut: boolean, ms: number,
                               stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean }
```

- `depth` is 1 to 8, default 1. `maxMatches` is 1 to 2000, default 200. `edits` holds 1 to 50 items. `query` is literal
  text on one line, of 1 to 1000 characters. `search` takes a folder in `path`, and `stat` of a link fails with `link`
  (the model learns the link from `list`). `stat` of a path below a file gives `missing`.
- `read` returns the text as it is on disk, with its line ends. A byte order mark shows only in `encoding`.
  `hash` is `sha256:` and the hex digest of the bytes of the whole file.
- `read` refuses a file over 4 MiB, a file with a NUL byte and a file that is not UTF-8.
  `search` skips such files and files over 1 MiB, and counts them in `skipped`. It cuts each `text` at 400 characters.
- `search` and `list` stop after they read 20,000 names or run 10 seconds. A name counts when the read of its folder
  returns it, whatever it is: a file, a folder, a link, a name that an `include` drops. An excluded name does not count:
  it costs one stream entry and one glob test, and only the 10 seconds bound it. A folder is read as a stream to its end
  or to the budget, before any folder below it is entered, so one walk holds at most 20,000 names and one read buffer.
  A cut folder gives some of its names, in the order of the volume. `list` also stops at 5,000 entries. Each cut sets
  `truncated`. So a tree with no match for the `include`, or one of folders only, ends too.
- `read` and `search` read through the handle at most one byte more than their limit (4 MiB and 1 MiB), whatever the
  size said when the file was opened. A file that holds more is refused by `read` and skipped by `search`.
- `include` holds up to 16 globs with `*`, `?` and `**`, over paths from the session root, matched in bounded time: a
  glob has at most 200 characters and 6 wildcards. `list` and `search` do not enter a folder of `skip`, unless `path`
  names it or a folder inside it.
- A failed call throws in the program. The message starts with a fixed code and holds no name or byte from outside the
  root. The codes of pull request A: `bad-input`, `bad-path`, `excluded`, `link`, `hard-link`, `not-found`, `not-file`,
  `not-folder`, `too-large`, `binary`, `encoding`, `root-changed`, `unavailable`, `cancelled` and `io`. Pull request B
  adds `stale`, `busy`, `exists`, `no-match`, `many-matches` and `read-only` (a change tool on a root with no `write`
  grant: the handler refuses, though the tool is not listed).

## Paths and exclusions

The provider checks the text of a path before any file system call. It refuses these forms on each OS:

- An empty path, an absolute path, a drive, a network path, a backslash, and a control character.
- A part that is empty, `.` or `..`. No part is ever resolved away.
- More than 64 parts, or more than 1024 characters.
- On Windows also a `:`, a part that ends in a dot or a space, and a device name such as `NUL`.

A path that passes is then opened and proven, as [Confinement](#confinement) describes. The proof gives the real spelling
of the path. Exclusions match that spelling, never the text of the argument. They match with no regard to case, after
Unicode NFC, on each OS. So `.ENV` and a short name do not pass.

On Linux the proof opens the name of the text, and a volume with short names (vfat, exFAT, NTFS, SMB, a 9p share of a
Windows folder) can open `GIT~1` for `.git` while `readdir` lists only `.git`. So for each part that comes from the text
of a path, after its open (or its `lstat` in `stat`), the held parent folder is read once: a listed name that equals the
text byte for byte stands. Else the real name is the listed name whose `lstat` through the held folder has the `dev` and
`ino` of what was opened, the names that fold to the text first, with at most 20,000 `lstat` calls. With no match the call
fails with `not-found`. `parts` hold the real names, so the exclusions see them, and a change takes its lock under the
real name too. This read is no lookup of a name and calls no hook. It runs only in a folder whose file system (`statfs`)
can hold such names, or when `statfs` fails, so a folder on ext4 or tmpfs pays nothing. A name that comes from a listing
(the walk of `list` and `search`) needs no check.

An exclusion holds for every tool, also for `list`, `stat`, `diff` and a new file. The built-in list:

- Version control data: `.git`, `.hg`, `.svn`.
- Secrets: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.npmrc`,
  `.netrc`, `.pypirc`, `*.tfstate`, `*.tfstate.*`, `.ssh`, `.aws`, `.azure`, `.gnupg`, `.kube`, `.docker`.
- Client settings and hooks: `.claude`, `.codex`, `.cursor`, `.vscode`, `.mcp.json`, `.toolscript-mcp`.
- By real path: the toolscript-mcp config file, and the folder `.toolscript-mcp` of the home folder.

The generic guard of `src/core/guard.ts` still runs on each call. It is not the boundary of Workspace.
The default `skip` list is not access control: `node_modules`, `dist`, `build`, `target`, `vendor`, `coverage`, `.venv`,
`venv` and `__pycache__`.

## Confinement

Rule: no result holds a byte or a name that did not come through a proven handle.
A proven handle is an open file or folder that the provider has shown to be inside the root, with no link on the way.
The provider reads and writes only through that handle. It never follows a symlink or a junction.
It refuses a file with more than one hard link. `list` shows a link as `type: "link"` and never enters it.
A listing by name gives candidates only. Each entry is opened and proven before it is returned or entered.

| OS | How a handle is proven | How a file is replaced |
| --- | --- | --- |
| Linux | The provider holds the root folder open. It opens one path part at a time, with `O_NOFOLLOW`, as `/proc/self/fd/<fd>/<part>` of the held parent. | A temp file made with `O_EXCL` in the held folder, then a rename with both names relative to that folder. |
| macOS | It opens the full path with `O_NOFOLLOW_ANY` (`0x20000000`). The kernel refuses a symlink in any part. | In place, through the proven handle. |
| Windows | It opens the full path. Then, two times, `realpath.native` must give the same real path, and `lstat` of that path must give the identity of the handle. The real path must be inside the root. It can differ from the name in case or by a short name. Then `lstat` of each part must show no link. A handle on another volume than the root is refused with `link` before these rounds (see below). | In place, through the proven handle. |

The provider tests its method one time for each process, at the first use, in a temp folder. If the test fails, Workspace
is unavailable and the reason says why. Such cases are Linux with no `/proc`, a macOS kernel that ignores the flag, and a
volume with no file identity. On every OS the root volume must also give a file identity.
A listing (`names`) of a folder is a candidate list, and so is the `lstat` of an entry (its kind and size). On Windows
and macOS these are read by path, because Node has no lookup relative to a handle there. So each such read is bracketed:
the folder must show as the proven one (no link, same identity) right before the read and right after it, and a call
that fails a proof drops what it read. On Linux a folder is held open, so its names and entries are exact.
The root of a Linux session is opened first and then compared with its path (`lstat` of the path, no link, same identity
as the held folder), so a swap of the root around its open fails the start with `root-changed`.

On Windows the volume of the root is its `dev` from `fstat` of a handle of the root, taken at the start. In `proveWindows`,
a handle whose `dev` differs gets `link`, "Workspace does not cross to another volume", before the two rounds (`sameFile`
in `confined.ts` is the compare). Node 22.13 gives `dev` 0 for `lstat` and `stat` of a path, so the compare keeps that case:
a path `dev` of 0 matches when the handle is on the root volume, where a file id names one file. A junction to another
volume with a matching file id no longer passes. Every file on another volume leaves the read and write family, and every
folder on another volume leaves the nested folder family. A folder inside the root that mounts another volume is refused.
`list` and `stat` read by path, so they can still show a name or a size from any volume, and an empty new file or folder can
still be made there.

### What was measured

Windows 11 build 26300, Node 22.23.3, temp folders. Linux: Docker with one CPU, Node 22.23.5, kernel 6.18.

- The one-pass check failed. A junction was swapped in at the open, out at `realpath`, and in at `lstat`.
  The read then returned a file outside the root. A temp file and a rename, checked the same way, replaced a file outside.
- A blind swap loop, at about 1 swap in 0.9 ms, got 0 of 400 reads. That number says nothing about a timed swap.
- On Windows, an open file blocks a rename of each folder above it (`EPERM`). A handle of the folder itself does not.
  So an honest proof never flaps, and a swap is possible only when the handle is outside the root.
- On Windows, a rename onto a file that has an open handle fails (`EPERM`). So Windows writes in place.
- On Linux, a read and a rename through the held folder stayed in the real folder while its name was a symlink to outside.
  A path of two parts through `/proc/self/fd` followed the symlink. So each open takes one part.
- macOS was not measured. The test of pull request A must prove it on macOS CI, or Workspace stays unavailable there.
- On Windows, Node has no path of an open fd. `fs` takes an fd only in `fstat`, `fchmod`, `fchown`, `fsync`, `fdatasync`,
  `ftruncate` and `futimes`: `realpath.native(fd)`, `readlink(fd)`, `readdir(fd)` and `opendir(fd)` throw
  `ERR_INVALID_ARG_TYPE` (Node 22.13.0 and 22.23.3). So no pure-Node proof ties a handle to the root there.
- On Windows, `dev` is 0 from `lstat` and `stat` of a path on Node 22.13.0, and the volume serial from `fstat`. Node 22.23.3
  gives the volume serial from all three. `ino` is equal in all three.
- On Linux (Docker with one CPU, Node 22.23.5), on a bind mount of a Windows folder (9p) and on a vfat loop mount,
  `GIT~1`, `ENV~1`, `SSH~1`, `ALONGF~1.TXT`, `.GIT` and `readme.md` each open through `/proc/self/fd/<fd>/<name>`. None is in
  `readdir` of the held folder. Each has the `dev` and `ino` of exactly one listed name. `readlink` of the opened fd often
  shows the alias text, so it does not give the real name.
- A PowerShell 5.1 helper with one `Add-Type` class took 3.1 s for one cold start and held 62 MB private, and it compiles
  through `%TEMP%`. Not measured: anything on macOS, and a second volume on Windows.

### What stays possible

The Windows test of pull request A runs every pattern of in and out over the 6 lookups of one read (a check of the root, the
open, and two times `realpath` and `lstat`). Exactly one family reads outside: out at the open, then in and out in turn
(masks 42 and 43 on Windows 11, Node 22). A swap fails with `EPERM` while the inside file is open, so each pattern that
needs one cannot happen. The Linux run, in Docker, shows no pattern that reads outside.

`list` and `stat` have a family of their own on Windows and macOS, found by the same test over every pattern. The proof of
the folder (open, then `realpath` and `lstat` two times) shows no pattern that lists outside, because `lstat` of the
folder itself sees the junction. The reads of the enumeration are by path: the `readdir` (one stream, opened one time
between the two proofs and closed before the second), the `lstat` of an entry and, for
the real spelling of `stat`, `realpath`. Each is between two proofs of the folder. The only leak is a read that is
outside while the proof lookups right before and right after it are inside, so the folder alternates at each lookup
(for `list b`: out at the `readdir`, or at the `lstat` of an entry, and in at every other lookup). For a folder that is
the first part of the path, two lookups in a row that are outside, or the last lookup outside, are refused.

A folder that is a middle part of the path (`b` of `list b/c` or `stat b/c/x`) has a second family on Windows. The
`lstat` of `b/c` does not see a junction at `b`, so the proof of `b/c` (open, then `realpath` and `lstat` two times)
falls into the read family: out at the open, then in and out in turn. The folder then holds the outside id, every later
proof passes, and the lookups after the proof may be outside in a row (masks 010101111 and 110101111 of `list b/c`). A
name, and through the `lstat` of an entry a size, from outside is listed. No byte of a file is. The nested sweep
(`listNested` and `statNested` in the test) varies the lookups over one range of the mask space and fails on a leaking
pattern that is in neither family. Before the proofs, a swap out at the `readdir` and at the
`lstat` of an entry, and in at the one proof between them, listed `b/<outside name>` with its size. The test names the
family (`alternating` in `tests/workspace-fs.test.ts`) and fails on any other pattern. macOS has the same family for
`list` and `stat`: its `read` is exact, because each open refuses a link in any part. An exact `list` on macOS needs an
open of each entry with a flag that opens a link itself (`O_SYMLINK` with `O_NOFOLLOW_ANY`), which was not measured: it
is a follow-up.

| Case | Result | Who can do it |
| --- | --- | --- |
| Windows: 4 swaps of a folder for a junction, each between 2 lookups of one proof | A read of a file outside the root, on the volume of the root only. A write into one whose bytes match `expectedHash`, on that volume only. An empty new file or folder outside, on any volume. | A process that writes in the root and runs at that moment. |
| Windows and macOS: a swap of a folder in turn with the proofs of one listing or `stat` | A name, a size or a kind from outside the root, in `list` or `stat`. No byte of a file. | The same. |
| macOS: a swap during the make of a new folder | An empty folder outside the root. | The same. |
| Each OS: a file or folder moved into the root | It is in the root. | The same. |
| Each OS: a task | Any act of the user. A task is not confined. | The project code that the task runs. |
| A tool of another server writes the config | The new grant applies at the next start, as a new policy does. | A program that the policy allows to call that tool. |

A process that swaps or moves a folder gains from Workspace only when it is not code of the user: another account, or a
process with fewer rights, that can write in the root. So give Workspace a root that only your account can write.
On Windows, `doctor` reads the access rules of the root and warns. A static link is refused on each OS, with no race.
A native binding with folder-relative opens (`NtCreateFile` with the handle of the root, as an optional prebuilt N-API
package) can close the Windows case. It is a follow-up: its build, signing and release path do not exist yet. Two options
are rejected. A PowerShell helper for the opens costs 62 MB and 1 to 3 s for each session, compiles through `%TEMP%`
(which a locked down machine blocks) and puts every file call through a second process. A signed `.exe` helper needs a
certificate that does not exist. More `lstat` or `realpath` calls on the folders above a nested folder cost 2 calls for
each level and entry, and only turn the nested family into the alternating one: they close nothing.

## Edits

- `edit` replaces each `old` with `new`. Each `old` must occur exactly one time, unless `all` is `true`.
  Each `old` is matched against the file as it was read, never against the result of an earlier edit, so the order of
  the list changes nothing. Two edits that replace the same text fail with `bad-input`. (Built as "in order" first, an
  edit could match text that another edit had just written, and the diff had no range in the old file to show.)
  A single `old` counts overlapping places, so an `old` that can match two ways is `many-matches`. With `all`, the
  places do not overlap, and more than 10,000 of them is `bad-input`.
- The match is exact. No line end, byte order mark or space is changed for the model.
  If `old` matches only with other line ends, the error says so.
- `write` with no `expectedHash` makes a new file and fails with `exists` if the path exists, also when a link, a folder
  or a file with other names is there. It makes missing folders. The folders above the file are proven one at a time,
  and the exclusions see the real spelling of each before the next is made.
- `write` with `expectedHash` replaces the whole content. A changed file keeps its byte order mark and its mode.
  Content is given as is, with no line end change. A `\0` or a lone surrogate in `content`, `old` or `new` is refused.
- `diff` takes the arguments of `edit` or of `write`, and returns the same `Change` with `applied: false`. It makes
  nothing and takes no lock, and a preview of a new file proves each existing folder on the way.
- A change that changes no byte (the new bytes equal the old) writes nothing and returns `applied: false`,
  `changed: false`, so the modified time stays.
- The unified diff has 3 lines of context and is cut at 64 KiB (characters, at a line end), with `diffTruncated`. It
  comes from the changed ranges: each range grows to whole lines, then the lines that stay the same at the start and end
  of that block drop out. There is no diff search, so `added` and `removed` can count a moved line twice.
  `warnings` names a change that puts LF line ends in a CRLF file, or CRLF in an LF file.

Each change runs these steps, and stops at the first that fails:

1. Check the policy for this call. `checkCall` does it for every call, also for a name built at run time.
2. Check that the root has `write: true`.
3. Take the lock of the file: one lock in the process, then a lock file.
4. Open and prove the file. Read its bytes through the handle.
5. Compare the hash of those bytes with `expectedHash`. A difference fails with `stale` and changes nothing.
6. Write, sync and close. Drop the lock.

The lock file is `~/.toolscript-mcp/locks/<sha256 of the real path>.lock`, made with `wx` (`takeLock` of `src/host/oauthlock.ts`).
A lock is stale when its process is dead or it is older than 30 seconds. A call waits 2 seconds, then fails with `busy`.
So two sessions never lose an update: the second edit sees a new hash and fails with `stale`.
The lock is taken before the file is opened, so its name comes from the text of the path, folded on every system: Linux
opens a name as it is given, and a folder of it can be a volume that ignores case (a bind mount of a Windows folder, exFAT,
CIFS). On a volume that tells two spellings apart, the folded key only makes the two files wait for each other. The
proof then gives the real spelling. If its lock name differs (a short name), the change takes that lock too, in the same wait. A lock folder that cannot be made fails the change with `io`: a change never runs with no lock. The folder
`locks` is guarded like `oauth` (`guardedDirs`, `GUARD_MARKERS`).
Linux replaces the file with a temp file (`.toolscript-ws-<random>.tmp`, mode of the old file) and a rename in the held
folder. Windows and macOS write the new bytes in place, then cut the file to their length, so it is never empty.
A write in place is not atomic. If it fails part way, the error names the file and says that the file can be damaged.
A rename ignores the mode of the old file, so Linux asks the system whether the proven file can be written
(`access` with `W_OK` on the magic link of the open handle) and refuses a read-only file or volume with `io` and the code
of the error, as the open for writing does on Windows and macOS.

## Tasks

- A task is a fixed program, argument list, folder and environment from the config. The model sends only the task name.
- The spawn uses no shell, with `windowsHide`. Standard input is closed.
  `command` is an absolute path, or a name that the server resolves on `PATH` one time, at the start.
- On Windows the file must end in `.exe` or `.com`. A `.cmd`, `.bat` or `.ps1` file makes the task invalid.
  The reason says to run `node` with the script as an argument.
- `cwd` is relative to the `path` of the root entry and must be a proven folder inside it.
- The child gets a short list of variables, such as `PATH`, the home and temp folders and `SystemRoot`, plus `env` of the task.
  No other variable of the server reaches it.
- `timeoutSeconds` is 60 by default, or `sandbox.callTimeoutSeconds` when that is lower.
  A value over `sandbox.callTimeoutSeconds` is a config error.
  The limit that applies is at most one second under `sandbox.callTimeoutSeconds`, so the task timer fires first.
  At the time limit, a cancel or a shutdown, the provider ends the process tree: on Linux and macOS the process group,
  on Windows the tree that `taskkill /T` walks. On Windows a process whose parent already exited can outlive it. A Job
  Object would close the gap but needs a native helper, so the claim is narrower instead.
- One task runs at a time in a session. A second call waits for its turn, and a call that ends while it waits starts
  nothing. Each stream keeps the first 64 KiB and the last 192 KiB, with a note of the cut bytes between them.
  A non-zero exit code is data, not an error. An unknown task fails and lists the task names.
- A task runs project code with the rights of the user. The prompt and the README say so. No text claims containment.

Decisions that the code made while it built pull request C (this section holds them, so the ADR matches the code):

- Two kinds of problem. A task whose text is wrong (a name, an unknown key, a type, a `timeoutSeconds` over the limit, a
  `command` that is neither absolute nor a bare name, a `cwd` that is not a relative path) is a config error, and it makes
  the entry `workspace` invalid. A task that parses but cannot start (a command that `PATH` does not hold, a Windows
  command that is not an `.exe` or `.com` file, a command that is not executable, a `cwd` that is missing, excluded or
  behind a link) is invalid alone. It has a reason in our own text. `doctor` and the server log show it, `run_task` names
  it when it is called, and the other tasks run. With no valid task, `run_task` is not listed.
- The tasks of a session are those of the entry that the root is in. `cwd` is relative to that entry, also when the session
  root is a folder inside it. The server proves `cwd` at the start and again before each run.
- `PATH` is the one of the server. A relative entry in it is dropped. On Windows the extensions of `PATHEXT` are tried in
  order for each folder, so a `.cmd` file that comes first in `PATH` order makes the task invalid and no later `.exe`
  takes its place.
- The list of variables: on Windows `PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, the account and
  home variables, the program folders and the temp folders. Elsewhere `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`,
  `LC_CTYPE`, `TMPDIR` and `TZ`. The system adds a few variables to each process by itself (on Windows `LOGONSERVER`
  and `USERDOMAIN`), and no code of ours can remove them. `${NAME}` in `command`, `args` and `env` takes a variable of the
  server by the choice of the person who wrote the config.
- At a timeout the result has `timedOut: true`, `exitCode: null` and `signal` of the kill. At a cancel the call fails with
  `cancelled`. At a shutdown the provider ends the task first and refuses each later call.
- The tree ends with the process group outside Windows, and with `taskkill /T /F` on Windows, which needs the top process
  to be alive. After the top process exits, the streams get 1 second to close. Then the group ends on Linux and macOS.
  On Windows a process that the task left behind after its top process exited stays, and the README says so.
- The exec class: the prompt has one line that a task runs project code with the rights of the user and that nothing
  contains it, one line with the task names, and one line with the session root.

## Policy defaults

| Tools | With no matching rule | What an allow rule needs |
| --- | --- | --- |
| `list`, `search`, `read`, `stat`, `diff` | allow | Nothing. Any rule that matches decides, as for other tools. |
| `edit`, `write` | ask, one time for each program | A match that starts with `mcp__workspace__`. |
| `run_task` | ask, one time for each program | The match `mcp__workspace__run_task` exactly. |

- The prompt for a change tool names the session root. `needs` in `src/core/policy.ts` gives the start that an allow
  rule must have for a tool (a bridge: `mcp__<key>__`, a change tool: `mcp__workspace__`). `onlyTightens` counts an allow
  rule whose server part has a `*` as skippable while Workspace is on, as it does while a bridge is on.
- These defaults hold only while the built-in Workspace is on. `decide` in `src/core/policy.ts` owns them. One value,
  `Guards`, carries the bridges and the Workspace flag to `decide`, `planRun`, `checkCall`, `askText` and `onlyTightens`,
  so no call site passes one without the other. `config.guards.workspace` is true only for a valid section that does not
  clash with an `mcpServers` key, so a server named `workspace` gets no default allow.
- An allow rule that does not meet the last column is skipped for that tool, as `counts` does for a bridge.
  So `*` and `mcp__*` never allow a change or a task. `onlyTightens` treats such a rule as one that a tool can skip.
- A deny rule and an ask rule count as usual. The `write` grant and the task list of the config hold under any rule.
- A client that cannot ask gets no change and no task without such an allow rule.
- The prompt adds one line for each class: the session root for changes, and the task names for tasks.
  It says that a task runs project code with your rights. The approval covers that scope for one run.
- Steps 1 to 5 of [Edits](#edits) run again for each call, so an approval never covers a stale file or a path outside the root.

## Logging

- The run log keeps what it keeps today for each call: the tool, the decision, the time and the outcome code.
- For each applied change it also keeps the relative path and the counts of added and removed lines.
- The result of a run lists each applied change, also when the program returns nothing, inside the untrusted wrapper.
  It also lists each `edit` or `write` that failed in the Workspace (path as the program wrote it, and the code), so a
  program that stops at a stale file shows which change was not made. The run log record has `changes`, up to 200.
- The server log has one line at the start: the session root, read or write, and the task names.
- No log holds file content, a query, `old` or `new` text, a diff, task output or a value of `env`.
