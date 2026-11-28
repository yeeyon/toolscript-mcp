# Parallel Workspace walks (issue #160)

`node --experimental-strip-types bench/walks.mjs --files 2500`, in Docker (`node:22-bookworm-slim`) with `--cpus 1`,
one container at a time, the tree in `/tmp` of the container. Tree: 2,500 files in 800 folders, half under `src/`, plus
30,000 names that the `.gitignore` hides. N searches start together, each with its own query. 3 runs for each cell.
The first try with 10,000 files had a search alone that ran to the 10 s budget, so the count went to 2,500 one time.

The container shows only whether the cut comes back on Linux. It does not reproduce the Windows sighting.
The host laptop was shared with other builders, so a search alone ranged from 1.0 to 4.6 s between runs. Compare
the cut count, not the seconds across tables. With one CPU a batch is never faster than N times one search.

Cells are `wall s of the 3 runs / calls cut of the 3 runs` (each batch has N calls).

## Before: no walk limit (base 20791e9)

| N   | no include            | include `src/**/*.ts` |
| --- | --------------------- | --------------------- |
| 1   | 6.8 6.5 6.9 / 0 0 0   | 3.4 4.0 3.2 / 0 0 0   |
| 2   | 10.1 10.0 4.2 / 2 2 0 | 3.7 3.6 4.6 / 0 0 0   |
| 4   | 10.0 7.9 9.3 / 4 0 0  | 6.6 6.8 6.7 / 0 0 0   |
| 8   | 10.0 10.0 10.0 / 8 8 8 | 10.0 10.0 10.0 / 8 8 8 |

Gate: a batch of 8 is cut in 3 of 3 runs and the search alone in 0 of 3, for both forms. Open for both. The form
with `include` is the new one, because #168 prunes there: a search alone takes 3.2 to 4.0 s and a batch of 8 is cut.

## Trial: 2 slots

| N   | no include                 | include `src/**/*.ts`  |
| --- | -------------------------- | ---------------------- |
| 2   | 10.0 6.7 4.1 / 1 0 0       | 4.4 4.1 3.3 / 0 0 0    |
| 8   | 15.6 14.2 28.2 / 0 0 2     | 19.1 18.5 12.8 / 0 0 0 |

Two walks together run past 10 s where one alone does not (no include, 5.5 to 6.7 s alone), so one slot (criterion 6).

## After: 1 slot

| N   | no include                | include `src/**/*.ts`  |
| --- | ------------------------- | ---------------------- |
| 1   | 4.4 3.7 4.6 / 0 0 0       | 1.2 1.1 1.0 / 0 0 0    |
| 2   | 13.3 12.3 11.1 / 0 0 0    | 3.4 2.3 2.0 / 0 0 0    |
| 4   | 26.1 21.5 26.1 / 0 0 0    | 4.8 4.6 5.0 / 0 0 0    |
| 8   | 43.2 32.0 25.4 / 0 0 0    | 14.7 20.8 19.2 / 0 0 0 |

Longest call of any batch: 43.2 s, under the 60 s call limit. Eight walks of 10 s each would be 80 s, past it, but a
walk that runs to 10 s alone is cut either way and a batch of 8 never ran that long here.
The wall time of a batch is longer than before because the calls that were cut at 10 s now finish.

## Issue #180: 1 slot against 2 slots, in CI

Outcome: the slot count stays 1. Two slots cut batch time on trees that fit the budget, and cut calls on a tree where a
search alone takes more than half of `searchMs`.

GitHub Actions run 46121218159 on the head with the 4-open `search` (`searchInFlight` 4). Median of 6 runs for each cell (2
passes of 3 at each slot count, in the order 2, 1, 2, 1). Seconds: alone / batch of 8. Cuts were 0 in every cell.

| Runner                  | Tree | no include, 1 slot | no include, 2 slots | include, 1 slot | include, 2 slots |
| ----------------------- | ---- | ------------------ | ------------------- | --------------- | ---------------- |
| ubuntu, 4 CPUs          | 2500 | 0.30 / 2.40        | 0.30 / 1.50         | 0.10 / 2.00     | 0.10 / 0.80      |
| ubuntu, 4 CPUs          | 5500 | 0.40 / 3.30        | 0.40 / 2.70         | 0.20 / 1.75     | 0.20 / 1.40      |
| windows, 4 CPUs         | 2500 | 2.65 / 21.75       | 2.50 / 18.05        | 1.30 / 11.55    | 1.60 / 9.00      |
| windows, 4 CPUs         | 5500 | 2.40 / 24.00       | 2.50 / 22.10        | 1.55 / 11.90    | 1.70 / 11.40     |
| Docker `--cpus 2`       | 2500 | 0.30 / 4.60        | 0.40 / 1.90         | 0.35 / 2.10     | 0.20 / 0.90      |

The batch median is lower at 2 slots in all 10 cells. The alone median is higher in 4 cells, but a search alone holds one
slot and runs the same code at both counts, and the passes of one slot count differ by as much (Windows 2500 include at
2 slots: 1.2 s in pass 1, 1.8 s in pass 3). These are noise.

Near the budget: run 46123206860, windows, 16000 files, 2 runs per cell (2 passes of 2 at each slot count). A search alone
took 5.4 to 7.5 s, 54 to 75 % of `searchMs` (10 s). The time limit binds, not the 20000-file cap. Cut calls ran exactly 10.0 s.

| Form (cuts) / pass         | alone s | batch of 2, wall s | batch of 8, wall s | cut calls          |
| -------------------------- | ------- | ------------------ | ------------------ | ------------------ |
| no include, 2 slots, pass 1 | 7.4     | 10.0 (2/2 cut)     | 40.0 (8/8, 6/8)    | batches of 2, 4, 8 |
| no include, 2 slots, pass 3 | 5.5     | 9.4, 9.9 (0 cut)   | 40.0 (8/8), 37.9   | N 4 (4/4), N 8     |
| no include, 1 slot, pass 2  | 5.4     | 10.7 (0 cut)       | 51.7, 54.5 (0 cut) | 0                  |
| no include, 1 slot, pass 4  | 5.5     | 10.8 (0 cut)       | timed out at 60 s  | 0                  |
| include, 2 slots           | 2.9     | 5.3 to 6.9         | 19.7 to 25.6       | 0                  |
| include, 1 slot            | 4.2     | 8.5 to 9.1         | 23.4, 31.4         | 0                  |

Why 1: two walks on one tree slow each other from about 5.5 s to about 10 s each (wall per call 0.85 to 0.9 of one after
the other), so they sit on the 10 s edge and a batch is cut. One slot cut no call, but a batch of 8 searches took 51.7 to
54.5 s and once passed the 60 s request timeout of the client (`-32001`). That queue is a separate finding.
