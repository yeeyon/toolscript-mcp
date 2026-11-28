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
import { estimate } from './spend.mjs'

/**
 * SHA-256 of dist/host/main.js and runtime/runner.mjs of the published toolscript-mcp@1.0.5 tarball (`npm pack`, extracted in a
 * new empty folder, hashed, never run). A --base that differs gets one WARN line: a local build of the tag can differ in the
 * paths that its comments hold, and then the person checks that it is the build that they mean.
 */
export const PINNED_105 = {
  mainSha256: 'bafac269650da58154a48d7ff9c147331784749cbf90a83212e460439b72c348',
  runnerSha256: '2f4069061b990fdf3de9ea26c954fad97a4b293e4b61646efbac29173317c47a',
}

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

const sha256Of = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/**
 * The build in `dir`: its main.js, the version of its package.json and the SHA-256 of its main.js and of runtime/runner.mjs
 * (the sandbox, which main.js starts and does not bundle). Or the reason it is not one.
 */
export const readBuild = dir => {
  const root = path.resolve(dir)
  const main = path.join(root, 'dist', 'host', 'main.js')
  const runner = path.join(root, 'runtime', 'runner.mjs')
  if (!fs.existsSync(main)) return { error: `${root} has no dist/host/main.js` }
  if (!fs.existsSync(runner)) return { error: `${root} has no runtime/runner.mjs` }
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
    sha256: sha256Of(main),
    runnerSha256: sha256Of(runner),
  }
}

/**
 * The builds that `armIds` need, or the one line of each error (it names the flag), and the WARN lines. `head` defaults to
 * `repo`. An arm whose build is missing ends the command before any run, and so does a base whose main.js is the head's (the
 * comparison would be void). A base that is not the published 1.0.5 only warns.
 */
export const resolveBuilds = ({ armIds, head, base, repo }) => {
  const errors = []
  const warnings = []
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
  if (builds.head && builds.base && builds.head.sha256 === builds.base.sha256)
    errors.push(
      `--base and --head hold the same dist/host/main.js (SHA-256 ${builds.base.sha256}): the comparison would be void`,
    )
  if (builds.base) {
    const differs = [
      builds.base.sha256 !== PINNED_105.mainSha256 && 'dist/host/main.js',
      builds.base.runnerSha256 !== PINNED_105.runnerSha256 && 'runtime/runner.mjs',
    ].filter(Boolean)
    if (differs.length > 0)
      warnings.push(
        `WARN --base: ${differs.join(' and ')} of ${builds.base.dir} (version ${builds.base.version}) differ from the published toolscript-mcp@1.0.5 (main.js SHA-256 ${PINNED_105.mainSha256})`,
      )
  }
  return { errors, warnings, builds }
}

/** The environment of the Claude Code pty: the operator's, with no CLAUDE* (session ids, socket, effort) and no TOOLSCRIPT_* (the row says what is set). */
export const childEnv = (env, { codeMode, bash }) => {
  const out = { ...env }
  for (const k of Object.keys(out)) if (/^(CLAUDE|TOOLSCRIPT_)/i.test(k)) delete out[k]
  if (codeMode) out.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  out.CLAUDE_CODE_GIT_BASH_PATH = bash
  return out
}

/** The home of toolscript in one run: a fresh folder, so the shapes and tool lists that one arm learns never reach another. */
export const homeEnv = home => ({
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
})

/** The variables on the MCP entry of an arm: its own variable (none for `toolscript`) and the fresh home, the same keys for all. */
export const entryEnv = (arm, home) => ({ ...envOfArm(arm), ...homeEnv(home) })

/** The cwd name of an arm: a fixed width, so no arm's prompt holds fewer path characters than another's. */
export const cwdSlug = (arm, allArms) => `arm${String(allArms.indexOf(arm)).padStart(2, '0')}`

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
    runnerSha256: build.runnerSha256,
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
      `- ${arm}: version ${uniq('version').join(', ')}, main.js SHA-256 ${uniq('mainSha256').join(', ')}, runner.mjs SHA-256 ${uniq(
        'runnerSha256',
      )
        .map(h => h ?? 'none')
        .join(', ')}, variables ${variables.join('; ')}, first method sent ${uniq('firstMethod')
        .map(m => m ?? 'none')
        .join(', ')}`,
    )
  }
  return [...lines, '']
}

/**
 * The jobs in the order that the bench runs them: arms alternate inside a task. The toolscript arms (the ones that are judged)
 * rotate among the places that they hold, one place each rep (a Latin square: with as many reps as toolscript arms, each leads
 * equally often and stands after each other equally often). Any other arm (codemode, direct) keeps its place.
 */
export const jobsOf = ({ tasks, armIds, reps }) => {
  const jobs = []
  const places = armIds.flatMap((a, i) => (a.startsWith('toolscript') ? [i] : []))
  for (let rep = 1; rep <= reps; rep++) {
    const start = (rep - 1) % Math.max(places.length, 1)
    const order = [...armIds]
    for (const [k, place] of places.entries()) order[place] = armIds[places[(k + start) % places.length]]
    for (const task of tasks) for (const arm of order) jobs.push({ task, arm, rep })
  }
  return jobs
}

