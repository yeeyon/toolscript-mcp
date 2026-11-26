# toolscript-mcp

A standalone MCP server, version 1.0.3: the model writes one JavaScript program that calls the tools of other MCP
servers in a sandbox, and only the return value goes back into the context. It is derived from the MIT project
claude-code-mode (see `NOTICE`). The server lists `run_code` and `search_tools`.

## Layout
- `src/core/` holds the pure helpers, with no Node modules and no host types: `protocol.ts` (runner protocol,
  results, kept results for recall, search, model-facing text), `hints.ts` (hint files and matching), `functions.ts`
  (saved functions), `paths.ts` (folders and guarded ones), `tools.ts` (the tool table and `SERVED`), `config.ts`
  (config parse, `${VAR}` expansion, config location, self-loop guard, the Claude Code bridges), `catalog.ts`
  (downstream tools, the `search_tools` result, argument specs from input schemas), `policy.ts` (the allow, deny and
  ask rules: the decision before a run, the check of each call and the refusal texts), `mux.ts` (the router of one
  child process that several sessions share, pure), `share.ts` (the class of a stdio server when sharing is on and the
  text of its share key), `broker.ts` (the wire of the broker: limits, endpoint name, the mutual
  proof of the key, the entry, `PATH` resolve), `lock.ts` (the content of the OAuth refresh lock file, its parse and
  the stale decision), `serial.ts` (the calls of one tool that a program awaited one after another, for the footer
  note on `Promise.all`), `workspace.ts` (the built-in Workspace, issue #144: the tool table with a class for each
  tool, the limits, the check of a path text, globs, exclusions, the refusal of a root, the binding of a session to its
  root, the input of each tool, the application of edits and the unified diff) and `task.ts` (its named tasks: the
  shape of a task, the checks of its text, the variable list, `argumentLine` (the command-line text of Windows), the
  texts of the cap and of an unknown task), `taskjob.ts` (the reports of the task helpers, the decision from them, the
  frames and the environment block), `roots.ts` (issue #150: `fileUriPath`, the path of a client root URI, and
  `narrowRoot`, the root that client roots narrow to, never wider than the bound root) and `ignore.ts` (the parse of a
  `.gitignore` and the test of a path, for `list` and `search` only). An allow
  rule allows a tool of the exec class (`run_task`) only when its match is the exact name. An allow rule allows a tool
  of a bridge or a change tool of Workspace only when its match starts with `mcp__<key>__` (`needs` and `counts` in
  `policy.ts`). `policy.ts` takes one `Guards` value: the bridges, and whether the built-in Workspace is on, so that
  its read tools run with no rule and its change and exec tools ask. `runlog.ts` also holds the applied changes of a
  run and their text. `doctor.ts` holds the line shape of `toolscript-mcp doctor` and the pure parts of its
  checks, such as `hiddenBy` (one glob covers another).
  `guard.ts` holds the guard of the folders in `guardedDirs` at each nested call: the walk of the arguments, the
  markers, the path candidates and the compare. It takes `realpath` as a parameter. `commands.ts` holds the commands
  that the CLI prints for a person or an agent to run: the allowlist of names and paths (`PLAIN_NAME`, `PLAIN_PATH`),
  the label lines, and the plan and lines of `toolscript-mcp allow`. Imports between them use `.ts` extensions.
