// The spend cap of bench/interactive.mjs.

/** The money spent so far: the cost of the saved runs of --out, plus `extra`, money spent outside them. */
export const spentSoFar = (rows, extra) => rows.reduce((total, row) => total + row.costUsd, extra)

/**
 * The cost to expect of the next run: the most that a run of this arm and task has cost so far, else of this arm,
 * else $0.25. It is an estimate, not a bound: a run can cost more.
 */
export const estimate = (rows, arm, task) => {
  const same = rows.filter(r => r.arm === arm && r.task === task).map(r => r.costUsd)
  const armRows = rows.filter(r => r.arm === arm).map(r => r.costUsd)
  return same.length ? Math.max(...same) : armRows.length ? Math.max(...armRows) : 0.25
}
