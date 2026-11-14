// run_code: checks a program before it runs, asks the person for the tools
// that no policy rule allows, runs the program in the sandbox and answers its
// nested calls through the downstream clients. The exchange dir goes in every case.

import fs from 'node:fs'
import path from 'node:path'
import { argSpec, catalogOf, learnShape } from '../core/catalog.ts'
import type { Config, ServerKey } from '../core/config.ts'
import { approvalNote, askText, checkCall, deniedReport, planRun, refusedReport } from '../core/policy.ts'
import {
  MAX_SEEN,
  callKey,
  checkCalls,
  errorText,
  fileNameError,
  fileText,
  formatOutcome,
  isCallable,
  keep,
  limiter,
  literalCalls,
  mcpReply,
  problemReport,
  recallReply,
  shapeOf,
  shownText,
  splitToolName,
  takeMessages,
  type CallRecord,
  type Kept,
  type Reply,
  type RunnerDone,
  type RunnerError,
  type RunnerMessage,
} from '../core/protocol.ts'
import { SERVER_NAME } from '../core/tools.ts'
import type { Downstream } from './downstream.ts'
import { RUNNER, launch, makeExchangeDir, removeExchangeDir, type Ending } from './launch.ts'

const MAX_RESULT_CHARS = 20_000
// Nested calls of one run that wait for a reply at one time: a program that
// maps over hundreds of ids must not hit a server's rate limit at once.
const MAX_PARALLEL_CALLS = 8
// How long a run waits for calls still running after the sandbox ends. Then
// they are cancelled, so a call that hangs does not hold the result.
const SETTLE_MS = 1000
const MAX_FILE_CHARS = 16 * 1024 * 1024
const MAX_READ_BYTES = 4 * 1024 * 1024
const MAX_STDERR_CHARS = 8000

/** What the person said to the tools that need approval before a run. */
export type Approval = 'accept' | 'decline' | 'unsupported'

/** What one run needs from the server around it. */
export type RunContext = {
  readonly downstream: Downstream
  readonly config: Config
  /** The results kept for recall(n), for the whole session. */
  readonly kept: Kept
  /** The shape of each tool's result, by tool name, for search_tools. */
  readonly shapes: Map<string, string>
  /** The folder of saveFile in this session, as an absolute path. */
  readonly filesDir: string
  /** Asks the person to approve the tools for one run. */
  readonly ask: (tools: readonly string[], code: string) => Promise<Approval>
  /** True when the client can show an approval prompt. */
  readonly canAsk: () => boolean
  /** Aborts when the server shuts down or the client cancels the call: the sandbox is killed. */
  readonly signal: AbortSignal
  readonly log: (line: string) => void
}

export type RunResult = { readonly text: string; readonly isError: boolean }

const refused = (text: string): RunResult => ({ text, isError: true })

/**
 * One run_code call. The check of names and the policy come first: a program
 * with a wrong name or a denied tool never starts a sandbox, and the approval
 * prompt comes before the run's timer starts.
 */
export const runCode = async (ctx: RunContext, code: string): Promise<RunResult> => {
  if (code.trim() === '') return refused('Error: code is empty.')
  await ctx.downstream.settled
  const catalog = catalogOf(ctx.downstream.states())
  const specs = new Map(catalog.map(t => [t.name, argSpec(t.inputSchema)]))
  const literal = literalCalls(code).filter(c => isCallable(c.tool, SERVER_NAME))
  const problems = checkCalls(literal, new Set(specs.keys()), tool => specs.get(tool), {})
  if (problems.length > 0) return refused(problemReport(problems))

  const plan = planRun(ctx.config.policy, literal)
  if (plan.kind === 'refused') return refused(deniedReport(plan.denied))
  if (plan.ask.length > 0) {
    const answer = ctx.canAsk() ? await ctx.ask(plan.ask, code) : 'unsupported'
    if (answer !== 'accept') return refused(refusedReport(plan.ask, answer))
  }
  if (ctx.signal.aborted) return refused('Error: the server is shutting down. The program did not run.')
  return execute(ctx, code, new Set(plan.ask))
}

/** True when `file` is inside `dir`. Both are real paths. */
const isInside = (file: string, dir: string): boolean => {
  const rel = path.relative(dir, file)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// saveFile writes only a plain file name in the session's folder.
const saveFile = async (dir: string, name: string, data: unknown): Promise<Reply> => {
  const problem = fileNameError(name)
  if (problem !== undefined) return { ok: false, error: problem }
  const text = fileText(name, data)
  if (text.length > MAX_FILE_CHARS)
    return { ok: false, error: `saveFile: ${text.length} characters is more than ${MAX_FILE_CHARS}; save less data` }
  // Only the person can read the saved data: a program can save what its calls returned.
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, name)
  const old = await fs.promises.lstat(file).catch(() => undefined)
  if (old !== undefined && !old.isFile()) return { ok: false, error: `saveFile: ${name} exists and is not a file` }
  await fs.promises.writeFile(file, text, { mode: 0o600 })
  return { ok: true, value: file }
}

