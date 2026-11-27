# Workspace search with several files in flight (issue #151 follow-up)

`search` of the built-in Workspace took 2 to 6 s for a tree of 1,500 files on Windows, against 0.2 s for the Claude Code
bridge (`bench/RESULTS-workspace-bridge.md` of issue #151). This file holds the diagnosis, the change and its numbers.

## Where the time went

Profiled with every file system call timed, on the fixture of the #151 bench (1,500 files in 120 folders, 1 to 6 KB, 8 needle lines).
A file cost 12.9 awaited calls: `lstat` 5.1, handle `stat` 2.0, `realpath.native` 2.0, handle read 1.8, open 1.0, close 1.0.
Of the 10.0 s of the instrumented run, `lstat` took 3.5 s (35%), reads 1.3 s, handle `stat` 1.2 s, open 0.8 s, close 0.5 s and
`realpath` 0.2 s. The walk visited one file at a time, so each call was a round trip that nothing overlapped. The laptop was at
about 60% CPU from other work, so every time here is noisy by a factor of 2.

## The change

Up to 4 files of one walk are opened, proven and read at the same time (`LIMITS.searchInFlight`, the option `limits.searchInFlight`
for tests). Each file is proven by its own open as before. The answers are taken in the order of the walk, so the matches, the
counts and `truncated` are the same for any number (a test compares 1, 2, 4 and 8, also with a cut at `maxMatches`). The walk slot
is still one walk. A visit that is running ends before its folder closes, and a cancel waits for the running visits.

The second part of the change (C): the `lstat` of an entry, with the proof of the folder right before it and right after it, is made
for up to the same number of entries of one folder at the same time. Each entry has its own bracket and the answers are taken in
the order of the listing. The brackets use no state that is shared: `proven()` is an `lstat` of the path of the folder compared with
the identity that was proven at its open, so two calls at once only read. A swap between the two proofs of an entry is caught for
that entry, whatever the other entries do. A `list` and a `stat` still go one entry at a time (a test checks the peak). A test swaps
the folder from the Nth `lstat` on, for N from 1 to 40, with 4 entries in flight: no outside line came back in 40 runs.

## Numbers

One provider, the same fixture, 7 searches in a row for each setting, 3 rounds of 1, 4 and 8 (ms, the median of each round):

| files in flight | round 1 | round 2 | round 3 |
|---|---|---|---|
| 1 | 2554 | 2473 | 2016 |
| 4 | 1344 | 1364 | 2113 |
| 8 | 1417 | 1430 | 1518 |

The best single search was 1.6 s with 1, 1.05 s with 4 and 0.9 s with 8. 8 was not better than 4 beyond the noise, so the default is 4.
Through the #151 bench (`run_code` calls, hosts started by the script), `search` warm, median of 6 calls for each of 1 and 6
sessions, one run with 1 in flight and one with 4, back to back:

| sessions | 1 in flight | 4 in flight |
|---|---|---|
| 1 | 2835 ms | 2192 ms |
| 6 | 2137 ms | 1782 ms |

That is 23% and 17% less. The bridge's `Grep` took 239 to 400 ms in the same runs. The gap to it is smaller than before and still large.
The other Workspace calls and the memory did not change (private bytes after the calls: 134 to 137 MB for 1 session, 563 to
625 MB for 6 sessions, within the noise of the two runs).

With C (the brackets of 4 entries at the same time) the same provider test, 7 searches for each of 3 rounds (median of each round):

| files and entries in flight | round 1 | round 2 | round 3 |
|---|---|---|---|
| 1 | 2248 | 2160 | 2174 |
| 4 | 1090 | 1257 | 1211 |
| 8 | 1071 | 996 | 1053 |

Through the #151 bench, `search` warm, median of 6 calls, 1 in flight against 4 (with C), back to back:

| sessions | 1 in flight | 4 in flight |
|---|---|---|
| 1 | 2016 ms | 1073 ms |
| 6 | 2185 ms | 1060 ms |

That is 47% and 51% less. 8 in flight was about 10% faster than 4 in the provider test and is not taken: it is inside the noise,
and on one CPU more in flight cannot help. The bridge's `Grep` still takes 0.2 to 0.4 s.

Not measured here: one CPU (Docker with `--cpus 1`), and Linux and macOS.

## With the kind taken from the listing (A, `search` only)

`search` takes the kind of an entry (file or folder) from the directory listing, with no `lstat` and no proof of the folder around
one (a reviewer judged it safe for `search`: the kind only decides what the walk does next, each open proves its own name, and
`search` shows no size or metadata). `list` and `stat` keep both proofs. The calls of one search of the 1,500 files, counted with
every file system call timed, 4 in flight: `lstat` 8,351 with the kind from `lstat` and 3,488 with the kind from the listing, and
about 19.8 thousand calls in all against 15.0 thousand (24% fewer). The wall time of that instrumented search did not show the
gain (1.6 s and 1.8 s: the calls are cheap, 0.18 ms for an `lstat`, and the reads and the scan are what is left).

The provider test, 4 rounds of 7 searches, median of each round, 4 in flight, `lstat` kinds against listing kinds: 1053, 1226, 1713 and
1872 ms against 847, 1370, 1945 and 1509 ms. The laptop was at 57 to 72% CPU from other work and rose during the run, so this does not
resolve a difference: A is not shown to be faster in wall time here, only to make fewer calls.

The #151 bench, `search` warm, median of 6 calls, 1 in flight against 4, both with A, back to back (the load was high and the 6-session
run with 1 in flight was cut by the time budget in part, so its figure is the least reliable): 1 session 2498 ms against 1589 ms, 6
sessions 3271 ms against 1697 ms.

Not measured: one CPU (Docker with `--cpus 1`, held), Linux and macOS.

## Note on the reasoning for A

The 3 `lstat` of a walk entry (the folder is proven right before and right after the `lstat` of the entry) are the brackets of
the swap family of the ADR: they make sure that the names and the sizes that `list` and `stat` show come from the folder that
was proven, and not from a link that was swapped in for one read. For `search` the entry gives only its kind (file or folder) and
its name, and nothing of it is shown: a match shows the path of the file that was opened and proven, and its text comes from that
handle. A file that a swapped folder reached would fail its own open (a link in a part, or an identity that differs), and a name
that came from outside is opened as a candidate, so it is proven or refused. So a match path cannot show an unproven name. What
the bracket could still protect is the decision to open or enter: a swapped folder makes the walk spend time on outside
names (never show them), and it keeps the alternating family of `list` out of `search` by construction. Whether skipping the
brackets for `search` is a weakening of the proof is a judgment for the reviewer: it is not built here.
