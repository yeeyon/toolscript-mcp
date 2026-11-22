# Memory bench results: what N sessions cost today

`bench/memory.mjs` starts N toolscript-mcp hosts over stdio, one after the other, and measures the memory, the
processes and the start time of all of them. It is the measuring stick of issue #63 (shared downstream servers). The
same command, with `"share": true` in the config or `TOOLSCRIPT_SHARE` set, gives the "after" numbers.

## Fixture baseline

Command, on Windows 11 with the base host (no sharing exists yet):

    node bench/memory.mjs --json memory-fixture.json

The fixture has 3 stdio servers (`bench1`, `bench2`, `bench3`: `bench/fake-server.mjs`, each with its own argument)
and one HTTP entry (`down`) that nothing answers. Each session is a host alone, with no Claude Code: the
`claude mcp serve` bridge of a real session is not in these numbers. `conhost.exe` is the console host that Windows
starts for each hidden process. It counts as a process and adds 1.2 MB each.

## Fixture run, 60 s idle

## Memory bench 2026-11-21

2026-11-21, Windows_NT 10.0.26300 x64, Node v22.23.3, commit 028435a, mode fixture, idle 60 s, RAM 32496 MB total and 17851 MB free at the start.

Memory is private bytes (commit) in the headline columns and private working set in the second. MB is 1,048,576 bytes. A process counts once, by pid and creation time, over every tree of the round.

| sessions | phase | private bytes total (MB) | per session (MB) | private working set total (MB) | processes | copies per server key | leftovers |
| ---: | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | idle | 115.8 | 115.8 | 60.0 | 8 | bench1: 1 copies, node.exe 1 conhost.exe 1; bench2: 1 copies, node.exe 1 conhost.exe 1; bench3: 1 copies, node.exe 1 conhost.exe 1; down: 0 processes | none |
| 1 | after-run | 118.3 | 118.3 | 65.0 | 8 | bench1: 1 copies, node.exe 1 conhost.exe 1; bench2: 1 copies, node.exe 1 conhost.exe 1; bench3: 1 copies, node.exe 1 conhost.exe 1; down: 0 processes | none |
| 3 | idle | 346.5 | 115.5 | 179.3 | 24 | bench1: 3 copies, node.exe 3 conhost.exe 3; bench2: 3 copies, node.exe 3 conhost.exe 3; bench3: 3 copies, node.exe 3 conhost.exe 3; down: 0 processes | none |
| 3 | after-run | 354.6 | 118.2 | 193.9 | 24 | bench1: 3 copies, node.exe 3 conhost.exe 3; bench2: 3 copies, node.exe 3 conhost.exe 3; bench3: 3 copies, node.exe 3 conhost.exe 3; down: 0 processes | none |
| 6 | idle | 694.0 | 115.7 | 359.1 | 48 | bench1: 6 copies, node.exe 6 conhost.exe 6; bench2: 6 copies, node.exe 6 conhost.exe 6; bench3: 6 copies, node.exe 6 conhost.exe 6; down: 0 processes | none |
| 6 | after-run | 710.4 | 118.4 | 388.2 | 48 | bench1: 6 copies, node.exe 6 conhost.exe 6; bench2: 6 copies, node.exe 6 conhost.exe 6; bench3: 6 copies, node.exe 6 conhost.exe 6; down: 0 processes | none |

- servers that failed to connect (by key): down

### Per role, 6 sessions, idle

| role | image | processes | private bytes total (MB) | private bytes each, median (min to max) (MB) | private working set each, median (MB) |
| --- | --- | ---: | ---: | --- | ---: |
| host | node.exe | 6 | 366.5 | 61.1 (60.7 to 61.3) | 23.1 |
| other | conhost.exe | 6 | 7.3 | 1.2 (1.2 to 1.2) | 0.8 |
| server bench1 | conhost.exe | 6 | 7.1 | 1.2 (1.2 to 1.2) | 0.8 |
| server bench1 | node.exe | 6 | 99.6 | 16.6 (16.4 to 16.7) | 11.1 |
| server bench2 | conhost.exe | 6 | 7.1 | 1.2 (1.2 to 1.2) | 0.8 |
| server bench2 | node.exe | 6 | 99.6 | 16.6 (16.4 to 16.7) | 11.1 |
| server bench3 | conhost.exe | 6 | 7.1 | 1.2 (1.2 to 1.2) | 0.8 |
| server bench3 | node.exe | 6 | 99.5 | 16.6 (16.3 to 16.7) | 11.2 |
| total | | 48 | 694.0 | | |

### Timings (ms)

| sessions | measure | session 1 | sessions 2 to N, median (min to max) |
| ---: | --- | ---: | --- |
| 1 | initialize | 789 | - |
| 1 | tools/list | 793 | - |
| 1 | first run_code | 218 | - |
| 1 | second run_code | 150 | - |
| 3 | initialize | 862 | 872 (868 to 876) |
| 3 | tools/list | 873 | 884 (883 to 884) |
| 3 | first run_code | 432 | 425 (416 to 434) |
| 3 | second run_code | 373 | 391 (386 to 395) |
| 6 | initialize | 866 | 870 (824 to 897) |
| 6 | tools/list | 879 | 882 (835 to 914) |
| 6 | first run_code | 185 | 182 (167 to 220) |
| 6 | second run_code | 147 | 149 (145 to 171) |

