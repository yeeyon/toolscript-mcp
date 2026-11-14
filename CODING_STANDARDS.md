# Coding standards

Rules for changing code, tests, model-facing text and docs in this repo. `[test: x]` marks a rule that a test
enforces; the others rely on discipline.

## Code
- Prettier formats code, JSON and YAML, not Markdown. Run it only through `scripts/format.sh`: the script holds the
  pinned version. Turn on the pre-commit hook one time per clone: `git config core.hooksPath .githooks`.
  `[test: code.check.mjs]`
- `src/core/` holds the pure helpers: `protocol.ts`, `hints.ts`, `functions.ts`, `paths.ts`, `tools.ts`,
  `config.ts`, `catalog.ts` and `policy.ts`. They import no Node module and no host package, so tests call them directly.
  `[test: tsc fails when a file in src/core uses a Node type: tsconfig.json sets types to an empty list]`
- `src/host/` holds the code that runs in Node. It builds with `tsconfig.host.json`, which adds the Node types.
- Parse the config only in `parseConfig` (`src/core/config.ts`). The host trusts a `Config`. Each error names the
  key it is about. `[test: server.test.ts]`
- stdout carries only MCP JSON-RPC. Log to stderr with `console.error`.
  `[test: code.check.mjs fails on a stdout write in src/host; tsc fails on console in src/core; server.e2e.mjs reads every stdout line]`
- A failed downstream server must not stop the others. `connectAll` catches each failure and keeps the server as
  failed. `[test: server.e2e.mjs]`
- A failed or closed server connects again on next use: a search, or a call of a program. All callers wait for one
  attempt, at most 3 attempts in 60 s, and none after `close`. `[test: downstream.test.ts, server.e2e.mjs]`
- The SDK HTTP client transport fires `onclose` only from `close()`. An HTTP link that a request finds unreachable,
  or whose session the server no longer knows (400 or 404), fails in `client.onerror`, before that request rejects.
  `[test: downstream.test.ts, describe http]`
- Every nested call has the time limit `sandbox.callTimeoutSeconds`, through the SDK's `timeout`, so the SDK sends
  `notifications/cancelled` when it ends. `[test: server.e2e.mjs, case run (l)]`
- `src/host/launch.ts` holds the sandbox layers of each OS in `SANDBOXES`. To add or change a layer, change it there
  and in the sandbox table of `README.md`. `[test: runner.integration.mjs checks each layer that LAYERS names]`
- Imports between files use the `.ts` extension, so Node can run the sources and `tsc` rewrites them. Use only
  syntax that Node can strip: no enums, no parameter properties, no namespaces. `[test: tsc, erasableSyntaxOnly]`
- Make each path into `.toolscript-mcp` with a helper from `src/core/paths.ts`: `hintsFolder`, `functionsFolder`
  or `appPath`. `[test: code.check.mjs]`
- Make a hint ref with `hintRef` or `bundledRef`, and read one with `refTarget` (all in `src/core/hints.ts`).
  `[test: code.check.mjs fails when a file outside hints.ts types out the bundled: prefix]`
- Add or change a tool in `TOOLS` in `src/core/tools.ts`: the registration, the full ids (`TOOL`) and the typed
  input (`parseInput`) come from there. The server lists only the tools in `SERVED`, and `src/host/server.ts` has
  one handler for each. `[test: code.check.mjs, and tsc fails when a served tool has no handler]`
- `runtime/runner.mjs` runs inside the sandbox: Node built-ins only, no dependencies. It needs Node 22.13+, because
  the launcher passes `--permission`.
  `[test: runner.integration.mjs loads the runner with Node alone, so an import of a package fails]`
- `MARK` exists in `runtime/runner.mjs`, `src/core/protocol.ts` and `tests/runner.integration.mjs`. Change all
  copies. `[test: runner.integration.mjs fails when a copy differs]`
- To add a kind of message that the runner sends, add it to `RunnerMessage` and `RUNNER_FIELDS` in
  `src/core/protocol.ts`. A host drops a message of a kind that is not in `RUNNER_FIELDS`.
  `[test: runner.integration.mjs fails when the runner sends a kind that is not in RUNNER_FIELDS]`
- Every nested call of a program goes through `checkCall` (`src/core/policy.ts`) at call time, also when the check
  before the run passed: a tool name built at run time is never asked. `[test: run.test.ts and server.e2e.mjs, case (e)]`
