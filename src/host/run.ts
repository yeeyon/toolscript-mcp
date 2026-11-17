// run_code: checks a program before it runs, asks the person for the tools
// that no policy rule allows, runs the program in the sandbox and answers its
// nested calls through the downstream clients. The exchange dir goes in every case.

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  argSpec,
  catalogOf,
  interactiveTools,
  learnShape,
  listedNames,
  notConnected,
  type DownstreamTool,
  type ServerState,
} from '../core/catalog.ts'
import type { Config, ServerKey } from '../core/config.ts'
import {
  approvalNote,
  checkCall,
  deniedReport,
  interactiveNote,
  planRun,
  refusedReport,
  type Asks,
  type Policy,
} from '../core/policy.ts'
import {
  MAX_FILE_SIZE,
  MAX_IMAGE_BYTES,
  MAX_SEEN,
  MAX_SHOWN_IMAGES,
  MAX_SHOWN_IMAGE_BYTES,
  SHOWN_IMAGE_TYPES,
  callKey,
  checkCalls,
  errorText,
  fileNameError,
  fileText,
  formatOutcome,
  hiddenImagesNote,
  holdsImage,
  isCallable,
  isEmpty,
  keep,
  limiter,
  literalCalls,
  mcpReply,
  notListedText,
  problemReport,
  recallReply,
  recordWritten,
  returnedImages,
  runFiles,
  shapeOf,
  shownText,
  splitToolName,
  takeMessages,
  type CallRecord,
  type HiddenWhy,
  type Kept,
  type PendingFile,
  type Reply,
  type RunnerDone,
  type RunnerError,
  type RunnerMessage,
  type Written,
  type WrittenFile,
} from '../core/protocol.ts'
import {
  callDecision,
  runLine,
  runRecord,
  type CallDecision,
  type CallError,
  type CallLog,
  type RunEnding,
} from '../core/runlog.ts'
import { SERVER_NAME } from '../core/tools.ts'
import type { Downstream } from './downstream.ts'
import { RUNNER, launch, makeExchangeDir, removeExchangeDir, type Ending } from './launch.ts'
import { appendRunLog } from './runlog.ts'

const MAX_RESULT_CHARS = 20_000
// Nested calls of one run that wait for a reply at one time: a program that
// maps over hundreds of ids must not hit a server's rate limit at once.
const MAX_PARALLEL_CALLS = 8
// How long a run waits for calls still running after the sandbox ends. Then
// they are cancelled, so a call that hangs does not hold the result.
const SETTLE_MS = 1000
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
  /** The attachment files that the calls of this session wrote. */
  readonly written: Written
  /**
   * The names, in lower case, of the files in `filesDir` that can hold
   * untrusted content: the attachments of an untrusted result, and each file
   * that saveFile wrote after its run read untrusted content.
   */
  readonly untrustedFiles: Set<string>
  /** The shape of each tool's result, by tool name, for search_tools. */
  readonly shapes: Map<string, string>
  /** The folder of saveFile in this session, as an absolute path. */
  readonly filesDir: string
  /** Asks the person to approve the tools for one run. */
  readonly ask: (needed: Asks, code: string) => Promise<Approval>
  /** True when the client can show an approval prompt. */
  readonly canAsk: () => boolean
  /** Aborts when the server shuts down or the client cancels the call: the sandbox is killed. */
  readonly signal: AbortSignal
  readonly log: (line: string) => void
  /** HOME, where the run log goes. */
  readonly home: string
}

/** An MCP image block: `data` is base64. */
export type ShownImage = { readonly data: string; readonly mimeType: string }

/** `images`: the image attachments that the program returned, read from their files. */
export type RunResult = { readonly text: string; readonly isError: boolean; readonly images: readonly ShownImage[] }

/** A result with what the run log needs to know about it. */
type Ran = { readonly result: RunResult; readonly ending: RunEnding; readonly calls: readonly CallLog[] }

/** `known`: the tool names of the catalog before the run. A server that closes during the run has none at its end. */
type Attempt = Ran & { readonly known: ReadonlySet<string> }

const refused = (text: string, known: ReadonlySet<string>, calls: readonly CallLog[]): Attempt => ({
  result: { text, isError: true, images: [] },
  ending: 'refused',
  calls,
  known,
})