run_code program: fixture: one list_issues call on each of the 3 servers, checked. Times run from spawn for initialize and tools/list, and from the request to the result for run_code.

The run took 267 s. Timing noise at 3 and 6 sessions is not a trend: the bench reports each value and claims no speedup.

## What the numbers say

- Each session costs about 116 MB of private bytes here: the host (61 MB), 3 fake servers (16.6 MB each) and 4
  console hosts. Copies of each server grow 1, 3, 6: nothing is shared today.
- A second full run gave 346.1 MB at 3 sessions (0.1 % from the run above) and 695.3 MB at 6 sessions. The 6-session
  total is 6 times the 1-session total within 0.5 % in both runs.
- Private working set is about half of the private bytes: idle servers hold commit that is not resident.
- Leftovers are 0 at every count, 10 s after the hosts closed.

## Fixture, sharing off against on (slice 3 of #63)

The fixture has 4 stdio servers, one of each share class: `bench1` has `"share": true`, `bench2` has a `cwd`, `bench3`
has no key (one copy for each folder), and `bench4` has `"share": false`. Sessions run in 2 folders. Windows 11, Node
22.23.3, commit 207d576, 20 s idle, `--closed` 10 s (off) and 20 s (on), `TOOLSCRIPT_BROKER_IDLE_MS=5000`. The commands:

    TOOLSCRIPT_SHARE=0 node bench/memory.mjs --folders a,b --idle 20 --closed 10
    TOOLSCRIPT_SHARE=1 TOOLSCRIPT_BROKER_IDLE_MS=5000 node bench/memory.mjs --folders a,b --idle 20 --closed 20

Private bytes in the idle phase, in MB, the process of the broker and its children included:

| sessions | off | on | saved | copies on (`bench1`, `bench2`, `bench3`, `bench4`) | copies off |
| ---: | ---: | ---: | ---: | --- | --- |
| 1 | 123.6 | 140.6 | -17.0 | 1, 1, 1, 1 | 1 each |
| 3 | 375.8 | 314.5 | 61.3 | 1, 1, 2, 3 | 3 each |
| 6 | 752.5 | 543.7 | 208.8 | 1, 1, 2, 6 | 6 each |

- One broker at every count, 15.8 MB of private bytes (the limit is 60 MB). Its children belong to no session.
- One session alone pays 17.0 MB: the broker (15.8 MB) and its console host (1.2 MB).
- Each added session costs `(T(6) - T(1)) / 5`: 125.8 MB off, 80.6 MB on. The difference, 45.2 MB, is the 3 shared
  copies that a session no longer starts (15 to 16 MB each with a console host) minus the extra copy of `bench3` in
  the second folder.
- The median host is 59.7 MB on and 60.0 MB off (the limit is 10 MB over off). All 4 servers connected and
  4 `list_issues` calls gave the right result in every session, on and off. Each server has 5 tools.
- Leftovers are 0 after the hosts closed, on and off: the broker ended at its idle time, and with it its children.
- `tools/list` of session 1 took 499 ms on and 553 ms off, a difference inside the noise of one run.

The fixture saves 209 MB at 6 sessions because a fake server costs 15 MB. The owner's saving is a number of the owner's
own config: section 11 of the slice bar measures it.

## Real config

Real mode is for the owner only. It uses the config file as given and the real home, so no agent or test runs it.
It starts the real servers, so it takes more time (a run of 1, 3 and 6 sessions can take about 20 minutes).
`run_code` runs `return 1` and calls no tool, because a real tool can write or ask. The `search_tools` call that waits
for the connect touches each real server.

    node bench/memory.mjs --config <path to your config file> --json memory-real.json

Paste the Markdown block from stdout here. Do not paste the JSON: it holds pids and server keys of your setup. For the
"after" numbers, run the same command once the sharing switch exists (`"share"` in the config or `TOOLSCRIPT_SHARE`).
The bench passes both through and has no switch of its own.

### Owner's config, 2026-11-22, before sharing

Windows 11, Node 22.23.3, commit 726eab2, 60 s idle, 32 GB RAM. 8 servers: 4 stdio (one `node` server through `npx`,
and 3 entries of one native binary with another environment each), 3 over HTTP, and the `claude mcp serve` bridge.
Server keys are replaced by kinds here. All 8 servers connected in every session, and no process was left after
close.

| sessions | private bytes total (MB) | per session (MB) | private working set total (MB) | processes |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 670.3 | 670.3 | 225.9 | 12 |
| 3 | 2,074.9 | 691.6 | 704.3 | 36 |
| 6 | 4,036.5 | 672.8 | 1,353.6 | 72 |

Per role at 6 sessions, idle, private bytes each as a median:

| role | copies | each (MB) | total (MB) |
| --- | ---: | ---: | ---: |
| `claude mcp serve` bridge | 6 | 315.3 | 1,909.6 |
| native binary, 3 entries | 18 | 67.7 | 1,240.9 |
| `node` server | 6 | 78.3 | 477.4 |
| toolscript-mcp host | 6 | 66.7 | 408.7 |

Totals include each process's `conhost.exe` (about 1.2 MB). The 4 stdio servers cost about 286 MB a session. Those are
what sharing can save. The bridge and the host stay per session.