- Every run removes its exchange dir, also after a timeout, a kill or a shutdown.
  `[test: run.test.ts and server.e2e.mjs check the temp dir after the runs]`
- Never weaken a sandbox layer, the policy check, the guard of hint and function files or the approval of proposals
  to make a test pass. Each one is a safety rule.

## Tests and commits
- The checks:
  - `npm test`: the pure-core tests and `tests/run.test.ts`, which runs `run_code` with the real sandbox
    (`tests/*.test.ts`, `node:test`).
  - `npm run typecheck` and `npm run build`: `tsc` with the pinned TypeScript.
  - `npm run check`: `tests/docs.check.mjs` (the doc rules below) and `tests/code.check.mjs` (the code rules).
  - `node tests/runner.integration.mjs`: the real sandbox under Node, on Linux, macOS and Windows.
  - `node tests/server.e2e.mjs`: the built server over stdio, with the bench fake server and a probe server. Run
    `npm run build` first.
  - `sh scripts/format.sh --check .`: the format of code, JSON and YAML.
- CI (`.github/workflows/test.yml`) runs the sandbox test and the server test on Linux, macOS and Windows. Linux and macOS each have
  a network block (`unshare -rn` on Linux, `sandbox-exec` on macOS). `EXPECT_NETWORK_BLOCK` makes the test fail
  where neither works. On Windows the test checks that the network block is absent.
- Never put real MCP data, company names, ticket keys, user ids or tokens in tests, hints or docs: this repo is
  public. Use `fake`, `example.atlassian.net` and similar.

## Model-facing text
The text the model reads is part of the product: the input schemas in `TOOLS` in `src/core/tools.ts`,
`RUN_DESCRIPTION`, `SEARCH_DESCRIPTION` and `serverInstructions` in `src/core/protocol.ts`, the `search_tools`
result in `src/core/catalog.ts`, the hint descriptions, `TRANSFER_TEXT`, the
transfer blocks and the hint preamble in `src/core/hints.ts`, `SAVE_FUNCTION_DESCRIPTION` and the fix note in
`src/core/functions.ts`, tool results, the refusal texts and the approval prompt in `src/core/policy.ts`, and the
bundled hints in `hints/`.
- Every sentence must change what the model does. Remove facts the model cannot act on.
- Progressive disclosure: put in a description only what the model needs to choose and call the tool. Show the rest
  where the model needs it: argument types and hints in the `search_tools` result, server hints after a failed call,
  the limit in the message of a cut result.
- The tools in `SERVED` load in every session, so each word costs tokens in every session.
  `[test: code-mode.test.ts fails when their registrations grow; raise the limit only for text that changes what the model does]`
- Text the server shows names only tools it lists, and no Claude Code-only thing (`ToolSearch`, `~/.claude`, `/mcp`).
  A tool that ships later brings the text that names it. `[test: code-mode.test.ts checks the listed tools]`
- One way to do a thing. The runner also accepts `tools.<server>.<tool>()`, but descriptions show only `call()`.
- A hint is one short, factual bullet about a server. No data, no instructions about other actions.

## Docs
User docs are `README.md`. Out of this set: `AGENTS.md`, this file and the model-facing text above.
`tests/docs.check.mjs` checks the rules marked `[test]`.

### Format
- Plain Markdown, no JSX, imports or comments, so GitHub renders it. Keep `<…>` and `{…}` inside backticks or
  code blocks. `[test]`
- Relative links use the GitHub heading slug. When you rename a heading, fix every link to it.
  `[test: every link and anchor must resolve]`

### Language: ASD-STE100 (Simplified Technical English)
Technical names are allowed: tool names, options, file and product names.
- Instructions: imperative, one instruction per sentence, at most 20 words, condition first ("If X, do Y").
- Descriptions: at most 25 words per sentence `[test]`, one topic per sentence, at most 6 sentences per paragraph.
- Active voice, simple present. "can" for possibility, "must" for a requirement, "do not" for a prohibition.
- No should/may/might/would/could, contractions, semicolons, e.g./i.e./etc., or filler words (just, simply,
  easily) `[test]`. No -ing forms where a plain verb works. Keep the articles.
- Vertical lists for three or more items, numbered lists when order matters. A warning starts with the
  instruction, then gives the reason.