// readFile reads only a file in the session's saveFile folder: a program can
// send what it reads to an MCP tool. The real paths stop a link out of the folder.
const readFile = async (dir: string, asked: string): Promise<Reply> => {
  const refusal: Reply = { ok: false, error: `readFile: ${asked} is not a file from saveFile in this session` }
  const [real, realDir] = await Promise.all([
    fs.promises.realpath(path.resolve(dir, asked)).catch(() => undefined),
    fs.promises.realpath(dir).catch(() => undefined),
  ])
  if (real === undefined || realDir === undefined || !isInside(real, realDir)) return refusal
  const stat = await fs.promises.stat(real)
  if (!stat.isFile()) return refusal
  if (stat.size > MAX_READ_BYTES)
    return { ok: false, error: `readFile: ${asked} is ${stat.size} bytes, more than readFile loads` }
  return { ok: true, value: await fs.promises.readFile(real, 'utf8') }
}

const NO_RESOURCES: Reply = { ok: false, error: 'resources() and readResource() are not available in toolscript-mcp' }

// The runner reports its own time limit. With no message from it, a busy loop
// blocked its timer, and the CPU limit or the host kill timer ended it.
// `ulimit -t` sets the soft and the hard limit to one value, so Linux sends
// SIGKILL, not SIGXCPU. A SIGKILL that the run sent itself (an abort) is no limit.
const stoppedOutcome = (ending: Ending, limitSeconds: number, aborted: boolean): RunnerError | undefined => {
  const past = `the program ran past the time limit of ${limitSeconds} s and was stopped`
  if (ending.kind === 'timeout') return { t: 'error', message: past, logs: [] }
  if (ending.kind === 'exit' && !aborted && (ending.signal === 'SIGXCPU' || ending.signal === 'SIGKILL'))
    return { t: 'error', message: `${past} (CPU limit)`, logs: [] }
  return undefined
}

const endingText = (ending: Ending, node: string): string =>
  ending.kind === 'failed'
    ? `could not start the sandbox with Node ${node}: ${ending.error.message}`
    : ending.kind === 'exit'
      ? `the sandbox ended with ${ending.signal ?? `exit code ${ending.code}`}`
      : ''

