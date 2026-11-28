# Workspace against the Claude Code bridge (issue #151)

One measurement on one Windows laptop, by `bench/workspace-bridge.mjs`. It asks the same four questions about one
disposable repository through toolscript-mcp hosts that have (a) the built-in Workspace, or (b) the Claude Code bridge
(`claude mcp serve` as the downstream server `claude-code`). It holds two runs of each arm (run 2 first, then run 1), with no repeat inside a run, so a gap of the size of its spread
is not a result. No model runs, and nothing is spent.

## Versions and machine

| | |
|---|---|
| toolscript-mcp | this branch (`dist/host/main.js` after `npm run build`), version 1.0.4. Run 2 has origin/main merged in, with issue #206 (4 files of a walk at once). Run 1 does not |
| Claude Code (the bridge) | 2.1.332 |
| Node | v22.23.3 |
| System | Windows_NT 10.0.26300, 8 CPUs |
| Other load | run 2: a quiet laptop, no other bench or test run, only idle agents. Run 1: the laptop was in use by other work of the same session (no benchmark run at the same time on purpose) |

## Fixture and method

- Fixture: 1,500 files (1 to 6 KB of seeded random words) in 120 folders: `src/` and 99 folders under it with `.ts` files,
  `docs/` and 20 folders under it with `.md` files, and 8 lines that hold `needle-3`. No `.git`, no `.gitignore`. It is
  made in a temp folder for each run, from a fixed seed, and removed at the end.
- A session is one `dist/host/main.js --config <file>` over stdio with its working folder in the fixture, started by the
  script, which is the MCP client. The home of the hosts, and `CLAUDE_CONFIG_DIR` of the bridge, are temp folders. The real
  toolscript config and the real Claude Code settings are never read.
- Each call is one `run_code` with one nested call, as a model sends it. "Result chars" is the length of the text that
  `run_code` returns, the text that goes into the context. Both arms go through the same sandbox, so its cost is in both.
- The four questions, with the tool of each arm:

  | question | Workspace | bridge |
  |---|---|---|
  | list | `list` of `src/d7`, depth 1 | `Glob` `src/d7/*` |
  | find | `list` of `docs`, depth 4, include `**/*.md` | `Glob` `docs/**/*.md` |
  | search | `search` for `needle-3` | `Grep` for `needle-3`, content, line numbers |
  | read | `read` of `src/d7/f7.ts` | `Read` of the same file |

  The answers hold the same files and lines, but each tool has its own result format, so the characters are not a
  comparison of one answer.
- Cold: the first call of a question in a fresh session. For the bridge it includes the start of `claude.exe`, which the
  host starts at the first call (the key `claude-code` makes it lazy). Warm: 5 more calls of each question in each session.
  A session makes 24 calls (4 questions, 1 cold and 5 warm). Sessions of a round start one after the other and call one
  after the other, so the 6 sessions never ask at the same moment.
- The bridge is lazy only when the host has the tool list from an earlier start (`learned/tools.json` of its home). A
  warm-up host fills it before the rounds, as `bench/memory.mjs` does, and the first start is reported apart.
- Memory: private bytes (commit) and the private working set, summed over every process under every host of the round, each
  process once (pid and creation time). Sampled 4 s after the last host is ready ("idle, before the first call") and 4 s
  after the last call ("after the calls"). Windows only. `conhost.exe` is a process that Windows makes for each console
  program and it is counted. The script ends only the hosts that it started, and the processes below them that its table
  shows (by pid and creation time). Leftovers were 0 in every round, and a check of the process table after the run found none.

## Numbers, run 2 (quiet laptop, with issue #206)

Times are in ms. "Max" is the slowest call of that question in that round.

| arm | sessions | question | result chars | cold median | cold max | warm median | warm max |
|---|---|---|---|---|---|---|---|
| Workspace | 1 | list | 1466 | 195 | 195 | 127 | 235 |
| Workspace | 1 | find | 3452 | 220 | 220 | 238 | 276 |
| Workspace | 1 | search | 1739 | 905 | 905 | 989 | 1082 |
| Workspace | 1 | read | 2182 | 142 | 142 | 112 | 141 |
| bridge | 1 | list | 657 | 721 | 721 | 181 | 223 |
| bridge | 1 | find | 2892 | 295 | 295 | 178 | 230 |
| bridge | 1 | search | 1023 | 228 | 228 | 220 | 296 |
| bridge | 1 | read | 2127 | 140 | 140 | 126 | 189 |
| Workspace | 6 | list | 1466 | 205 | 231 | 160 | 241 |
| Workspace | 6 | find | 3452 | 330 | 386 | 290 | 930 |
| Workspace | 6 | search | 1739 | 1689 | 2465 | 1310 | 2075 |
| Workspace | 6 | read | 2182 | 163 | 193 | 167 | 298 |
| bridge | 6 | list | 658 | 1769 | 3058 | 224 | 739 |
| bridge | 6 | find | 2893 | 555 | 789 | 223 | 403 |
| bridge | 6 | search | 1023 | 698 | 1238 | 257 | 488 |
| bridge | 6 | read | 2127 | 449 | 607 | 161 | 358 |

