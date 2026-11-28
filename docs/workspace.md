# Workspace

Back to the [documentation index](../README.md#documentation).

Workspace is a built-in server that reads the files of one project folder and runs its named tasks. With a write grant,
it also changes the files. It runs inside toolscript-mcp, so it needs no Claude Code and no other process. Its tools are
named `mcp__workspace__<tool>`, and a program calls them as it calls any tool. It is off by default.

## Turn it on

In Claude Code, run `/toolscript:workspace` to add a root with no hand edit (see
[With the Claude Code plugin](install.md#with-the-claude-code-plugin)). Otherwise add a `workspace` section to the config. The key
`workspace` is then reserved: `mcpServers` cannot hold a server of
that name.

```json
{
  "mcpServers": {},
  "workspace": {
    "roots": [{ "path": "/home/me/app" }],
    "exclude": ["fixtures/secrets/**", "*.sqlite"]
  }
}
```

- `roots` holds 1 to 16 entries. Each `path` is absolute and must be a folder that exists. `write` is `false` by default. See [Change files](#change-files). `tasks` holds the [named tasks](#named-tasks) of the entry.
- `exclude` holds globs of paths that no tool reads or shows. They add to the built-in list below. A glob is relative to the `path` of the entry, not to the root of the session: `app/fixtures/**` still holds when the session root is `app` under an entry `Projects`. A start folder that an `exclude` glob hides makes Workspace unavailable. A client root that a glob hides is dropped.
- `skip` holds the folder names that `list` and `search` do not enter. It replaces the default list: `node_modules`, `dist`, `build`, `target`, `vendor`, `coverage`, `.venv`, `venv` and `__pycache__`. A call can still name such a folder in `path`.
- `gitignore` is `true` by default. Set it to `false` and `list` and `search` never read the `.gitignore` of the root. See [What the read tools cover](#what-the-read-tools-cover).

The server reads the section one time, at the start. A policy reload never reads it. To change a root, edit the config and
restart toolscript-mcp. An error in the section makes only the `workspace` entry invalid, and the other servers start.

## The root of a session

The model never names a root. The server binds one root at the start, from the real path of each entry and of the
folder where your client started it:

1. If that folder is inside one or more entries, the deepest entry gives the grants, and the folder is the root.
2. Else, if the config has one entry, its path is the root.
3. Else Workspace is unavailable, and `search_tools` says to start the client in one of the entries.

Workspace reads `workspace.roots` only at its start. After a change, reconnect toolscript-mcp or restart the client.
When the config cannot bind, the instructions of the server tell the model that Workspace is not available. Each reason ends with that restart advice.

So two sessions in two folders under one entry see only their own folder. The folder where the client started never grants
access alone. Workspace refuses a root in these cases, and the reason names the entry:

- The root is a drive or the root of a file system.
- The root is your home folder, or a folder that holds it.
- The root is a Windows network path.
- A part of the root path has a name such as `.git` or `.ssh`.

Roots of the client can make the root smaller, and never larger. If your client declares the `roots` capability, the
server asks for its roots one time, after the client starts. The root becomes the deepest folder that holds every client
root inside the bound root. A client root outside the bound root, a link to a folder outside it, a file, or a refused
folder grants nothing. The server waits at most 2 seconds for the answer. Until then no Workspace call runs. After that
time, or after an error, the bound root stays. A change of the roots needs a restart of toolscript-mcp. A task still runs
in its `cwd` under the entry, which can be outside a smaller root. The prompt and the stderr log show the root.

## The tools

| Tool | What it does |
| --- | --- |
| `list` | Lists entries under a folder, sorted by path, with `depth` from 1 to 8. A link shows as `link` and is never entered. |
| `search` | Finds literal text in the text files under a folder. It returns the path, line and column of each match. |
| `read` | Reads one text file with its line ends as they are. It returns the text, its encoding and the `sha256` of its bytes. |
| `stat` | Tells if a path is a file, a folder, something else or missing. |
| `run_task` | Runs one [named task](#named-tasks) from the config. It exists only when the entry of the root has a valid task. It asks first. |
| `diff` | Previews a change and writes nothing. It takes the arguments of `edit` or of `write`, and returns the unified diff. |
| `edit` | Replaces exact text in one file. It is listed only with `"write": true`. |
| `write` | Makes a new file, or replaces a whole file. It is listed only with `"write": true`. |

Paths in arguments and results are relative to the root and use `/`. Each failed call throws in the program. The message
starts with a code, such as `excluded`, `link`, `hard-link`, `bad-path`, `too-large`, `binary` or `not-found`. The change
tools add `stale`, `busy`, `exists`, `no-match`, `many-matches` and `read-only`.

## What the read tools cover

- Each call goes through the policy as any call does. The read tools and `diff` run with no rule while Workspace is on. An `ask` or `deny` rule that matches still decides.
- Each result is untrusted text. The run result is in the untrusted wrapper, and the run learns no result shape.
- The built-in exclusions hold for all tools, with no regard to case, after Unicode NFC. They cover version control data (`.git`, `.hg` and `.svn`) and `.toolscript-mcp`.
- They also cover secrets: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.aws` and `.ssh`. And they cover the settings of clients: `.claude`, `.vscode` and `.mcp.json`.
- The toolscript-mcp config file is excluded too, by its real path.
- No tool follows a symlink or a junction, and `read` refuses a file with more than one hard link. `search` skips such a file.
- `read` refuses a file over 4 MiB, a file with a NUL byte and a file that is not UTF-8. `search` skips these files and files over 1 MiB, and counts them in `skipped`.
- `search` and `list` stop after they read 20,000 names or run 10 seconds, and `list` also stops at 5,000 entries. Each then sets `truncated`. Excluded names do not count toward the 20,000, and only the 10 seconds bound them. A folder with more names than the rest of the budget gives a part of its names, in the order of the volume. A cancel ends a `search` within one second. Only one `list` or `search` walks at a time. A call that waits for the slot answers at once after 48 seconds. That is the call limit (`sandbox.callTimeoutSeconds`) less 12 seconds. With a call limit of 12 seconds or less, a call that must queue answers at once. The answer has `notStarted: true`, `truncated: true` and no matches or entries. The footer of the run counts these calls apart from the cut ones.
- `search` takes literal text on one line, not a regular expression. Filter the lines in your program. `query` can be an array of up to 20 texts: one walk finds all of them, each match names its text in `query`, and `maxMatches` counts for each text. `include` takes up to 16 globs with `*`, `?` and `**`, over paths from the root.
- `list` and `search` leave out the names that the `.gitignore` in the root ignores. Each call reads that file again. The files below the root, `.git/info/exclude` and the global ignore file count for nothing.
- The rules are discovery only. `read`, `stat`, `diff`, `edit`, `write` and `run_task` never use them, so an ignored file reads and changes as before. A `path` that is ignored, or inside an ignored folder, applies no rule.
- The syntax has `#` comments, `*`, `?`, `**` as a whole part, and classes such as `[Bb]in/`. A trailing `/` takes folders only. A `/` at the start or in the middle anchors the pattern to the root.
- A `!` rule un-ignores a name, and the last rule that matches wins. A `!` rule below an ignored folder shows nothing, as in git.
- A line with another `\`, a `**` beside other characters, an unclosed class, over 200 characters or over 6 wildcards is skipped. At most 500 rules count. A file that is missing, excluded, a link, with more than one hard link, not UTF-8 or over 64 KiB gives no rules.
- An exclusion and `skip` decide first: no rule shows an excluded name. An ignored name still counts as one of the 20,000 names. Set `"gitignore": false` to turn the rules off.

## Named tasks

A task is a fixed command that you write in the config, for example your test command. The model sends only the name of
the task. It can never choose the program, the arguments, the folder or the variables. A task is how a program checks
its own change, for example after it edits a file.

```json
{
  "workspace": {
    "roots": [
      {
        "path": "/home/me/app",
        "tasks": {
          "test": { "command": "node", "args": ["--test"], "timeoutSeconds": 60, "env": { "CI": "1" } },
          "lint": { "command": "node", "args": ["scripts/lint.mjs"], "cwd": "packages/app" }
        }
      }
    ]
  }
}
```

- A task name has 1 to 32 characters from `a-z`, `0-9`, `-` and `_`. An entry has at most 32 tasks.
- `command` is needed. It is an absolute path, or a bare name that toolscript-mcp looks up on its `PATH` one time, at the start.
- `args` is a list of strings. `cwd` is a folder relative to the `path` of the entry, `.` by default. It must exist, and it can have no link on the way.
- `timeoutSeconds` is 60 by default. A value over `sandbox.callTimeoutSeconds` is a config error. The limit that applies
  is at most one second under `sandbox.callTimeoutSeconds`, which is 59 seconds with the default call limit. So the
  program usually sees `timedOut` and not a cancel. A process that keeps the output open after the task ends can hold
  the call. The program then sees a cancel at the call limit.
- `env` holds the variables of the task. The child gets only these, and a short list of variables of the server: `PATH`, the home and temp folders, and `SystemRoot` on Windows. No other variable of the server reaches it.
- `${NAME}` in `command`, `args` and `env` takes the value of a variable of the server, as it does in a server entry.

The task list of one session is the list of the entry that the root is in. A session whose entry has no task has no
`run_task` tool and cannot run a task of another entry. A task that cannot run, for example a command that `PATH` does
not hold, is listed by `toolscript-mcp doctor` with the reason. The other tasks still run.

How a task runs:

- There is no shell. The program starts with the arguments as you wrote them, and standard input is closed. `a && echo x` is one argument.
- Each stream keeps the first 64 KiB and the last 192 KiB, and the result sets `stdoutTruncated` or `stderrTruncated`.
- A non-zero exit code is a result, not an error. At the time limit, `timedOut` is `true`.
- One task runs at a time in a session. A second call waits for the first.
- A task ends with its process tree, however it ends: at its own exit, at the time limit, at a cancel, at a shutdown and
  when the server is killed. Whatever the task started in the background ends with it, and there is no switch to keep it.
  A build server that the task starts ends with it, so the next build starts cold. Examples are the MSBuild node reuse,
  the dotnet build server and the Gradle daemon.
- On Windows, one warm Windows PowerShell 5.1 helper makes a Job Object for each task. Every process that the task
  started ends with it, also one whose parent already exited. A process that a service, the Task Scheduler or WMI
  starts is not in the job and stays. The helper starts at the first task, and stops after 10 minutes with no task.
  While it waits it holds about 60 MiB.
- On Linux, a small perl helper (`/usr/bin/perl`) is the child subreaper of the task. It ends every descendant, also after
  `setsid`, `nohup` or a double fork. A process that a daemon outside the tree starts, such as `systemd-run`, stays.
- macOS has no kernel object that holds descendants, so the same helper searches. It ends the process group, each
  process with a live parent chain, and each process whose environment still shows the variable `TOOLSCRIPT_TASK`.
  That variable, a new random value for each task, is the only difference from the environment of a direct start. A
  process that left the group, lost its parent and hides the variable stays. So does a process that `launchd` starts.
- Costs, measured: on Windows the first task after the helper starts waits for it. That is about 0.6 s on a quiet
  laptop and up to 3 s on a busy one. Each later task adds under 20 ms. On Linux each task adds about 7 ms. On macOS the
  helper runs one `ps` at the end of each task.
- The time limit starts when the task starts, not before.
- The helper can be missing or blocked: PowerShell by AppLocker, a policy or Constrained Language Mode, or no
  `/usr/bin/perl`. Then the task runs by the direct start, and nothing ends at a hard kill of the server. On Windows
  the task ends with the `taskkill /T` tree, elsewhere with its process group, so a process that left either can stay.
  toolscript-mcp writes one line to its stderr about it, one time for each process.

### Set a task up safely

- A task runs project code with your rights. Nothing contains it. The prompt says so each time, and this page does not claim more.
- By default each program that calls `run_task` asks you first. Only an `allow` rule with the exact name `mcp__workspace__run_task` skips the prompt. The rules `*`, `mcp__*` and `mcp__workspace__*` do not allow it. A client that cannot ask gets no task without that rule.
- Write only commands that you trust. A test command runs the code of the project, and that code can read, change and send what your account can reach.
- On Windows, a `.cmd`, `.bat` or `.ps1` file cannot be a command: a shell must parse it. Set `command` to `node` and give the script as the first argument.

## Change files

Set `"write": true` on the root entry to list `edit` and `write`. Without it, the tools are not listed, and a call of one
fails with `read-only`. The grant belongs to the entry that holds the root of the session. The server reads it one time,
at the start.

```json
{ "workspace": { "roots": [{ "path": "/home/me/app", "write": true }] } }
```

A change goes in three steps. First, preview it with `diff`. Then call `edit` with the hash that `read` returned. Then
check the result:

```js
const file = await call("mcp__workspace__read", { path: "src/retry.ts" })
const edits = [{ old: "maxAttempts: 3", new: "maxAttempts: 5" }]
const preview = await call("mcp__workspace__diff", { path: file.path, expectedHash: file.hash, edits })
const change = await call("mcp__workspace__edit", { path: file.path, expectedHash: file.hash, edits })
return { diff: change.diff, newHash: change.newHash }
```

**The approval.** `edit` and `write` ask the person, one time for each program. The prompt names the session root. A
client that cannot ask gets no change. The rules `*` and `mcp__*` do not allow these tools. A rule that starts with
`mcp__workspace__` does, for example `mcp__workspace__*` or `mcp__workspace__edit`. A name that a program builds at run
time runs only under such a rule. A `deny` rule wins. The approval covers one run, and each call still checks the hash.

**The hash rule.** `edit` needs `expectedHash`. If the file changed after the `read`, the call fails with `stale` and
changes nothing. `write` with no `expectedHash` makes a new file, or fails with `exists`. `write` with `expectedHash`
replaces the whole file. Two calls with one hash change the file one time. The second fails with `stale`.

**Exact bytes.** Each `old` is matched against the file as `read` returned it, and the order of the edits changes
nothing. An `old` must occur one time, or `all` must be `true`. Two edits cannot replace the same text. No line end, byte
order mark or space is changed for you. If `old` matches only with other line ends, the error says so. A changed file
keeps its byte order mark and its mode. A file over 4 MiB, a binary file and a file that is not UTF-8 are refused.

**The lock.** A change holds a lock in the process and a lock file in the folder `.toolscript-mcp/locks` of your home.
Two sessions never lose an update. A call waits 2 seconds for a lock, then fails with `busy`. A lock of a dead process, or
one older than 30 seconds, is taken over. The lock goes after a failed or cancelled call.

**In-place writes.** Linux writes a temp file in the held folder and renames it, so a failed write leaves the old file.
The new file keeps the mode, but not the access lists, the extended attributes or another owner of the old file.
Windows and macOS write in place through the proven handle. A write that fails part way can leave that file damaged, and
the error names the file. Atomic replace on these systems is a follow-up.

**The audit.** A run result lists each applied change, also when the program returns nothing:
`- changed src/retry.ts (+1 -1)`. The run log keeps the relative path and the counts of added and removed lines. No log
holds file content, `old` or `new` text, or a diff.

**What stays possible.** A change tool can edit any file that the root allows, for example a build script. A later run
of your tests or your editor then runs that code. Keep `write` off for a root that you do not trust. The cases of
[What stays possible](#what-stays-possible) also hold for a write: on Windows a swap can write a file outside the root
whose bytes match the hash.

## How a file is opened

Workspace opens each file through a handle that it proves to be inside the root. It never opens a path by name and then
trusts a check that it made before. The proof differs by system:

| System | Proof |
| --- | --- |
| Linux | Each part of the path is opened with `O_NOFOLLOW`, relative to the folder that is held open. A later swap of a name changes nothing that is held. On a volume with short names (vfat, NTFS, SMB, a share of a Windows folder), a name such as `GIT~1` is found under the name that the folder lists, so an exclusion holds for it. |
| macOS | The full path is opened with `O_NOFOLLOW_ANY`, which refuses a symlink in any part. |
| Windows | The full path is opened. A handle on another volume than the root is refused. Then `realpath` and `lstat` must agree with the identity of the handle, two times. |

At its first use, Workspace tests its method in a temp folder. If the test fails, Workspace is unavailable and the reason
says why. On macOS, the CI run of the repo decides if the method works. A macOS system where it does not work has Workspace unavailable.

On Windows, Workspace does not cross to another volume: a folder inside the root that mounts another volume is refused.

## What stays possible

- On Windows, a process that writes in the root can swap a folder for a junction at each lookup of one proof. Then `read` can return a file outside the root, if that file is on the same volume as the root. `edit` and `write` can write such a file whose bytes match `expectedHash`. A new empty file or folder can be made outside the root, on any volume.
- On Windows, a swap can alternate with each lookup of a `list` or a `stat`. On macOS it can do so for a `list`. It can also do so for a `stat` of an entry that the process cannot open. Then it can show a name, a size or a kind from outside the root. It never shows the bytes of a file.
- On Windows, the same can happen for a folder in the middle of a path, such as `b` in `list b/c`: the swap must be out at the open of `b/c` and then alternate. Later lookups can be outside in a row.
- On macOS, a swap while a new folder is made can make an empty folder outside the root.
- Both cases need a process of another account, or a process with fewer rights. Code that runs as you can read the files itself.
- Give Workspace a root that only your account can write. On Windows, `toolscript-mcp doctor` reads the access rules of the root and warns when another account can write.
- A program that Workspace feeds with file text can send that text to any other tool that the policy allows. Keep the policy narrow for a root with private files.
- A tool of another server can write the config. A new root, grant or task applies at the next start, as a new policy does.
- A task is not confined to the root. It has the rights of your account, so it can read or write any file that you can.

## Check it

Run `toolscript-mcp tools workspace` to list the tools with their policy decision. Run `toolscript-mcp doctor` for one
line on Workspace: off, the root with its grants and task names, or the reason that it is unavailable. A task that cannot run has its own line. `toolscript-mcp runs` shows the
Workspace calls of a run. A program or a client config that names the Claude Code bridge still works as before.

## Tested clients

One program did search, read, diff, edit and `run_task` on a test project, with Workspace as the only server and no
Claude Code bridge. The file bytes, the hash and the task exit code were checked after each run.

| Client | Version | Result |
| --- | --- | --- |
| Codex CLI | 0.172.0 | Passed. `codex exec` declines every prompt, so the config held allow rules for `edit` and `run_task`. |
| Claude Code | 2.1.331 | Passed, with `claude -p --restricted --strict-mcp-config`. |
| Cursor | | Not tested. |
