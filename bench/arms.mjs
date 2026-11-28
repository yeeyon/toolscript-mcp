// The toolscript arms of bench/interactive.mjs (the 1.1.0 regression bench), kept apart from the terminal driver so that a
// test can run them with no pty and no spend: which build and which variable each arm has, the check of the builds, the
// fields that a saved row gets, the dry-run plan and the pass rule of the release run.
//
//   toolscript          the head build, no protocol variable: it runs on whatever that build's default is
//   toolscript-legacy   the head build with TOOLSCRIPT_PROTOCOL=legacy in the env of its MCP entry, nothing else changed
//   toolscript-1.0.5    the build named by --base, the same config and policy as `toolscript`
//
// A build is a folder that holds dist/host/main.js and package.json: the repo, a worktree, or
// <prefix>/node_modules/toolscript-mcp of an install. Nothing here installs or builds.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** `build`: which of the two folders the arm runs. `env`: the variables on the MCP entry, and nothing else differs. */
export const TOOLSCRIPT_ARMS = {
  toolscript: { build: 'head', env: {} },
  'toolscript-legacy': { build: 'head', env: { TOOLSCRIPT_PROTOCOL: 'legacy' } },
  'toolscript-1.0.5': { build: 'base', env: {} },
}
/** The arms that run a build of toolscript (the lean arm runs the head, as `toolscript`). */
export const buildOfArm = arm =>
  arm === 'toolscript-1.0.5' ? 'base' : arm.startsWith('toolscript') ? 'head' : undefined
export const envOfArm = arm => TOOLSCRIPT_ARMS[arm]?.env ?? {}

/** The build in `dir`: its main.js, the version of its package.json and the SHA-256 of its main.js. Or the reason it is not one. */
export const readBuild = dir => {
  const root = path.resolve(dir)
  const main = path.join(root, 'dist', 'host', 'main.js')
  if (!fs.existsSync(main)) return { error: `${root} has no dist/host/main.js` }
  let version
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  } catch {
    return { error: `${root} has no readable package.json` }
  }
  if (typeof version !== 'string' || version === '') return { error: `${root}/package.json has no version` }
  return {
    dir: root,
    main,
    version,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(main)).digest('hex'),
  }
}

/**
 * The builds that `armIds` need, or the one line of each error (it names the flag). `head` defaults to `repo`. An arm whose
 * build is missing ends the command before any run.
 */
export const resolveBuilds = ({ armIds, head, base, repo }) => {
  const errors = []
  const builds = {}
  const need = new Set(armIds.map(buildOfArm).filter(Boolean))
  if (need.has('head')) {
    const b = readBuild(head ?? repo)
    if (b.error) errors.push(`--head: ${b.error}`)
    else builds.head = b
  }
  if (need.has('base')) {
    if (base === undefined)
      errors.push('--base <dir> is needed by the arm toolscript-1.0.5: a folder with dist/host/main.js')
    else {
      const b = readBuild(base)
      if (b.error) errors.push(`--base: ${b.error}`)
      else builds.base = b
    }
  }
  return { errors, builds }
}

/** The entry of toolscript in an MCP config: the build's main.js, the arm's config file and its variables only. */
export const toolscriptEntry = (build, configFile, env) => ({
  command: 'node',
  args: [build.main, '--config', configFile],
  ...(Object.keys(env).length > 0 && { env: { ...env } }),
})

/** The first method that a client sent, from the text of `$BENCH_LOG.first`, or undefined. */
export const firstMethodOf = text => {
  try {
    const { method } = JSON.parse(String(text).split('\n')[0] ?? '')
    return typeof method === 'string' ? method : undefined
  } catch {
    return undefined
  }
}

/** The fields that a row of a toolscript arm gets: what really ran. */
export const buildFields = (arm, builds, firstMethod) => {
  const kind = buildOfArm(arm)
  const build = kind === undefined ? undefined : builds[kind]
  if (build === undefined) return {}
  return {
    version: build.version,
    mainSha256: build.sha256,
    variables: envOfArm(arm),
    firstMethod: firstMethod ?? null,
  }
}

/** The lines above the tables: one for each toolscript arm of the rows, with the values that its runs had. */
export const buildLines = rows => {
  const arms = [...new Set(rows.filter(r => r.version !== undefined).map(r => r.arm))]
  if (arms.length === 0) return []
  const lines = ['### Builds that ran', '']
  for (const arm of arms) {
    const rs = rows.filter(r => r.arm === arm && r.version !== undefined)
    const uniq = key => [...new Set(rs.map(r => JSON.stringify(r[key] ?? null)))].map(s => JSON.parse(s))
    const variables = uniq('variables').map(v =>
      v === null || Object.keys(v).length === 0
        ? 'none'
        : Object.entries(v)
            .map(([k, x]) => `${k}=${x}`)
            .join(' '),
    )
    lines.push(
      `- ${arm}: version ${uniq('version').join(', ')}, main.js SHA-256 ${uniq('mainSha256').join(', ')}, variables ${variables.join('; ')}, first method sent ${uniq(
        'firstMethod',
      )
        .map(m => m ?? 'none')
        .join(', ')}`,
    )
  }
  return [...lines, '']
}