| arm | sessions | host ready ms (median) | calls | failed | processes idle | private MB idle | processes after calls | private MB after | private working set MB after |
|---|---|---|---|---|---|---|---|---|---|
| Workspace | 1 | 260 | 24 | 0 | 2 | 72 | 2 | 126 | 84 |
| bridge | 1 | 245 | 24 | 0 | 2 | 70 | 4 | 357 | 118 |
| Workspace | 6 | 200 | 144 | 0 | 12 | 438 | 12 | 701 | 418 |
| bridge | 6 | 274 | 144 | 0 | 12 | 422 | 24 | 2076 | 712 |

Processes after the calls: Workspace 1 `node.exe` and 1 `conhost.exe` for each session. Bridge, for each session, 1
`node.exe`, 2 `conhost.exe` and 1 `claude.exe`. Leftovers were 0 in every round.

First start of a host with an empty tool list: the host starts the bridge at once. It was ready in 168 ms and held 4
processes, 372 MB of private bytes and 120 MB of private working set.

## Numbers, run 1 (laptop in use, before issue #206)

The first run, kept as it was. The method and the machine are the same, except for the load and the code of Workspace.

Times are in ms. "Max" is the slowest call of that question in that round.

| arm | sessions | question | result chars | cold median | cold max | warm median | warm max |
|---|---|---|---|---|---|---|---|
| Workspace | 1 | list | 1466 | 712 | 712 | 160 | 568 |
| Workspace | 1 | find | 3452 | 1281 | 1281 | 349 | 616 |
| Workspace | 1 | search | 1739 | 5891 | 5891 | 3683 | 4170 |
| Workspace | 1 | read | 2182 | 197 | 197 | 182 | 192 |
| bridge | 1 | list | 657 | 1094 | 1094 | 259 | 296 |
| bridge | 1 | find | 2893 | 348 | 348 | 257 | 411 |
| bridge | 1 | search | 1023 | 382 | 382 | 216 | 396 |
| bridge | 1 | read | 2127 | 297 | 297 | 160 | 220 |
| Workspace | 6 | list | 1466 | 163 | 178 | 130 | 440 |
| Workspace | 6 | find | 3452 | 237 | 273 | 256 | 2333 |
| Workspace | 6 | search | 1739 | 2474 | 3215 | 2631 | 9206 |
| Workspace | 6 | read | 2182 | 126 | 150 | 132 | 361 |
| bridge | 6 | list | 658 | 819 | 860 | 227 | 514 |
| bridge | 6 | find | 2893 | 218 | 237 | 215 | 601 |
| bridge | 6 | search | 1023 | 250 | 267 | 243 | 678 |
| bridge | 6 | read | 2127 | 178 | 195 | 159 | 860 |

| arm | sessions | host ready ms (median) | calls | failed | processes idle | private MB idle | processes after calls | private MB after | private working set MB after |
|---|---|---|---|---|---|---|---|---|---|
| Workspace | 1 | 384 | 24 | 0 | 2 | 70 | 2 | 134 | 84 |
| bridge | 1 | 2588 | 24 | 0 | 2 | 68 | 4 | 358 | 118 |
| Workspace | 6 | 191 | 144 | 0 | 12 | 424 | 12 | 582 | 271 |
| bridge | 6 | 198 | 144 | 0 | 12 | 410 | 24 | 2150 | 719 |

Processes after the calls: Workspace 1 `node.exe` and 1 `conhost.exe` for each session. Bridge, for each session, 1
`node.exe`, 2 `conhost.exe` and 1 `claude.exe`.

First start of a host with an empty tool list: the host starts the bridge at once. It was ready in 300 ms and held 4
processes, 378 MB of private bytes and 119 MB of private working set (one host, 4 s after it was ready).

## What run 2 shows

- Before the first call the two arms cost the same, as in run 1: 2 processes and 70 to 72 MB for one session, 12 processes
  and 422 to 438 MB for six.
