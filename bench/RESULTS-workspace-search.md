# Workspace search with several files in flight (issue #151 follow-up)

\`search\` of the built-in Workspace took 2 to 6 s for a tree of 1,500 files on Windows, against 0.2 s for the Claude Code
bridge (\`bench/RESULTS-workspace-bridge.md\` of issue #151). This file holds the diagnosis, the change and its numbers.

## Where the time went

Profiled with every file system call timed, on the fixture of the #151 bench (1,500 files in 120 folders, 1 to 6 KB, 8 needle lines).
A file cost 12.9 awaited calls: \`lstat\` 5.1, handle \`stat\` 2.0, \`realpath.native\` 2.0, handle read 1.8, open 1.0, close 1.0.
Of the 10.0 s of the instrumented run, \`lstat\` took 3.5 s (35%), reads 1.3 s, handle \`stat\` 1.2 s, open 0.8 s, close 0.5 s and
\`realpath\` 0.2 s. The walk visited one file at a time, so each call was a round trip that nothing overlapped. The laptop was at
about 60% CPU from other work, so every time here is noisy by a factor of 2.

## The change

Up to 4 files of one walk are opened, proven and read at the same time (\`LIMITS.searchInFlight\`, the option \`limits.searchInFlight\`
for tests). Each file is proven by its own open as before. The answers are taken in the order of the walk, so the matches, the
counts and \`truncated\` are the same for any number (a test compares 1, 2, 4 and 8, also with a cut at \`maxMatches\`). The walk slot
is still one walk. A visit that is running ends before its folder closes, and a cancel waits for the running visits.

## Numbers

One provider, the same fixture, 7 searches in a row for each setting, 3 rounds of 1, 4 and 8 (ms, the median of each round):

| files in flight | round 1 | round 2 | round 3 |
|---|---|---|---|
| 1 | 2554 | 2473 | 2016 |
| 4 | 1344 | 1364 | 2113 |
| 8 | 1417 | 1430 | 1518 |

The best single search was 1.6 s with 1, 1.05 s with 4 and 0.9 s with 8. 8 was not better than 4 beyond the noise, so the default is 4.
Through the #151 bench (\`run_code\` calls, hosts started by the script), \`search\` warm, median of 6 calls for each of 1 and 6
sessions, one run with 1 in flight and one with 4, back to back:

| sessions | 1 in flight | 4 in flight |
|---|---|---|
| 1 | 2835 ms | 2192 ms |
| 6 | 2137 ms | 1782 ms |

That is 23% and 17% less. The bridge's \`Grep\` took 239 to 400 ms in the same runs. The gap to it is smaller than before and still large.
The other Workspace calls and the memory did not change (private bytes after the calls: 134 to 137 MB for 1 session, 563 to
625 MB for 6 sessions, within the noise of the two runs).

The rest of the time is the walk, which still goes one entry at a time: 3 \`lstat\` per entry for the proof of the folder around it,
before its file can start. The files overlap, the walk does not.

Not measured here: one CPU (Docker with \`--cpus 1\`), and Linux and macOS.

## Note on the next step (not built)

The 3 \`lstat\` of a walk entry (the folder is proven right before and right after the \`lstat\` of the entry) are the brackets of
the swap family of the ADR: they make sure that the names and the sizes that \`list\` and \`stat\` show come from the folder that
was proven, and not from a link that was swapped in for one read. For \`search\` the entry gives only its kind (file or folder) and
its name, and nothing of it is shown: a match shows the path of the file that was opened and proven, and its text comes from that
handle. A file that a swapped folder reached would fail its own open (a link in a part, or an identity that differs), and a name
that came from outside is opened as a candidate, so it is proven or refused. So a match path cannot show an unproven name. What
the bracket could still protect is the decision to open or enter: a swapped folder makes the walk spend time on outside
names (never show them), and it keeps the alternating family of \`list\` out of \`search\` by construction. Whether skipping the
brackets for \`search\` is a weakening of the proof is a judgment for the reviewer: it is not built here.