/** A call that a refused program names. It never started; `error` says why the policy or its server stops it. */
const notMade = (policy: Policy, states: readonly ServerState[], tool: string): CallLog => {
  const server = splitToolName(tool)?.server
  const names = server === undefined ? undefined : listedNames(states, server)
  const checked = callDecision(policy, new Set(), tool, interactiveTools(states))
  const decision = checked !== 'denied' && names !== undefined && !names.includes(tool) ? 'invalid' : checked
  return { tool, decision, ms: 0, ok: false, ...(decision === 'allow' ? {} : { error: decision }) }
}

/** The servers of `calls`, each one time. */
const serversOf = (calls: readonly { readonly tool: string }[]): ServerKey[] =>
  [...new Set(calls.flatMap(c => splitToolName(c.tool)?.server ?? []))] as ServerKey[]

/** One run_code call, and one line in the run log unless the config turns it off. */
export const runCode = async (ctx: RunContext, code: string): Promise<RunResult> => {
  const startedAt = performance.now()
  const { result, ending, calls, known: before } = await attempt(ctx, code)
  if (ctx.config.log) {
    const known = new Set([...before, ...catalogOf(ctx.downstream.states()).map(t => t.name)])
    const record = runRecord({
      now: new Date(),
      id: randomUUID(),
      ms: performance.now() - startedAt,
      ending,
      chars: result.text.length,
      calls,
      known,
    })
    await appendRunLog(ctx.home, runLine(record), ctx.log)
  }
  return result
}

/**
 * The run itself. The check of names and the policy come first: a program
 * with a wrong name or a denied tool never starts a sandbox, and the approval
 * prompt comes before the run's timer starts.
 */
const attempt = async (ctx: RunContext, code: string): Promise<Attempt> => {
  if (code.trim() === '') return refused('Error: code is empty.', new Set(), [])
  await ctx.downstream.settled
  const named = literalCalls(code)
  const literal = named.filter(c => isCallable(c.tool, SERVER_NAME))
  const { policy } = ctx.config
  const refuse = (text: string) => {
    const states = ctx.downstream.states()
    const known = new Set(catalogOf(states).map(t => t.name))
    return refused(
      text,
      known,
      named.map(c => notMade(policy, states, c.tool)),
    )
  }
  // A denied name refuses the program before any traffic to its server.
  const denied = planRun(policy, literal, new Set())
  if (denied.kind === 'refused') return refuse(deniedReport(denied.denied))
  // A failed server that the program names connects again before the check.
  await ctx.downstream.retry(serversOf(literal), ctx.signal)
  // A connected server can add a tool with no notification: a name that its list lacks lists it again.
  const missed = literal.filter(c => {
    const names = listedNames(ctx.downstream.states(), splitToolName(c.tool)?.server ?? '')
    return names !== undefined && !names.includes(c.tool)
  })
  await Promise.all(serversOf(missed).map(key => ctx.downstream.relist(key, ctx.signal)))
  const states = ctx.downstream.states()
  const specs = new Map(catalogOf(states).map(t => [t.name, argSpec(t.inputSchema)]))
  const known = new Set(specs.keys())
  const down = new Map<string, string>()
  for (const s of states) {
    const reason = notConnected(s)
    if (reason !== undefined) down.set(s.key, reason)
  }
  const problems = checkCalls(literal, known, tool => specs.get(tool), {}, down)
  if (problems.length > 0) return refuse(problemReport(problems))

  const plan = planRun(policy, literal, interactiveTools(states))
  if (plan.kind === 'refused') return refuse(deniedReport(plan.denied))
  if (plan.ask.length + plan.interactive.length > 0) {
    const answer = ctx.canAsk() ? await ctx.ask(plan, code) : 'unsupported'
    if (answer !== 'accept') return refuse(refusedReport(plan, answer))
  }
  if (ctx.signal.aborted) return refuse('Error: the server is shutting down. The program did not run.')
  const approved = new Set([...plan.ask, ...plan.interactive])
  return { ...(await execute(ctx, code, approved, new Set(literal.map(c => c.tool)))), known }
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
  if (text.length > MAX_FILE_SIZE)
    return { ok: false, error: `saveFile: ${text.length} characters is more than ${MAX_FILE_SIZE}; save less data` }
  // Only the person can read the saved data: a program can save what its calls returned.
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, name)
  const old = await fs.promises.lstat(file).catch(() => undefined)
  if (old !== undefined && !old.isFile()) return { ok: false, error: `saveFile: ${name} exists and is not a file` }
  await fs.promises.writeFile(file, text, { mode: 0o600 })
  return { ok: true, value: file }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