- After the 24 calls: 1 session, Workspace 126 MB of private bytes (84 MB private working set) against 357 MB (118 MB)
  for the bridge. 6 sessions, Workspace 701 MB (418 MB) against 2076 MB (712 MB). The bridge adds 2 processes for each
  session and about 290 MB of private bytes for each session. Workspace grew by 54 MB (1 session) and 263 MB (6 sessions).
- `search` is still the large gap, but smaller. Warm median, 1 session: Workspace 989 ms against 220 ms for the bridge
  (run 1: 3683 ms against 216 ms). 6 sessions: 1310 ms against 257 ms, slowest call 2075 ms against 488 ms (run 1: 2631 ms,
  slowest 9206 ms). So Workspace `search` is about 4.5 times the bridge at one session and 5 times at six.
- `list`, `find` and `read` took 110 to 330 ms warm in both arms, and Workspace is within 60 ms of the bridge for each.
- The cold first question of the bridge includes the start of `claude.exe`: 721 ms with one session, 1769 ms (slowest
  3058 ms) with six, against 195 and 205 ms for Workspace.
- 0 of the 336 calls failed.
- Run 2 against run 1: the machine was quiet in run 2 (no other bench or test run, only idle agents) and Workspace has the
  change of issue #206 (4 files of a walk at once). This bench cannot say how much of the `search` gain is the change and
  how much is the quiet laptop: the bridge arm did not move for `search` (216 to 220 ms), which suggests that the load
  was small for a process that does little work, and that most of the Workspace gain is the change. That is an
  inference. The private working set of Workspace at 6 sessions is 418 MB against 271 MB in run 1, which this bench
  does not explain.

## What run 1 showed

- Before the first call the two arms cost the same: 2 processes and 68 to 70 MB for one session, 12 processes and 410 to
  424 MB for six. The bridge is asleep until a call needs it, so a session that never reads a file pays nothing for it.
- After the 24 calls the bridge arm holds 2 more processes for each session and 290 MB more private bytes for each
  session than before (1 session: 68 to 358 MB, 6 sessions: 410 to 2150 MB, that is 1740 MB for 6). The Workspace arm grew
  by 64 MB (1 session) and 158 MB (6 sessions). At 6 sessions the sum is 582 MB against 2150 MB of private bytes, and 271
  MB against 719 MB of private working set. The two figures differ for the bridge (358 MB of private bytes, 118 MB of private
  working set for one session): the first is commit, the second the part that is in memory.
- Time: `list`, `find` and `read` took 100 to 400 ms warm in both arms. `search` is the large gap on this fixture and this
  system: Workspace 3.7 s warm (6 sessions: 2.6 s, slowest 9.2 s) against 0.2 s for the bridge (`Grep`). The bench does
  not show why. Workspace opens each file through the proven open (issue #144) and walks the tree one at a time (issue #160);
  the cost of that on Windows for 1,500 files was not split out here.
- The cold time of the bridge is its first call, which starts `claude.exe`: the first question took 1094 ms with one session
  and 819 to 860 ms with six, against 163 to 712 ms for Workspace. The later questions of a cold session did not wait for it.
- The characters differ by format, not by answer: Workspace gave 1466, 3452, 1739 and 2182 characters, the bridge 657, 2893,
  1023 and 2127. Workspace lists the kind and the size of each entry.
- 0 of the 336 calls failed. The two arms were not given the same policy: the bridge tools needed an `allow` rule for each
  of `Glob`, `Grep` and `Read`, and the Workspace read tools needed none.

## Limits of this measurement

- One run on one laptop, one fixture, a fixed order (Workspace, then the bridge, for 1 and then for 6 sessions). A later
  arm benefits from a warm file cache: the first Workspace question took 712 ms with one session and 163 ms with six.
  The spread inside a round (the max columns) is as large as some gaps, so only the large ones above are read.
- It does not say what a model does with either set of tools, how many calls a task needs, or what a real project of a
  different size costs. It measures one idle host and then 24 calls, with no concurrent calls.
- The bridge here is Claude Code 2.1.332 with its tools `Glob`, `Grep` and `Read`. It has no tool that only lists a folder.
  Another version has other tools and another memory.
- Not run: Linux and macOS (the memory columns are Windows only), a third run, the shared-server broker.

## Reproduce

```
npm run build
node bench/workspace-bridge.mjs [--counts 1,6] [--reps 5] [--json out.json] [--claude <path to claude.exe>]
```

The script refuses `claude.ps1`, and refuses to start a session with less than 3 GB of free RAM. It prints the tables
above and nothing from a result.
