# toolscript-mcp

A standalone MCP server in progress (pre-release): the model writes one JavaScript program that calls the tools of
other MCP servers in a sandbox, and only the return value goes back into the context. It is derived from the MIT
project claude-code-mode (see `NOTICE`). The server lists `run_code` and `search_tools`.

## Layout
- `src/core/` holds the pure helpers, with no Node modules and no host types: `protocol.ts` (runner protocol,
  results, kept results for recall, search, model-facing text), `hints.ts` (hint files and matching), `functions.ts`
  (saved functions), `paths.ts` (folders and guarded ones), `tools.ts` (the tool table and `SERVED`), `config.ts`
  (config parse, `${VAR}` expansion, config location, self-loop guard, the Claude Code bridges), `catalog.ts`
  (downstream tools, the `search_tools` result, argument specs from input schemas), `policy.ts` (the allow, deny and
  ask rules: the decision before a run, the check of each call and the refusal texts), `serial.ts` (the calls of one
  tool that a program awaited one after another, for the footer note on `Promise.all`). An allow rule allows a tool of
  a bridge only when its match starts with `mcp__<key>__` (`counts` in `policy.ts`). `doctor.ts` holds the line shape
  of `toolscript-mcp doctor` and the pure parts of its checks, such as `hiddenBy` (one glob covers another).
  `guard.ts` holds the guard of the folders in `guardedDirs` at each nested call: the walk of the arguments, the
  markers, the path candidates and the compare. It takes `realpath` as a parameter. `commands.ts` holds the commands
  that the CLI prints for a person or an agent to run: the allowlist of names and paths (`PLAIN_NAME`, `PLAIN_PATH`),
  the label lines, and the plan and lines of `toolscript-mcp allow`. Imports between them use `.ts` extensions.
- `src/host/` holds the host code, which runs in Node. `tsconfig.host.json` checks its types. `scripts/build.mjs`
  bundles it with the SDK into `dist/host/main.js`, the one file that the package runs.
  - `main.ts`: the `toolscript-mcp` command. It reads the config, starts the server and closes the children.
  - `server.ts`: the SDK `McpServer`, with a handler for each tool in `SERVED`, the approval prompt (elicitation),
    the policy read again at each run (a looser one waits for the person or a restart) and the runs in flight, which
    `main.ts` stops at shutdown.
  - `run.ts`: one `run_code` call: the check before a run, the policy, the sandbox, the nested calls, saveFile,
    readFile, recall and the result.
  - `downstream.ts`: connects to the servers of the config in parallel. A failed or closed server connects again on
    next use, at most 3 times in 60 s.
  - `oauth.ts`: the token store under `~/.toolscript-mcp/oauth/` and the SDK OAuth provider over it, in login mode
    or in the mode of the running server, which never starts a login.
  - `login.ts`: `toolscript-mcp login <server>`: the callback listener, the browser and the token exchange.
  - `launch.ts`: starts the runner with the sandbox layers of each OS, the host kill timer and the exchange dir.
  - `diagnose.ts`: `toolscript-mcp tools <server>` (connects to one server and prints each tool with its hint and
    policy decision, then the `allow` commands) and `toolscript-mcp runs` (reads the run log and gives the next step
    for each problem).
  - `allow.ts`: `toolscript-mcp allow <tool>...`, a dry run that prints its `--apply` command, or with `--apply` the
    write of the policy. `configfile.ts` writes the config for init and allow: a 0600 temp file, then a rename.
  - `shapes.ts`: the learned result shapes in `~/.toolscript-mcp/learned/shapes.json` (`shapesFile` in `paths.ts`).
    `loadShapes` reads the file at start as untrusted (`parseShapes`, `isLearnedShape` in `protocol.ts`), and
    `saveShapes` merges a run's shapes in with the same temp file and rename. `shownShapes` in `catalog.ts` shows a
    stored shape only when the hash of the tool's `inputSchema` matches. `run.ts` saves after a run that read no
    untrusted content.
  - `doctor.ts`: `toolscript-mcp doctor`, one pass over the whole setup. Its checks are a table of small async
    functions in print order. It reuses the connect path of `tools`, the run-log reader of `runs` and the launch of
    `run_code` for a run of `return 1`.
  - `start.ts`: how the process started, the config read and the login command, shared by the server and the CLI.
- `demo/` holds a read-only demo MCP server with fixed sample data, for a first run without an account. The package
  ships it. `demo/data.mjs` exports the answer of its first task.
- `runtime/runner.mjs` is the sandbox. Node built-ins only.
- `hints/` holds the bundled hints and `hints/sha256.json`.
- `.claude-plugin/marketplace.json` makes the repo a Claude Code plugin marketplace with one plugin, `plugin/`. Its
  skill `setup` installs toolscript-mcp from the `beta` branch, and `config.mjs` beside it changes the
  config without printing secrets. The skill `start` guides the first run, and `doctor` checks the whole setup. The
  npm package does not hold them.
- `bench/` holds the token and cost bench. `run.mjs` and `interactive.mjs` start Claude Code and spend money.
  - `run.mjs`: direct MCP tools against toolscript-mcp in headless Claude Code, and the arm `both`, which lists both
    and counts how often the model picks `run_code`. `--dry-run` starts no run. Results in `RESULTS.md`.
  - `interactive.mjs`: direct tools, Claude Code Code Mode and toolscript-mcp in the interactive TUI. Results in
    `RESULTS-codemode.md`. `spend.mjs` holds its spend cap.
  - `CODEX.md`: the test plan for the same arms in Codex, and the result of the Codex smoke test. `check.mjs`
    judges an answer of another agent.
  - `data.mjs` holds the tasks and their checks, `fake-server.mjs` the fake MCP server, and `forget.mjs` removes the
    Claude Code project folder of a run.
- `tests/*.test.ts` run with `node:test`. `tests/run.test.ts` runs `src/host/run.ts` with the real sandbox and fake
  servers. `tests/*.check.mjs` and `tests/runner.integration.mjs` are plain Node.

## How to test
- `npm test`, `npm run typecheck`, `npm run build`, `npm run check`.
- `node tests/runner.integration.mjs` runs the real sandbox on Linux, macOS and Windows.
- `node tests/server.e2e.mjs` runs the built server over stdio. Run `npm run build` first.
- After a change to a bundled hint, run `node scripts/bundled-hints.mjs`.
- `node scripts/start-time.mjs` measures the start, from the spawn to the `tools/list` reply. Run `npm run build` first.

## Rules
- Read `CODING_STANDARDS.md` before a change to code, tests or model-facing text.
- Never weaken a sandbox layer to make a test pass.
- stdout carries only MCP JSON-RPC. Log to stderr.
- After a change in `plugin/`, raise `version` in `plugin/.claude-plugin/plugin.json`. Users get a new copy of the
  plugin only when the version changes.