// The attachments of a tool result, as saveFile writes: only the person can
// read them. The program gets all of them or an error, so a failed write
// removes the files of the result that it wrote before, and the file that it
// was writing. EEXIST: that file was there before, so it stays.
const writeAttachments = async (dir: string, files: readonly PendingFile[], written: Written): Promise<void> => {
  if (files.length === 0) return
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const done: { file: string; record: WrittenFile }[] = []
  try {
    for (const { file, data, mimeType } of files) {
      const bytes = Buffer.from(data, 'base64')
      await fs.promises.writeFile(file, bytes, { mode: 0o600, flag: 'wx' }).catch(async (err: unknown) => {
        if ((err as { code?: unknown }).code !== 'EEXIST') await fs.promises.rm(file, { force: true }).catch(() => {})
        throw err
      })
      done.push({ file, record: { mimeType, bytes: bytes.length, sha256: sha256(bytes) } })
    }
  } catch (err) {
    await Promise.all(done.map(({ file }) => fs.promises.rm(file, { force: true }).catch(() => {})))
    throw err
  }
  for (const { file, record } of done) recordWritten(written, file, record)
}

/**
 * The image attachments that a program returned, read from their files, up
 * to the caps. Only a file that a call of this session wrote shows, with the
 * type of its block, while it holds the bytes that the call wrote. Any other
 * path is never looked up on the disk.
 */
const showImages = async (
  written: Written,
  returned: { files: readonly string[]; unsearched: boolean },
): Promise<{ images: ShownImage[]; note: string }> => {
  const images: ShownImage[] = []
  const hidden: { file: string; why: HiddenWhy }[] = []
  let total = 0
  const load = async (file: string): Promise<HiddenWhy | ShownImage> => {
    const record = written.get(file)
    if (record === undefined) return 'not-written'
    if (!SHOWN_IMAGE_TYPES.has(record.mimeType)) return 'type'
    if (record.bytes > MAX_IMAGE_BYTES) return 'size'
    if (images.length >= MAX_SHOWN_IMAGES) return 'count'
    if (total + record.bytes > MAX_SHOWN_IMAGE_BYTES) return 'total'
    const stat = await fs.promises.lstat(file).catch(() => undefined)
    if (stat === undefined || !stat.isFile()) return 'unreadable'
    if (stat.size !== record.bytes) return 'changed'
    const bytes = await fs.promises.readFile(file).catch(() => undefined)
    if (bytes === undefined) return 'unreadable'
    // saveFile can write over the file, also between the stat and the read.
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) return 'changed'
    if (!holdsImage(record.mimeType, bytes)) return 'not-image'
    total += bytes.length
    return { data: bytes.toString('base64'), mimeType: record.mimeType }
  }
  for (const file of returned.files) {
    const loaded = await load(file)
    if (typeof loaded === 'string') hidden.push({ file, why: loaded })
    else images.push(loaded)
  }
  return { images, note: hiddenImagesNote(hidden, returned.unsearched) }
}

// readFile reads only a file in the session's saveFile folder: a program can
// send what it reads to an MCP tool. The real paths stop a link out of the folder.
// `untrusted`: the file is one of `untrustedFiles`.
const readFile = async (
  dir: string,
  asked: string,
  untrustedFiles: ReadonlySet<string>,
): Promise<{ reply: Reply; untrusted: boolean }> => {
  const fail = (error: string) => ({ reply: { ok: false, error } as const, untrusted: false })
  const refusal = fail(`readFile: ${asked} is not a file from saveFile in this session`)
  const [real, realDir] = await Promise.all([
    fs.promises.realpath(path.resolve(dir, asked)).catch(() => undefined),
    fs.promises.realpath(dir).catch(() => undefined),
  ])
  if (real === undefined || realDir === undefined || !isInside(real, realDir)) return refusal
  const stat = await fs.promises.stat(real)
  if (!stat.isFile()) return refusal
  if (stat.size > MAX_READ_BYTES) return fail(`readFile: ${asked} is ${stat.size} bytes, more than readFile loads`)
  return {
    reply: { ok: true, value: await fs.promises.readFile(real, 'utf8') },
    untrusted: untrustedFiles.has(path.relative(realDir, real).toLowerCase()),
  }
}

const NO_RESOURCES: Reply = { ok: false, error: 'resources() and readResource() are not available in toolscript-mcp' }