/** The dry run: what would run, with no Claude Code started and nothing spent. Lines, or the errors of the builds. `rows`: the saved runs. */
export const dryRunPlan = ({ armIds, builds, tasks, reps, todo, rows = [], spent, maxSpend, model }) => {
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
        : `- ${arm}: build ${b.dir}, version ${b.version}, main.js SHA-256 ${b.sha256}, runner.mjs SHA-256 ${b.runnerSha256}, variables ${vars}`,
    )
  }
  lines.push('', `tasks: ${tasks.map(t => t.id).join(', ')}`, `reps: ${reps}`, `runs to do: ${todo.length}`, 'order:')
  for (const [i, j] of todo.entries()) lines.push(`${String(i + 1).padStart(3)}. ${j.task.id}-${j.arm}-${j.rep}`)
  // The estimate of each planned run from the saved runs (bench/spend.mjs); the real run updates it as runs finish.
  const planned = todo.reduce((n, j) => n + estimate(rows, j.arm, j.task.id), 0)
  // A run whose arm (or toolscript family) has no saved run has the default of bench/spend.mjs, not a measured cost.
  const defaulted = todo.filter(
    j => !rows.some(r => r.arm === j.arm || (j.arm.startsWith('toolscript') && r.arm.startsWith('toolscript'))),
  ).length
  lines.push(
    '',
    `spent so far $${spent.toFixed(4)}, cap $${maxSpend}`,
    `estimate of the ${todo.length} planned runs $${planned.toFixed(4)}, total $${(spent + planned).toFixed(4)} against the cap $${maxSpend}${spent + planned > maxSpend ? ': OVER, the run would stop early' : ''}`,
  )
  if (defaulted > 0)
    lines.push(
      `${defaulted} of the ${todo.length} runs are estimated at the $0.25 default (no saved run of the arm): with no saved runs this is a guess, not a measured cost, and it says nothing about a real over-cap`,
    )
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
 * The ratio of one metric, task by task: the median over the tasks of (median of `head` on the task / median of `base` on
 * the task), only on tasks where both have rows. Tasks differ a lot in size, so one median over all runs would move with
 * which cold runs are left out.
 */
const taskRatio = (headRows, baseRows, f) => {
  const ratios = []
  for (const task of new Set(headRows.map(r => r.task))) {
    const [h, b] = [headRows, baseRows].map(rs => rs.filter(r => r.task === task).map(f))
    if (h.length > 0 && b.length > 0) ratios.push(median(h) / median(b))
  }
  return { ratio: median(ratios), tasks: ratios.length }
}

const RELEASE_ARMS = ['toolscript-1.0.5', 'toolscript-legacy', 'toolscript']

/**
 * The pass rule of the release run. Every toolscript arm correct in every run that finished (cold runs too); then, on warm
 * runs, toolscript-legacy against toolscript-1.0.5 and toolscript against toolscript-legacy: the median over tasks of the
 * per-task ratio of medians within +2 % on the total input and on the first-call input, and no more failed run_code calls
 * (all finished runs). `codemode` is reported, not judged. The verdict needs all three arms with warm runs, and each pair
 * with a task that both have: else `pass` is undefined and a line names what is missing. `pass` is false when a limit fails.
 * With no toolscript row that names its build (`version`), an older results folder: no lines.
 */
export const passRule = rows => {
  if (!rows.some(r => RELEASE_ARMS.includes(r.arm) && r.version !== undefined)) return { lines: [], pass: undefined }
  const ran = rows.filter(r => r.error === undefined)
  const warm = ran.filter(r => !r.cold)
  const of = (rs, arm) => rs.filter(r => r.arm === arm)
  const results = []
  const gaps = []
  for (const arm of RELEASE_ARMS) {
    const wrong = of(ran, arm).filter(r => !r.correct).length
    if (of(ran, arm).length > 0)
      results.push({
        ok: wrong === 0,
        text: `${arm}: ${of(ran, arm).length - wrong}/${of(ran, arm).length} correct (cold runs too)`,
      })
    if (of(warm, arm).length === 0)
      gaps.push(
        `${arm} has no warm run (${of(ran, arm).length} finished, ${of(ran, arm).filter(r => r.cold).length} cold, ${of(rows, arm).length - of(ran, arm).length} errored)`,
      )
  }
  for (const [head, base] of [
    ['toolscript-legacy', 'toolscript-1.0.5'],
    ['toolscript', 'toolscript-legacy'],
  ]) {
    if (of(warm, head).length === 0 || of(warm, base).length === 0) continue
    for (const [name, f] of [
      ['total input tokens', totalInput],
      ['first-call input tokens', r => r.firstCallInput],
    ]) {
      const { ratio, tasks } = taskRatio(of(warm, head), of(warm, base), f)
      if (tasks === 0) {
        gaps.push(`${head} and ${base} have no task with warm runs in both`)
        break
      }
      results.push({
        ok: ratio <= LIMIT,
        text: `${head} against ${base}: ${name}, median over ${tasks} tasks of the per-task ratio of medians ${((ratio - 1) * 100).toFixed(2)} % (limit +2 %)`,
      })
    }
    const [h, b] = [of(ran, head), of(ran, base)].map(rs => rs.reduce((n, r) => n + failedRunCode(r), 0))
    results.push({ ok: h <= b, text: `${head} against ${base}: failed run_code calls ${h} against ${b}` })
  }
  const failed = results.some(r => !r.ok)
  return {
    lines: [
      '### Pass rule of the 1.1.0 release run (warm runs; codemode is reported, not judged)',
      '',
      ...results.map(r => `- ${r.ok ? 'PASS' : 'FAIL'} ${r.text}`),
      ...[...new Set(gaps)].map(g => `- NO VERDICT: ${g}`),
      '',
    ],
    pass: failed ? false : gaps.length > 0 ? undefined : true,
  }
}
