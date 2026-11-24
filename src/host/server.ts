// The MCP server that a client starts: it lists the tools in SERVED and
// answers their calls. The schemas come from TOOLS as JSON Schema, so the
// handlers are set on the SDK's underlying Server: McpServer.registerTool
// takes only Zod schemas.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { searchResult, shownShapes, shownStates, type ServerState } from '../core/catalog.ts'
import { policyOf, type Config } from '../core/config.ts'
import { appPath } from '../core/paths.ts'
import {
  askText,
  declinedNote,
  keptPolicyNote,
  loosenText,
  onlyTightens,
  policyChange,
  samePolicy,
  stalePolicyNote,
  type Policy,
} from '../core/policy.ts'
import { errorText, newKept, serverInstructions, type Written } from '../core/protocol.ts'
import { SEARCH_LIMIT, SERVED, parseInput, registration, type ServedName } from '../core/tools.ts'
import type { Downstream } from './downstream.ts'
import { runCode, type Approval, type RunContext } from './run.ts'
import { SHAPES_WAIT_MS, loadShapes, removeOrphans, schemaHash, within } from './shapes.ts'

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], isError })

// A person can take a while to read the program in the prompt.
const ASK_TIMEOUT_MS = 10 * 60_000

type Extra = { readonly signal: AbortSignal; readonly requestId: string | number }

type Context = {
  readonly downstream: Downstream
  /** The shapes that `search_tools` shows now: the session's, and the stored ones that match their tool's schema. */
  readonly shapes: (states: readonly ServerState[]) => Promise<ReadonlyMap<string, string>>
  readonly canAsk: () => boolean
  readonly run: (code: string, extra: Extra) => Promise<CallToolResult>
  readonly extra: Extra
}

type Handler = (args: object, ctx: Context) => Promise<CallToolResult>

const HANDLERS: Record<ServedName, Handler> = {
  search_tools: async (args, { downstream, shapes, canAsk }) => {
    const { query, limit: asked } = parseInput('search_tools', args)
    const limit = Math.min(100, Math.max(1, asked || SEARCH_LIMIT))
    await downstream.settled
    await downstream.retry()
    // A server that is asleep shows its cached tools. Only this display reads them.
    const states = shownStates(downstream.states())
    return text(searchResult(states, query, limit, await shapes(states), canAsk()))
  },
  run_code: async (args, { run, extra }) => run(parseInput('run_code', args).code, extra),
}

const isServed = (name: string): name is ServedName => (SERVED as readonly string[]).includes(name)

export type Served = {
  readonly server: McpServer
  /** Kills the sandbox of each run in flight and waits until its exchange dir is gone. */
  readonly stopRuns: () => Promise<void>
}