- `src/host/` holds the host code, which runs in Node. `tsconfig.host.json` checks its types. `scripts/build.mjs`
  bundles it with the SDK into `dist/host/main.js`, the file that the package runs, and the broker of the shared servers into
  `dist/host/broker.js`, which the host starts on demand (no SDK in it).
  - `main.ts`: the `toolscript-mcp` command. It reads the config, starts the server and closes the children.
  - `brokerlink.ts`: the host side of sharing (issue #63): `entryOf` (the entry of a server with its `PATH` resolved),
    `openLink` (find or start the broker, the mutual proof of the key, the entry) and `BrokerTransport`, an SDK
    `Transport` over one connection. `downstream.ts` uses it for a shared or per-folder server when sharing is on. A
    broker that cannot be reached fails the link with a reason (decision 024): it starts no direct child.
    `brokerwire.ts` holds the key file, the build id (SHA-256 of `broker.js`) and the endpoint name.
  - `broker.ts`: the broker process, built from `brokermain.ts` into `dist/host/broker.js`, a second bundle with Node
    built-ins and `cross-spawn` only. One router (`src/core/mux.ts`) and one child for each share key. The listen is the
    lock. `TOOLSCRIPT_BROKER_IDLE_MS` (at least 1000) shortens the 10-minute idle time, for tests and the bench. Log:
    `~/.toolscript-mcp/broker/broker.log`, lifecycle lines only. Frames of the broker to a host start with `MARK`
    (`src/core/broker.ts`), so no server line passes as one (`WIRE` 2). Child stderr goes to the hosts as `stderr`
    frames (rate, backlog and tail limits in `src/core/broker.ts`), never to the log. The caps `LINKS_MAX`,
    `CHILDREN_MAX` and `UNSENT_MAX` are options of `startBroker`, which tests make small. A stale recovery lock is
    broken by rename (`takeLock`), and a socket left by a kill is linked back or swept at the next start. `doctor`
    names the way out for a taken name and reads the Windows access rules of the broker folder (never the server).
    `scripts/broker-proc.mjs` is how `scripts/start-time.mjs` checks a pid before it ends the broker.
  - `server.ts`: the SDK `McpServer`, with a handler for each tool in `SERVED`, the approval prompt (elicitation),
    the policy read again at each run (a looser one waits for the person or a restart) and the runs in flight, which
    `main.ts` stops at shutdown.
  - `run.ts`: one `run_code` call: the check before a run, the policy, the sandbox, the nested calls, saveFile,
    readFile, recall and the result.
  - `downstream.ts`: connects to the servers of the config in parallel. A failed or closed server connects again on
    next use, at most 3 times in 60 s.
  - `oauth.ts`: the token store under `~/.toolscript-mcp/oauth/` and the SDK OAuth provider over it, in login mode
    or in the mode of the running server, which never starts a login.
  - `sigv4.ts`: the AWS SigV4 signing of an HTTP entry with `"sigv4"` (issue #135), with `node:crypto`. The credentials
    come from `aws configure export-credentials --profile <name>` and stay in memory until 5 minutes before they expire.
  - `oauthlock.ts`: the lock file of one OAuth refresh (`<store>.lock`), taken in `renew` of `oauth.ts`: the create
    with `wx`, the wait, the takeover of a stale lock through a claim file, and the removal.
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
  - `childtransport.ts`: the stdio transport of a lazy server: it counts open requests, tells the host of each message, and
    stops the child as the broker does (end stdin, wait 2 s, end the tree). `toolscache.ts`: the display-only tool lists in
    `~/.toolscript-mcp/learned/tools.json` (`toolsFile` in `paths.ts`; `parseToolsCache` and `isLazy` in `src/core/lazy.ts`).
    `downstream.ts` holds the `asleep` state, the wake and the idle clock. `TOOLSCRIPT_LAZY=0` turns every lazy start off, and
    `TOOLSCRIPT_LAZY_IDLE_MS` (at least 1000) shortens the idle time for tests and the bench.
  - `doctor.ts`: `toolscript-mcp doctor`, one pass over the whole setup. Its checks are a table of small async
    functions in print order. It reuses the connect path of `tools`, the run-log reader of `runs` and the launch of
    `run_code` for a run of `return 1`.
  - `start.ts`: how the process started, the config read and the login command, shared by the server and the CLI.
  - `workspace/`: the built-in Workspace (issue #144, `docs/adr/0144-workspace-provider.md`). `confined.ts`: the
    confined file system, with a proof of each open for each OS, the first-use test of the method, the identity of the
    root and a `Hook` that runs before each lookup of a name, so a test swaps a folder between two lookups. `provider.ts`:
    the in-process MCP server over an SDK `InMemoryTransport`, one handler for each entry of `WORKSPACE_TOOLS`. `bind.ts`:
    the binding of a session to its root at the start (`bindWorkspace`), and the link that `downstream.ts` takes. The
    broker never shares it, and it is never lazy. `write.ts`: the lock of a change (one in the process, and a lock file
    under `~/.toolscript-mcp/locks` through `takeLock`). `confined.ts` also holds the proven write for each OS. The
    tests of it are `tests/workspace-write.test.ts` and `tests/workspace-lock.test.ts` (its child process is
    `tests/workspace-lock-child.ts`). `roots.ts`: `createRoots` sends `roots/list` one time after the client
    initialized, settles on the answer, an error or `ROOTS_WAIT_MS`, and `bindWorkspace` takes the settled list
    (`clientRoots`), so the provider exists only after the settle. `main.ts` hands `server.ts` and `downstream.ts` the
    bind as a promise. Tests: `tests/workspace-roots-fs.test.ts`, `tests/workspace-ignore-fs.test.ts`. `task.ts`: `resolveTasks` finds each task once at the start (`PATH`
    lookup, the `.exe` rule of Windows, the proof of the folder), and `createTaskRunner` runs one task at a time with
    `node:child_process` (no shell, no `cross-spawn`), the caps, the time limit and the end of the process tree
    (the helper of the OS, with `endTree` of `broker.ts` as the fallback of the direct spawn).
    `src/host/taskjob.ts` (beside `launch.ts`) runs the helpers: `createJobHost`, the one warm Windows PowerShell process
    of a runner (frames on its standard input, reports on a named pipe, a pipe for each stream of a task, a stop frame, a
    10-minute idle stop), `startReap`, the perl helper of one task on Linux and macOS, and `probeHelper` for `doctor`. The
    pure parts (reports, decision, frames, environment block) are in `src/core/taskjob.ts`. `tests/workspace-rig.ts` is
    the helper of its tests, `tests/task-child.mjs` the child of the task tests, and `tests/task-host-child.ts` the host
    that the hard-kill test kills.
- `demo/` holds a read-only demo MCP server with fixed sample data, for a first run without an account. The package
  ships it. `demo/data.mjs` exports the answer of its first task.
- `runtime/runner.mjs` is the sandbox. Node built-ins only. `runtime/task-job.ps1` is the warm Windows PowerShell 5.1
  job helper and `runtime/task-reap.pl` the perl helper of Linux and macOS (issue #149). They are shipped files that
  `scripts/pack-check.mjs` requires, and the build does not bundle them.
- `hints/` holds the bundled hints and `hints/sha256.json`.
- `.claude-plugin/marketplace.json` makes the repo a Claude Code plugin marketplace with one plugin, `plugin/`. Its
  skill `setup` installs toolscript-mcp from npm, and `config.mjs` beside it changes the
  config without printing secrets. The skill `start` guides the first run, and `doctor` checks the whole setup. The
  npm package does not hold them.
- `bench/` holds the token and cost bench. `run.mjs` and `interactive.mjs` start Claude Code and spend money.
  - `run.mjs`: direct MCP tools against toolscript-mcp in headless Claude Code, and the arm `both`, which lists both
    and counts how often the model picks `run_code`. `--dry-run` starts no run. Results in `RESULTS.md`.
  - `interactive.mjs`: direct tools, Claude Code Code Mode and toolscript-mcp in the interactive TUI. Results in
    `RESULTS-codemode.md`. `spend.mjs` holds its spend cap.
  - `memory.mjs`: what N sessions cost in private bytes, processes and start time, with no model and no spend.
    Fixture mode by default; `--config <file>` is real mode, for the owner only. Results in `RESULTS-memory.md`.
    `tests/memory.e2e.mjs` runs its smoke and the hard-kill case.
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
- `node tests/workspace.e2e.mjs` runs the built server with the built-in Workspace and no Claude. Run `npm run build` first.
- After a change to a bundled hint, run `node scripts/bundled-hints.mjs`.
- `node scripts/start-time.mjs` measures the start, from the spawn to the `tools/list` reply. Run `npm run build` first.

## Rules
- Read `CODING_STANDARDS.md` before a change to code, tests or model-facing text.
- Never weaken a sandbox layer to make a test pass.
- stdout carries only MCP JSON-RPC. Log to stderr.
- After a change in `plugin/`, raise `version` in `plugin/.claude-plugin/plugin.json`. Users get a new copy of the
  plugin only when the version changes.