const execute = async (ctx: RunContext, code: string, approved: ReadonlySet<string>): Promise<RunResult> => {
  const { config, downstream, kept } = ctx
  const limitSeconds = config.sandbox.timeoutSeconds
  const timeoutMs = limitSeconds * 1000
  const startedAt = performance.now()
  const xdir = await makeExchangeDir()

  const records = new Map<number, CallRecord>()
  // Every call the program made, by id: one with no record at the end did not finish.
  const started = new Map<number, string>()
  const unapproved = new Set<string>()
  const recalled: { ref: number; ageMs: number }[] = []
  let recalls = 0
  const answers: Promise<void>[] = []
  const limit = limiter(MAX_PARALLEL_CALLS)
  // Cancels the nested calls still running after the settle wait.
  const cancel = new AbortController()
  // Set when the sandbox ends: a call still in the queue has no reader, so it does not start.
  let ended = false
  // Set when the wait for running calls ends: a late reply has no reader and its folder is gone.
  let closed = false
  let outcome: RunnerDone | RunnerError | undefined
  let stderr = ''
  let ending: Ending | undefined
  // Set by the run's own kill (an abort or a lost reply), so the ending is not read as the time limit.
  let killedByUs = false
  let kill = () => {}

  // A reply that cannot be written leaves the program waiting until the limit:
  // stop the sandbox at once. The catch also keeps the rejection handled.
  const answer = (task: Promise<void>, id: number): void => {
    answers.push(
      task.catch(err => {
        stderr += `\ncould not answer message ${id} of the program: ${errorText(err)}`
        kill()
      }),
    )
  }

  const reply = async (id: number, r: Reply | string): Promise<void> => {
    if (closed) return
    await fs.promises.writeFile(path.join(xdir, `r${id}.json`), typeof r === 'string' ? r : JSON.stringify(r))
  }

  const callTool = async (tool: string, args: Record<string, unknown>): Promise<Reply> => {
    const target = isCallable(tool, SERVER_NAME) ? splitToolName(tool) : undefined
    if (target === undefined)
      return { ok: false, error: `only MCP tools (mcp__<server>__<tool>) can be called, not "${tool}"` }
    const check = checkCall(config.policy, approved, tool)
    if (!check.ok) {
      if (check.needsRule) unapproved.add(tool)
      return { ok: false, error: check.error }
    }
    const client = downstream.clients.get(target.server as ServerKey)
    if (client === undefined) return { ok: false, error: `no MCP server "${target.server}" is connected` }
    try {
      const r = await client.callTool({ name: target.name, arguments: args }, undefined, {
        timeout: timeoutMs,
        signal: cancel.signal,
      })
      return mcpReply({
        content: Array.isArray(r.content) ? r.content : [],
        isError: r.isError === true,
        structuredContent: r.structuredContent,
      })
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  }

  const answerCall = async (id: number, tool: string, args: Record<string, unknown>): Promise<void> => {
    if (ended) return
    const r = await callTool(tool, args)
    if (closed) return
    await reply(id, r)
    // A repeat is a call equal to an earlier one that worked. A failed call is
    // not kept: a new call is the only way to retry it.
    const key = callKey(tool, args)
    const repeatOf = kept.seen.get(key)
    const json = r.ok ? (JSON.stringify(r.value) ?? 'null') : ''
    const ref = r.ok ? keep(kept, json, Date.now()) : undefined
    if (r.ok && repeatOf === undefined && kept.seen.size < MAX_SEEN) kept.seen.set(key, ref ?? 0)
    if (r.ok) learnShape(ctx.shapes, tool, r.value)
    records.set(id, {
      ref,
      tool,
      status: r.ok ? 'ok' : 'failed',
      chars: json.length,
      shape: r.ok ? shapeOf(r.value) : undefined,
      repeatOf,
    })
  }

  // recall(n): a result this session kept, with no new call and no new check:
  // the policy allowed it when the call ran.
  const answerRecall = async (id: number, ref: number): Promise<void> => {
    recalls++
    const found = kept.results.get(ref)
    await reply(id, recallReply(kept, ref))
    if (found !== undefined) recalled.push({ ref, ageMs: Date.now() - found.at })
  }

  const answerLocal = async (id: number, op: () => Promise<Reply>): Promise<void> =>
    reply(id, await op().catch((err): Reply => ({ ok: false, error: errorText(err) })))

  const dispatch = (m: RunnerMessage): void => {
    switch (m.t) {
      case 'call':
        started.set(m.id, m.tool)
        answer(
          limit(() => answerCall(m.id, m.tool, m.args)),
          m.id,
        )
        break
      case 'recall':
        answer(answerRecall(m.id, m.ref), m.id)
        break
      case 'save':
        answer(
          answerLocal(m.id, () => saveFile(ctx.filesDir, m.name, m.data)),
          m.id,
        )
        break
      case 'read':
        answer(
          answerLocal(m.id, () => readFile(ctx.filesDir, m.path)),
          m.id,
        )
        break
      case 'resources':
      case 'resource':
        answer(
          answerLocal(m.id, async () => NO_RESOURCES),
          m.id,
        )
        break
      case 'done':
      case 'error':
        outcome = m
        break
      default:
        m satisfies never // a new kind needs a case here
    }
  }

  try {
    const sandbox = launch({
      node: config.sandbox.node,
      runner: RUNNER,
      xdir,
      timeoutMs,
      input: JSON.stringify({ code, timeoutMs, lib: {} }),
    })
    kill = () => {
      killedByUs = true
      sandbox.child.kill('SIGKILL')
    }
    ctx.signal.addEventListener('abort', kill, { once: true })
    if (ctx.signal.aborted) kill()
    let buffer = ''
    sandbox.child.stdout.setEncoding('utf8')
    sandbox.child.stdout.on('data', (piece: string) => {
      const taken = takeMessages(buffer + piece)
      buffer = taken.rest
      for (const m of taken.messages) dispatch(m)
    })
    sandbox.child.stderr.setEncoding('utf8')
    sandbox.child.stderr.on('data', (piece: string) => (stderr = (stderr + piece).slice(-MAX_STDERR_CHARS)))
    ending = await sandbox.ended
    ctx.signal.removeEventListener('abort', kill)
    ended = true
    let timer: NodeJS.Timeout | undefined
    await Promise.race([Promise.allSettled(answers), new Promise(r => (timer = setTimeout(r, SETTLE_MS)))])
    clearTimeout(timer)
  } catch (err) {
    stderr += `\n${errorText(err)}`
  } finally {
    ended = true
    closed = true
    cancel.abort()
    await removeExchangeDir(xdir).catch(err => ctx.log(`cannot remove ${xdir}: ${errorText(err)}`))
  }

  // Trust the runner's own message: a run that ends at the limit can still have sent its result.
  if (outcome === undefined && ending !== undefined) {
    outcome = stoppedOutcome(ending, limitSeconds, killedByUs)
    if (outcome === undefined) stderr = `${stderr}\n${endingText(ending, config.sandbox.node)}`
  }
  for (const [id, tool] of started) if (!records.has(id)) records.set(id, { tool, status: 'unfinished', chars: 0 })
  const calls = [...records].sort((a, b) => a[0] - b[0]).map(([, r]) => r)

  // A result too large to show is kept whole, so the next program can page it.
  const returned = outcome?.t === 'done' ? outcome.value : undefined
  const isCut = returned !== undefined && shownText(returned).length > MAX_RESULT_CHARS
  const wholeRef = isCut ? keep(kept, returned, Date.now()) : undefined
  const text = formatOutcome(outcome, calls.length, stderr, MAX_RESULT_CHARS, { calls, recalls, recalled, wholeRef })
  const note = approvalNote([...unapproved], ctx.canAsk())
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1)
  ctx.log(`run_code: ${calls.length} calls, ${seconds} s, ${outcome?.t ?? (ending?.kind || 'no ending')}`)
  return { text: note === '' ? text : `${text}\n\n${note}`, isError: outcome?.t !== 'done' }
}