export const createServer = (
  downstream: Downstream,
  config: Config,
  configFile: string,
  version: string,
  log: (line: string) => void,
  /** The session root of the built-in Workspace, when it is bound. */
  workspaceRoot?: string,
  /** The names of the tasks of its root entry, for the approval prompt. */
  workspaceTasks?: readonly string[],
): Served => {
  const mcp = new McpServer(
    { name: 'toolscript-mcp', version },
    { capabilities: { tools: {} }, instructions: serverInstructions([...config.servers.keys()], config.bridges) },
  )
  // One server process serves one client session: its kept results and its saveFile folder.
  const kept = newKept()
  const written: Written = new Map()
  const untrustedFiles = new Set<string>()
  const home = os.homedir()
  const shapes = new Map<string, string>()
  // The shapes of earlier sessions load in the background: tools/list does not wait for them. A search waits.
  const stored = loadShapes(home, log)
  void removeOrphans(home)
  // A read that sticks costs a search at most SHAPES_WAIT_MS, and the search then shows no stored shape.
  const shownNow: Context['shapes'] = async states =>
    shownShapes(states, shapes, await within(stored, SHAPES_WAIT_MS, {}), schemaHash)
  const filesDir = path.resolve(appPath(home, 'files', randomUUID()))
  const stopping = new AbortController()
  const runs = new Set<Promise<unknown>>()

  const canAsk = () => mcp.server.getClientCapabilities()?.elicitation?.form !== undefined
  // 'unanswered': the person dismissed the prompt, or it failed, timed out or was cancelled.
  const prompt = async (extra: Extra, message: string): Promise<Approval | 'unanswered'> => {
    if (!canAsk()) return 'unsupported'
    try {
      const r = await mcp.server.elicitInput(
        { mode: 'form', message, requestedSchema: { type: 'object', properties: {} } },
        { signal: extra.signal, timeout: ASK_TIMEOUT_MS, relatedRequestId: extra.requestId },
      )
      return r.action === 'accept' ? 'accept' : r.action === 'decline' ? 'decline' : 'unanswered'
    } catch (err) {
      log(`the approval prompt failed: ${errorText(err)}`)
      return 'unanswered'
    }
  }
  const elicit = async (extra: Extra, message: string): Promise<Approval> => {
    const answer = await prompt(extra, message)
    return answer === 'unanswered' ? 'decline' : answer
  }

  // The policy is read again at each run, so an edit needs no restart. A
  // program can write the config through a tool that the policy allows, so a
  // looser policy applies only when the person approves it, or at a restart.
  // A config that does not read keeps the policy in force, and the result says so.
  // A policy that the person declined is not asked again until the file holds another one.
  let policy = config.policy
  let declined: Policy | undefined
  const reload = async (extra: Extra): Promise<{ policy: Policy; note: string }> => {
    const read = await fs.promises.readFile(configFile, 'utf8').then(policyOf, err => ({
      ok: false as const,
      errors: [`cannot read the config: ${errorText(err)}`],
    }))
    if (!read.ok) {
      log(`the policy was not reloaded: ${read.errors.join('; ')}`)
      return { policy, note: stalePolicyNote(read.errors) }
    }
    if (declined !== undefined && samePolicy(declined, read.policy)) return { policy, note: declinedNote(configFile) }
    declined = undefined
    const change = policyChange(policy, read.policy)
    if (change === '') return { policy, note: '' }
    const note = policyChange(policy, read.policy, 'note')
    if (!onlyTightens(policy, read.policy, config.guards)) {
      // The prompt names every changed rule uncut. The log keeps the short form, and the note no text of the file.
      const answer = await prompt(
        extra,
        loosenText(configFile, policyChange(policy, read.policy, 'prompt'), read.policy),
      )
      if (answer !== 'accept') {
        // Only an explicit decline stops the next prompts. A prompt with no answer is asked again at the next run.
        if (answer === 'decline') declined = read.policy
        const why =
          answer === 'decline'
            ? 'the person declined it'
            : answer === 'unanswered'
              ? 'the prompt got no answer'
              : 'restart toolscript-mcp to apply it'
        log(
          `the policy in ${configFile} was not applied, because it can let a tool run with less approval (${change}): ${why}`,
        )
        return { policy, note: keptPolicyNote(configFile, note, answer === 'unsupported' ? answer : 'decline') }
      }
    }
    policy = read.policy
    log(`the policy changed: ${change}`)
    return { policy, note: `The policy changed: ${note}.` }
  }
  // One reload at a time: two runs never ask at once, and a run sees the answer to the prompt before it.
  let reloading: Promise<unknown> = Promise.resolve()
  const freshPolicy = (extra: Extra): Promise<{ policy: Policy; note: string }> => {
    const fresh = reloading.then(() => reload(extra))
    reloading = fresh.catch(() => {})
    return fresh
  }

  const run = async (code: string, extra: Extra): Promise<CallToolResult> => {
    const fresh = await freshPolicy(extra)
    const ctx: RunContext = {
      downstream,
      config: { ...config, policy: fresh.policy },
      kept,
      written,
      untrustedFiles,
      shapes,
      filesDir,
      policyNote: fresh.note,
      ask: (needed, code) =>
        elicit(
          extra,
          askText(needed, code, config.guards, {
            ...(workspaceRoot !== undefined && { root: workspaceRoot }),
            ...(workspaceTasks !== undefined && { tasks: workspaceTasks }),
          }),
        ),
      canAsk,
      signal: AbortSignal.any([extra.signal, stopping.signal]),
      log,
      home,
      ...(workspaceRoot !== undefined && { workspaceRoot }),
    }
    const running = runCode(ctx, code)
    runs.add(running)
    try {
      const r = await running
      const result = text(r.text, r.isError)
      return { ...result, content: [...result.content, ...r.images.map(i => ({ type: 'image' as const, ...i }))] }
    } finally {
      runs.delete(running)
    }
  }

  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: SERVED.map(registration) }))
  mcp.server.setRequestHandler(CallToolRequestSchema, (req, extra) => {
    const { name, arguments: args = {} } = req.params
    return isServed(name)
      ? HANDLERS[name](args, { downstream, shapes: shownNow, canAsk, run, extra })
      : text(`Unknown tool: ${name}`, true)
  })
  return {
    server: mcp,
    stopRuns: async () => {
      stopping.abort()
      await Promise.allSettled(runs)
    },
  }
}