// The runner reports its own time limit. With no message from it, a busy loop
// blocked its timer, and the CPU limit or the host kill timer ended it.
// `ulimit -t` sets the soft and the hard limit to one value, so Linux sends
// SIGKILL, not SIGXCPU. A SIGKILL that the run sent itself (an abort) is no limit.
// The CPU time of a run cannot reach the limit long before its wall time does,
// so an earlier signal came from outside (the OOM killer, kill -9).
const stoppedOutcome = (
  ending: Ending,
  limitSeconds: number,
  elapsedMs: number,
  aborted: boolean,
): RunnerError | undefined => {
  const past = `the program ran past the time limit of ${limitSeconds} s and was stopped`
  if (ending.kind === 'timeout') return { t: 'error', message: past, logs: [], timedOut: true }
  const nearLimit = elapsedMs >= CPU_LIMIT_SHARE * limitSeconds * 1000
  if (ending.kind === 'exit' && !aborted && nearLimit && (ending.signal === 'SIGXCPU' || ending.signal === 'SIGKILL'))
    return { t: 'error', message: `${past} (CPU limit)`, logs: [], timedOut: true }
  return undefined
}

const CPU_LIMIT_SHARE = 0.9

const endingText = (ending: Ending, node: string): string =>
  ending.kind === 'failed'
    ? `could not start the sandbox with Node ${node}: ${ending.error.message}`
    : ending.kind === 'exit'
      ? `the sandbox ended with ${ending.signal ?? `exit code ${ending.code}`}`
      : ''

