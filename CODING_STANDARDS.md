# Coding standards

Rules for changing code, tests, model-facing text and docs in this repo. `[test: x]` marks a rule that a test
enforces; the others rely on discipline.

## Code
- Prettier formats code, JSON and YAML, not Markdown. Run it only through `scripts/format.sh`: the script holds the
  pinned version. Turn on the pre-commit hook one time per clone: `git config core.hooksPath .githooks`.
  `[test: code.check.mjs]`
- `src/core/` holds the pure helpers: `protocol.ts`, `hints.ts`, `functions.ts`, `paths.ts` and `tools.ts`. They
  import no Node module and no host package, so tests call them directly.
  `[test: tsc fails when a file in src/core uses a Node type: tsconfig.json sets types to an empty list]`
- Imports between files use the `.ts` extension, so Node can run the sources and `tsc` rewrites them. Use only
  syntax that Node can strip: no enums, no parameter properties, no namespaces. `[test: tsc, erasableSyntaxOnly]`
- Make each path into `.claude/code-mode` with a helper from `src/core/paths.ts`: `hintsFolder`, `functionsFolder`
  or `codeModePath`. `[test: code.check.mjs]`
- Make a hint ref with `hintRef` or `bundledRef`, and read one with `refTarget` (all in `src/core/hints.ts`).
  `[test: code.check.mjs fails when a file outside hints.ts types out the bundled: prefix]`
- Add or change a tool in `TOOLS` in `src/core/tools.ts`: the registration, the full ids (`TOOL`) and the typed
  input (`parseInput`) come from there. `[test: code.check.mjs]`
- `runtime/runner.mjs` runs inside the sandbox: Node built-ins only, no dependencies. It needs Node 22.13+, because
  the launch script passes `--permission`.
  `[test: runner.integration.mjs loads the runner with Node alone, so an import of a package fails]`
- `MARK` exists in `runtime/runner.mjs`, `src/core/protocol.ts` and `tests/runner.integration.mjs`. Change all
  copies. `[test: runner.integration.mjs fails when a copy differs]`
- To add a kind of message that the runner sends, add it to `RunnerMessage` and `RUNNER_FIELDS` in
  `src/core/protocol.ts`. A host drops a message of a kind that is not in `RUNNER_FIELDS`.
  `[test: runner.integration.mjs fails when the runner sends a kind that is not in RUNNER_FIELDS]`
- Never weaken a sandbox layer, the guard of hint and function files or the approval of proposals to make a test
  pass. Each one is a safety rule.

## Tests and commits
- The checks:
  - `npm test`: the pure-core tests (`tests/*.test.ts`, `node:test`).
  - `npm run typecheck` and `npm run build`: `tsc` with the pinned TypeScript.
  - `npm run check`: `tests/docs.check.mjs` (the doc rules below) and `tests/code.check.mjs` (the code rules).
  - `node tests/runner.integration.mjs`: the real sandbox under Node. It needs a POSIX system.
  - `sh scripts/format.sh --check .`: the format of code, JSON and YAML.
- CI (`.github/workflows/test.yml`) runs the sandbox test on Linux and on macOS, each with its network block
  (`unshare -rn` on Linux, `sandbox-exec` on macOS). `EXPECT_NETWORK_BLOCK` makes the test fail where neither works.
- Never put real MCP data, company names, ticket keys, user ids or tokens in tests, hints or docs: this repo is
  public. Use `fake`, `example.atlassian.net` and similar.

## Model-facing text
The text the model reads is part of the product: the input schemas in `TOOLS` in `src/core/tools.ts`,
`RUN_DESCRIPTION` and `SEARCH_DESCRIPTION` in `src/core/protocol.ts`, the hint descriptions, `TRANSFER_TEXT`, the
transfer blocks and the hint preamble in `src/core/hints.ts`, `SAVE_FUNCTION_DESCRIPTION` and the fix note in
`src/core/functions.ts`, tool results and deny messages, and the bundled hints in `hints/`.
- Every sentence must change what the model does. Remove facts the model cannot act on.
- Progressive disclosure: put in a description only what the model needs to choose and call the tool. Show the rest
  where the model needs it: argument types and hints in the `search_tools` result, server hints after a failed call,
  the limit in the message of a cut result.
- `run_code` and `search_tools` load in every session (`isDeferred: false`), so each word costs tokens in every
  session. `[test: code-mode.test.ts fails when their registrations grow; raise the limit only for text that changes what the model does]`
  The other tools are deferred. The front text names each of them.
  `[test: code-mode.test.ts fails when no front description or the hint preamble names a deferred tool]`
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
