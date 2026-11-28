# Sharing

Back to the [documentation index](../README.md#documentation).

## Shared servers

With sharing on, several sessions use one copy of a stdio server. It is opt-in and off by default. With it off, each session starts its own copy of each server, and nothing else changes.

The switch is `TOOLSCRIPT_SHARE`, else the top-level `"share"`, else off. A stdio server gets one of 3 classes when sharing is on:

- `shared`: all sessions use one copy.
- `folder`: sessions in the same folder use one copy.
- `session`: each session has its own copy.

The first rule that matches decides:

1. The server is a [Claude Code bridge](claude-code-bridge.md#claude-code-as-a-downstream-server): `session`. A bridge is never shared.
2. The entry has `"share"`: `false` is `session`, `"folder"` is `folder`, and `true` is `shared`.
3. The key, the command or an argument holds a state word: `session`.
4. The entry has `cwd`: `shared`.
5. Anything else is `folder`, because toolscript-mcp cannot know whether the server reads a file of its folder.

The state words are playwright, puppeteer, chrome-devtools, browsermcp, browser, selenium, desktop-commander, shell and terminal. A word counts only between characters that are not letters, with an `s` allowed at its end. The list is not complete. A server that it misses is `folder`. If a server matches a word but keeps no state, or reads no file of its folder, set `"share": true` to share it. A `shared` server without `cwd` starts in your home folder.

Policy, approval and the guard still run in each session for every call, for every class.

A broker holds the shared copies. It is one process for each user and each build of toolscript-mcp. The first session that needs it starts it, hidden and detached, and nothing starts at login. It holds one copy of each server for all sessions, and it decides no policy and keeps no tool result.

A session proves a secret key to the broker before it sends anything, and the broker proves the key back. The key is in `~/.toolscript-mcp@GUARD@/broker`, which only your user can read. Each session has its own connection, so a result reaches only the session that asked. The endpoint is a named pipe on Windows and a socket file elsewhere. There is no TCP port.

The broker does not end with the session that started it. On Windows it stayed when that Claude Code session exited and when its `claude` process was ended, and the next session used the same broker. A copy with no session stops after 10 minutes. A broker with no session and no copy ends soon after. A new build of toolscript-mcp starts its own broker, and the old one ends when its last session ends.

If a session cannot start or reach the broker, the server of that session fails with a reason. toolscript-mcp never starts a direct copy in its place. The other servers and the session keep working. Run `toolscript-mcp doctor` and read the `broker` line. To get a copy for each session again, use one of these:

- `"share": false` on the server.
- `"share": false` at the top level of the config.
- `TOOLSCRIPT_SHARE=0` in the environment.

Two sessions share a copy only when the command, the arguments, the whole environment and the folder are the same. A session that has another value of an `env` variable gets its own copy. Before toolscript-mcp compares `PATH`, it replaces each entry by its real path and drops repeats. Two shells whose `PATH` differs only in a per-shell link to one folder share a copy. Two Node versions do not.

The stderr text of a shared server goes to the log of each session that is attached to it. A direct copy does the same for its client. A session that attaches to a running copy gets no earlier text. A session whose attach fails gets the last 8 KB of the copy that failed. The text never goes to the model. The broker drops stderr text above 256 KB in 10 s and counts what it dropped.

A broker holds at most 256 links and 32 copies. A session has one link for each shared server, so with 4 shared servers that is 64 sessions. Above that, the attach fails with a reason that names `"share": false`. A request of more than 10 MB fails by itself, and the session goes on. A link whose session does not read what the broker sends closes at 64 MB unsent. The session, its other links and the other sessions go on.

Sharing does not keep apart the state inside one copy of a server, or its stderr. Set `"share": false` on a server that keeps state. [SECURITY.md](../SECURITY.md) says what the broker protects and what it does not.

A run from source has no broker, so each shared server fails with that reason. Run the built package to share servers. A server that ignores the end of its input can stay after a broker crash or a session crash, unless the [child guard](#child-guard) is on.

## Lazy start

The `claude mcp serve` bridge costs about 315 MB of private memory in each session. toolscript-mcp starts it on the first call that a program makes to it, and stops it after 10 minutes with no call. A session that never calls it holds no bridge process.

- `search_tools` never starts it, also after a crash or a failed start: only a call that names it does. It lists the tools from the last list that the bridge gave, which toolscript-mcp keeps in `~/.toolscript-mcp@GUARD@/learned/tools.json`. The first session after an install starts it one time at the session start, to get that list. A change to the command, arguments, `env` or `cwd` of its entry does the same. A different `PATH` in the shell does not.
- The first call after a start or a stop waits for the start, which takes the time of the start of `claude`. Policy, approval and the argument checks use the live list of the started server, never the kept list.
- A stop ends the state of the bridge: the files that it read, and the shells that it started in the background. Use `"lazy": false` on its entry, or `TOOLSCRIPT_LAZY=0`, to start it with the session as before.
- Any other stdio server is lazy only with `"lazy": true`. Do not set it on a server that keeps state between calls, such as a browser or a shell. With sharing on, a server in a broker has no `"lazy"` key.
- `toolscript-mcp doctor` shows each lazy server in the `lazy` line.

## Child guard

A host that is killed runs no cleanup: no `close`, no end of input. A server that ignores the end of its input then stays, and so does the server behind a wrapper such as `cmd /c` or `sh -c`. The child guard ends them.

- On Linux and macOS the guard is on. One `/bin/sh` process for each session lists the process group of each stdio child. When the host or the broker dies, it ends the groups that are left. It adds about 1 MB. Set `TOOLSCRIPT_CHILD_GUARD=0` to turn it off.
- On Windows the guard is off. Set `TOOLSCRIPT_CHILD_GUARD=1` to turn it on. toolscript-mcp compiles `runtime/child-guard.cs` one time with the `csc.exe` of .NET Framework 4, keeps the program in `~/.toolscript-mcp/guard`, and starts it for each session. The program puts each child in a Job Object, so Windows ends the children when the host ends. It uses about 16 MB of private memory. A system binary is never copied.
- Windows Defender can stop a newly compiled program. The attack surface reduction rule `01443614-CD74-433A-B99E-2ECDC07BFC25` does it in block mode. The guard then stays off, and one line on stderr says why.
- Only pids go to the guard, never a command, an argument or a value of `env`. The broker guards its own children in the same way.
- A guard that cannot start never stops a server. `toolscript-mcp doctor` shows it in the `child-guard` line.
- Two cases stay. A process that leaves its group on Linux or macOS (`setsid`, a daemon) is not ended. A process that breaks away from the job on Windows is not ended. The first moments of a Windows session are not guarded, until the program is ready.