/** The jobs in the order that the bench runs them: arms alternate inside a task, and the order flips every rep. */
export const jobsOf = ({ tasks, armIds, reps }) => {
  const jobs = []
  for (let rep = 1; rep <= reps; rep++)
    for (const task of tasks) for (const arm of rep % 2 ? armIds : [...armIds].reverse()) jobs.push({ task, arm, rep })
  return jobs
}

/** The dry run: what would run, with no Claude Code started and nothing spent. Lines, or the errors of the builds. */
export const dryRunPlan = ({ armIds, builds, tasks, reps, todo, spent, maxSpend, model }) => {
  const lines = [`dry run: no Claude Code is started and nothing is spent. Model ${model}.`, '', 'arms:']
  for (const arm of armIds) {
    const kind = buildOfArm(arm)
    const b = kind === undefined ? undefined : builds[kind]
    const vars =
      Object.entries(envOfArm(arm))
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') || 'none'
    lines.push(
      b === undefined
        ? `- ${arm}`
        : `- ${arm}: build ${b.dir}, version ${b.version}, main.js SHA-256 ${b.sha256}, variables ${vars}`,
    )
  }
  lines.push('', `tasks: ${tasks.map(t => t.id).join(', ')}`, `reps: ${reps}`, `runs to do: ${todo.length}`, 'order:')
  for (const [i, j] of todo.entries()) lines.push(`${String(i + 1).padStart(3)}. ${j.task.id}-${j.arm}-${j.rep}`)
  lines.push('', `spent so far $${spent.toFixed(4)}, cap $${maxSpend}`)
  return lines
}

// --- the pass rule of the release run ----------------------------------------------------------------

const sorted = xs => [...xs].sort((a, b) => a - b)
const median = xs => {
  const s = sorted(xs)
  const m = Math.floor(s.length / 2)
  return s.length === 0 ? NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
/** Everything that the model reads as input in a run: fresh, cache reads and cache writes. */
const totalInput = r => r.freshInput + r.cacheRead + r.cacheWrite
const failedRunCode = r => r.failedTools?.mcp__toolscript__run_code ?? 0
/** The most that a toolscript arm may exceed the arm before it on the two medians: 2 %. */
export const LIMIT = 1.02

/**
 * The pass rule of the release run, on warm runs (`cold` false) and no error: every toolscript arm correct in every run;
 * toolscript-legacy against toolscript-1.0.5, and toolscript against toolscript-legacy, within +2 % on the median total
 * input and the median first-call input, and no more failed run_code calls. `codemode` is reported, not judged. Gives the
 * lines and `pass` (undefined when an arm that the rule needs has no warm run).
 */
export const passRule = rows => {
  const warm = rows.filter(r => r.error === undefined && !r.cold)
  const of = arm => warm.filter(r => r.arm === arm)
  const arms = ['toolscript-1.0.5', 'toolscript-legacy', 'toolscript']
  const present = arms.filter(a => of(a).length > 0)
  if (present.length < 2) return { lines: [], pass: undefined }
  const results = []
  for (const arm of present) {
    const wrong = of(arm).filter(r => !r.correct).length
    results.push({ ok: wrong === 0, text: `${arm}: ${of(arm).length - wrong}/${of(arm).length} correct` })
  }
  for (const [head, base] of [
    ['toolscript-legacy', 'toolscript-1.0.5'],
    ['toolscript', 'toolscript-legacy'],
  ]) {
    if (!present.includes(head) || !present.includes(base)) continue
    for (const [name, f] of [
      ['median total input tokens', totalInput],
      ['median first-call input tokens', r => r.firstCallInput],
    ]) {
      const [h, b] = [median(of(head).map(f)), median(of(base).map(f))]
      results.push({
        ok: h <= b * LIMIT,
        text: `${head} against ${base}: ${name} ${Math.round(h)} against ${Math.round(b)} (${(((h - b) / b) * 100).toFixed(2)} %, limit +2 %)`,
      })
    }
    const [h, b] = [
      of(head).reduce((n, r) => n + failedRunCode(r), 0),
      of(base).reduce((n, r) => n + failedRunCode(r), 0),
    ]
    results.push({ ok: h <= b, text: `${head} against ${base}: failed run_code calls ${h} against ${b}` })
  }
  return {
    lines: [
      '### Pass rule of the 1.1.0 release run (warm runs; codemode is reported, not judged)',
      '',
      ...results.map(r => `- ${r.ok ? 'PASS' : 'FAIL'} ${r.text}`),
      '',
    ],
    pass: results.every(r => r.ok),
  }
}
