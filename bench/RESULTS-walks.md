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