/** `written`: the tool names that the program writes as strings. */
const execute = async (
  ctx: RunContext,
  code: string,
  approved: ReadonlySet<string>,
  written: ReadonlySet<string>,
): Promise<Ran> => {
  const { config, downstream, kept } = ctx
  const limitSeconds = config.sandbox.timeoutSeconds
  const timeoutMs = limitSeconds * 1000
  const callSeconds = config.sandbox.callTimeoutSeconds
  const startedAt = performance.now()
  const xdir = await makeExchangeDir()

  const records = new Map<number, CallRecord>()
  const audits = new Map<number, CallLog>()
  // Every call the program made, by id: one with no record at the end did not finish.
  const started = new Map<number, string>()
  const unapproved = new Set<string>()
  const needPerson = new Set<string>()
  // The decision of the last check of each call, by id: the run log records what let the call run or refused it.
  const decided = new Map<number, CallDecision>()
  // A server that connects again during the run lists its tools anew, maybe with a new mark.
  const interactiveNow = () => interactiveTools(downstream.states())
  const recalled: { ref: number; ageMs: number }[] = []
  let recalls = 0
  // Set before the program gets untrusted content, so a saveFile after it marks its file.
  let untrusted = false
  const answers: Promise<void>[] = []
  const limit = limiter(MAX_PARALLEL_CALLS)
  const fileFor = runFiles(extension => path.join(ctx.filesDir, `${randomUUID()}${extension}`))
  // Cancels the nested calls still running after the settle wait.
  const cancel = new AbortController()
  // Set when the sandbox ends: a call still in the queue has no reader, so it does not start.
  let ended = false
  // Set when the wait for running calls ends: a late reply has no reader and its folder is gone.
  let closed = false
  let outcome: RunnerDone | RunnerError | undefined
  let stderr = ''
  let ending: Ending | undefined
  // How long the sandbox ran, from its launch to its end.
  let ranMs = 0
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

  // `error` is the short code for the run log: a message from a server can hold data.
  const callTool = async (
    id: number,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Reply & { code?: CallError; untrusted?: true }> => {
    const target = isCallable(tool, SERVER_NAME) ? splitToolName(tool) : undefined
    if (target === undefined) {
      decided.set(id, 'invalid')
      return {
        ok: false,
        error: `only MCP tools (mcp__<server>__<tool>) can be called, not "${tool}"`,
        code: 'invalid',
      }
    }
    const check = (interactive: ReadonlySet<string>): (Reply & { code: CallError }) | undefined => {
      const decision = callDecision(config.policy, approved, tool, interactive)
      decided.set(id, decision)
      const result = checkCall(config.policy, approved, tool, interactive)
      if (result.ok) return undefined
      if (result.needs === 'rule') unapproved.add(tool)
      if (result.needs === 'person') needPerson.add(tool)
      return { ok: false, error: result.error, code: decision }
    }
    // A denied name sends nothing to its server, not even a list for a miss.
    const denied = callDecision(config.policy, approved, tool, new Set()) === 'denied' ? check(new Set()) : undefined
    if (denied !== undefined) return denied
    const server = target.server as ServerKey
    // The link comes with the list after the last change of the server, so the check sees each new mark.
    const listed = (tools: readonly DownstreamTool[]) =>
      listedNames([{ key: server, status: 'connected', tools }], server)!
    let link = await downstream.client(server, cancel.signal)
    // The server can have added the name with no notification, so a miss lists its tools again.
    if (link.ok && !listed(link.tools).includes(tool)) {
      await downstream.relist(server, cancel.signal)
      link = await downstream.client(server, cancel.signal)
    }
    if (!link.ok) {
      decided.set(id, callDecision(config.policy, approved, tool, interactiveNow()))
      return { ok: false, error: link.reason, code: 'no-server' }
    }
    // A name that the server does not list can never run: say so before the policy offers a rule for it.
    const names = listed(link.tools)
    if (!names.includes(tool)) {
      decided.set(id, 'invalid')
      return { ok: false, error: notListedText(tool, server, names), code: 'invalid' }
    }
    const refused = check(interactiveTools([{ key: server, status: 'connected', tools: link.tools }]))
    if (refused !== undefined) return refused
    // A reconnect can outlast the sandbox: then the call has no reader and does not start.
    if (ended) return { ok: false, error: 'the program ended before the call started', code: 'cancelled' }
    // The SDK keeps its abort listener after the answer and then sends a
    // cancel for a finished call: one signal per call, unlinked at the end.
    const own = new AbortController()
    const stop = () => own.abort()
    cancel.signal.addEventListener('abort', stop, { once: true })
    try {
      // At the timeout the SDK sends notifications/cancelled, so the server can stop the work.
      const r = await link.client.callTool({ name: target.name, arguments: args }, undefined, {
        timeout: callSeconds * 1000,
        signal: own.signal,
      })
      const { reply, files, ...mark } = mcpReply(
        {
          content: Array.isArray(r.content) ? r.content : [],
          isError: r.isError === true,
          structuredContent: r.structuredContent,
        },
        fileFor,
      )
      if (!reply.ok) return { ...reply, code: 'tool-error', ...mark }
      // After untrusted content, the program can have sent it to this tool, and the tool can send it back.
      if (mark.untrusted === true || untrusted)
        for (const { file } of files) ctx.untrustedFiles.add(path.basename(file).toLowerCase())
      const unwritten = await writeAttachments(ctx.filesDir, files, ctx.written).then(
        () => undefined,
        (err: unknown) => `could not write an attachment of ${tool}: ${errorText(err)}`,
      )
      return unwritten === undefined ? { ...reply, ...mark } : { ok: false, error: unwritten, code: 'failed' }
    } catch (err) {
      // An abort at the end of the run is also a RequestTimeout to the SDK. The SDK's own timer puts the limit in
      // `data`. A server can send the same code for its own error (mcp-remote does, for a failed login): its text stays.
      if (
        !own.signal.aborted &&
        err instanceof McpError &&
        err.code === ErrorCode.RequestTimeout &&
        (err.data as { timeout?: unknown } | undefined)?.timeout === callSeconds * 1000
      )
        return {
          ok: false,
          error: `${tool} did not answer within the call limit of ${callSeconds} s and was cancelled`,
          code: 'timeout',
        }
      // A server can echo a token of its own in an error, as an HTTP error body.
      return { ok: false, error: link.hide(errorText(err)), code: own.signal.aborted ? 'cancelled' : 'failed' }
    } finally {
      cancel.signal.removeEventListener('abort', stop)
    }
  }

  const answerCall = async (id: number, tool: string, args: Record<string, unknown>): Promise<void> => {
    if (ended) return
    const began = performance.now()
    const { code: failure, untrusted: fromTool, ...r } = await callTool(id, tool, args)
    if (closed) return
    if (fromTool === true) untrusted = true
    // A call that returns after untrusted content can hold it: the program can have sent it to the tool.
    const tainted = untrusted
    audits.set(id, {
      tool,
      decision: decided.get(id)!,
      ms: performance.now() - began,
      ok: r.ok,
      ...(r.ok ? {} : { error: failure ?? 'failed' }),
    })
    await reply(id, r)
    // A repeat is a call equal to an earlier one that worked. A failed call is
    // not kept: a new call is the only way to retry it.
    const key = callKey(tool, args)
    const repeatOf = kept.seen.get(key)
    const json = r.ok ? (JSON.stringify(r.value) ?? 'null') : ''
    const ref = r.ok ? keep(kept, json, Date.now(), tainted) : undefined
    if (r.ok && repeatOf === undefined && kept.seen.size < MAX_SEEN) kept.seen.set(key, ref ?? 0)
    // The key names of untrusted content are its text: the footer and search_tools are outside the wrapper.
    if (r.ok && !tainted) learnShape(ctx.shapes, tool, r.value)
    records.set(id, {
      ref,
      tool,
      status: r.ok ? 'ok' : 'failed',
      chars: json.length,
      data: r.ok && !isEmpty(r.value),
      shape: r.ok ? shapeOf(r.value, !tainted) : undefined,
      repeatOf,
    })
  }

  // recall(n): a result this session kept, with no new call and no new check:
  // the policy allowed it when the call ran.
  const answerRecall = async (id: number, ref: number): Promise<void> => {
    recalls++
    const found = kept.results.get(ref)
    if (found?.untrusted === true) untrusted = true
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
          answerLocal(m.id, async () => {
            // Marked before the write: the program can read the file as soon as it is there.
            if (untrusted) ctx.untrustedFiles.add(m.name.toLowerCase())
            return saveFile(ctx.filesDir, m.name, m.data)
          }),
          m.id,
        )
        break
      case 'read':
        answer(
          answerLocal(m.id, async () => {
            const read = await readFile(ctx.filesDir, m.path, ctx.untrustedFiles)
            if (read.untrusted) untrusted = true
            return read.reply
          }),
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
    const launchedAt = performance.now()
    const sandbox = launch({
      node: config.sandbox.node,
      runner: RUNNER,
      xdir,
      timeoutMs,
      code,
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
    ranMs = performance.now() - launchedAt
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
    outcome = stoppedOutcome(ending, limitSeconds, ranMs, killedByUs)
    if (outcome === undefined) stderr = `${stderr}\n${endingText(ending, config.sandbox.node)}`
  }
  // A call can have its audit entry and no record: its reply was still being written at the end.
  for (const [id, tool] of started) {
    if (!records.has(id)) records.set(id, { tool, status: 'unfinished', chars: 0 })
    if (audits.has(id)) continue
    // A call still in the queue at the end was never checked.
    audits.set(id, {
      tool,
      decision: decided.get(id) ?? callDecision(config.policy, approved, tool, interactiveNow()),
      ms: 0,
      ok: false,
      error: 'unfinished',
    })
  }
  const calls = [...records].sort((a, b) => a[0] - b[0]).map(([, r]) => r)

  // A result too large to show is kept whole, so the next program can page it.
  const returned = outcome?.t === 'done' ? outcome.value : undefined
  const isCut = returned !== undefined && shownText(returned).length > MAX_RESULT_CHARS
  const wholeRef = isCut ? keep(kept, returned, Date.now(), untrusted) : undefined
  // Image tokens are paid only for the images that the program returns.
  const shown = await showImages(
    ctx.written,
    returned === undefined ? { files: [], unsearched: false } : returnedImages(returned),
  )
  const text = formatOutcome(
    outcome,
    calls.length,
    stderr,
    MAX_RESULT_CHARS,
    { calls, recalls, recalled, wholeRef },
    untrusted ? randomBytes(16).toString('hex') : undefined,
    shown.note,
  )
  const note = [
    approvalNote([...unapproved], ctx.canAsk()),
    interactiveNote([...needPerson], ctx.canAsk() ? { written } : 'cannot-ask'),
  ]
    .filter(n => n !== '')
    .join('\n\n')
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1)
  ctx.log(`run_code: ${calls.length} calls, ${seconds} s, ${outcome?.t ?? (ending?.kind || 'no ending')}`)
  const result = {
    text: note === '' ? text : `${text}\n\n${note}`,
    isError: outcome?.t !== 'done',
    images: shown.images,
  }
  return {
    result,
    ending: endingOf(outcome, ctx.signal.aborted),
    calls: [...audits].sort((a, b) => a[0] - b[0]).map(([, c]) => c),
  }
}

const endingOf = (outcome: RunnerDone | RunnerError | undefined, aborted: boolean): RunEnding => {
  if (outcome?.t === 'done') return 'done'
  if (aborted) return 'cancelled'
  if (outcome === undefined) return 'failed'
  return outcome.timedOut === true ? 'timeout' : 'error'
}
