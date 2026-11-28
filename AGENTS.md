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
  the stale decision, and the reason text of a silent token endpoint), `spawn.ts` (the reason text of a stdio command that cannot start: the command only, never an argument or a variable), `serial.ts` (the calls of one tool that a program awaited one after another, for the footer
  note on `Promise.all`), `workspace.ts` (the built-in Workspace, issue #144: the tool table with a class for each
  tool, the limits, the check of a path text, globs, exclusions, the refusal of a root, the binding of a session to its
  root, the input of each tool, the application of edits and the unified diff) and `task.ts` (its named tasks: the
  shape of a task, the checks of its text, the variable list, `argumentLine` (the command-line text of Windows), the
  texts of the cap and of an unknown task), `taskjob.ts` (the reports of the task helpers, the decision from them, the
  frames and the environment block), `roots.ts` (issue #150: `fileUriPath`, the path of a client root URI, and
  `narrowRoot`, the root that client roots narrow to, never wider than the bound root) and `ignore.ts` (the parse of a
  `.gitignore` and the test of a path, for `list` and `search` only), `childenv.ts` (the variables that a stdio child inherits: the
  list of the first SDK, as our own constant) and `issuer.ts` (the texts of the two issuer checks of a login). An allow
  rule allows a tool of the exec class (`run_task`) only when its match is the exact name. An allow rule allows a tool
  of a bridge or a change tool of Workspace only when its match starts with `mcp__<key>__` (`needs` and `counts` in
  `policy.ts`). `policy.ts` takes one `Guards` value: the bridges, and whether the built-in Workspace is on, so that
  its read tools run with no rule and its change and exec tools ask. `runlog.ts` also holds the applied changes of a
  run and their text. `doctor.ts` holds the line shape of `toolscript-mcp doctor` and the pure parts of its
  checks, such as `hiddenBy` (one glob covers another). `skills.ts` (issue #92, S1) is the pure mapping from hint files and saved
  functions to skill entries (`skillsOf`): which hint files apply, the name, the fixed description and the `SKILL.md` text of each
  skill, and the caps (8 skills, 1,000 characters of names and descriptions, `more-hints`). It reads no file and serves nothing.
  `guard.ts` holds the guard of the folders in `guardedDirs` at each nested call: the walk of the arguments, the
  markers, the path candidates and the compare. It takes `realpath` as a parameter. `toml.ts` (the strict reader of the `[mcp_servers]` tables of a Codex `config.toml`, for `init`) and `codex.ts` (the map of a Codex server to an entry, policy rules and notes) hold the Codex import of `init`, which `src/host/codex.ts` reads for (the Codex CLI first, then `config.toml`, cwd the home folder). `commands.ts` holds the commands
  that the CLI prints for a person or an agent to run: the allowlist of names and paths (`PLAIN_NAME`, `PLAIN_PATH`),
  the label lines, and the plan and lines of `toolscript-mcp allow`. Imports between them use `.ts` extensions.
- `src/host/` holds the host code, which runs in Node. `tsconfig.host.json` checks its types. `scripts/build.mjs`
  bundles it with the SDK into `dist/host/main.js`, the file that the package runs, and the broker of the shared servers into
  `dist/host/broker.js`, which the host starts on demand (no SDK in it).
  - `main.ts`: the `toolscript-mcp` command. It reads the config, starts the server and closes the children.
  - `brokerlink.ts`: the host side of sharing (issue #63): `entryOf` (the entry of a server with its `PATH` resolved),
    `openLink` (find or start the broker, the mutual proof of the key, the entry) and `BrokerTransport`, an SDK
    `Transport` over one connection. `downstream.ts` uses it for a shared or per-folder server when sharing is on. A
    broker that cannot be reached fails the link with a reason (decision 024): it starts no direct child. A peer that closes before it sends one line is a broker that was killed a moment ago: `openLink` dials again on the same 10 s clock (one start of a broker for the whole link), and a silent or wrong peer is never taken for a dead one.
    `brokerwire.ts` holds the key file, the build id (SHA-256 of `broker.js`) and the endpoint name.
  - `broker.ts`: the broker process, built from `brokermain.ts` into `dist/host/broker.js`, a second bundle with Node
    built-ins and `cross-spawn` only. One router (`src/core/mux.ts`) and one child for each share key. The listen is the
    lock. A socket file that refuses a connect is removed only after the same file has refused for `guardMs` (1 s), because
    a broker between its bind and its listen refuses too (issue #133). `TOOLSCRIPT_BROKER_IDLE_MS` (at least 1000) shortens the 10-minute idle time, for tests and the bench. Log:
    `~/.toolscript-mcp/broker/broker.log`, lifecycle lines only. Frames of the broker to a host start with `MARK`
    (`src/core/broker.ts`), so no server line passes as one (`WIRE` 2). Child stderr goes to the hosts as `stderr`
    frames (rate, backlog and tail limits in `src/core/broker.ts`), never to the log. The caps `LINKS_MAX`,
    `CHILDREN_MAX` and `UNSENT_MAX` are options of `startBroker`, which tests make small. A stale recovery lock is
    broken by rename (`takeLock`), and a socket left by a kill is linked back or swept at the next start. `doctor`
    names the way out for a taken name and reads the Windows access rules of the broker folder (never the server).
    `scripts/broker-proc.mjs` is how `scripts/start-time.mjs` checks a pid before it ends the broker.
  - `server.ts`: `createHost` makes the state of the process one time (the kept results, the `saveFile` folder, the learned shapes, the
    policy and the runs in flight) and gives `make(era)`, a factory of `HostServer` instances (a v2 `Server`, built in `sdk/server.ts`),
    each with a handler for each tool in `SERVED`, the approval prompt (elicitation, legacy era only) and the policy read again at each
    run (a looser one waits for the person or a restart). `main.ts` stops the runs at shutdown. `createServer` is one legacy instance.
    `serve.ts` (issue #154, PR 13): with `TOOLSCRIPT_PROTOCOL=auto`, `serveStdio` calls the factory for a `server/discover` probe and
    again for the connection, so the factory only builds an instance (no file, child, log line or timer). A modern instance has no
    Workspace until the next change of the release. It asks by `input_required` (issue #154, P3-1): the approval stage that would push a
    prompt throws `NeedsInput`, and the `tools/call` handler answers with the prompt and a `requestState` sealed by the SDK codec
    (HMAC-SHA256, a key made at process start). `src/core/state.ts` holds the payload (version, kind, round, a number used once, and
    three hashes: the call's arguments, the sorted asked tools, the policy), the table of open numbers (256, used one time) and the answer
    of the client; the state is checked in `requestState.verify` and the arguments in the handler. Only a request whose own envelope
    declares elicitation is asked. With `legacy` or no variable, one legacy instance on a stdio transport, which pushes its prompt.
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
  - `childtransport.ts`: the stdio transport of every direct stdio server, lazy or not: it counts open requests, tells the host of each message, and
    stops the child as the broker does (end stdin, wait 2 s, end the tree). `toolscache.ts`: the display-only tool lists in
    `~/.toolscript-mcp/learned/tools.json` (`toolsFile` in `paths.ts`; `parseToolsCache` and `isLazy` in `src/core/lazy.ts`).
    `downstream.ts` holds the `asleep` state, the wake and the idle clock. `TOOLSCRIPT_LAZY=0` turns every lazy start off, and
    `TOOLSCRIPT_LAZY_IDLE_MS` (at least 1000) shortens the idle time for tests and the bench.
  - `childguard.ts`: the child guard, so a stdio child never outlives a host or a broker that was killed with no cleanup:
    `createGuard` (outside Windows one `/bin/sh` watchdog that reads `+<pgid>` and `-<pgid>` lines and, at EOF, ends the groups
    still listed; on Windows, only with `TOOLSCRIPT_CHILD_GUARD=1`, `runtime/child-guard.cs` compiled one time with the
    csc.exe of .NET Framework 4 into `~/.toolscript-mcp/guard`, a Job Object that Windows closes with the host). `ChildTransport`
    and the broker list each child in it. A guard that cannot start logs one line and never fails a server. The pure parts
    (switch, lines, watchdog text, texts) are in `src/core/childguard.ts`. Tests: `tests/childguard.test.ts` and the guard
    case of `tests/lazy.e2e.mjs`.
  - `doctor.ts`: `toolscript-mcp doctor`, one pass over the whole setup. Its checks are a table of small async
    functions in print order. It reuses the connect path of `tools`, the run-log reader of `runs` and the launch of
    `run_code` for a run of `return 1`.
  - `start.ts`: how the process started, the config read and the login command, shared by the server and the CLI.
  - `skills.ts`: the reader for `src/core/skills.ts` (issue #92, S1): the bundled hints whose SHA-256 `hints/sha256.json` lists, the
    `*.md` files directly in the person's hint folder and function folder (never `pending/`, a project folder or a link; 64 files,
    65,536 bytes, UTF-8), one stderr line for a skipped file. Nothing imports it yet but `tests/skills-fs.test.ts`.
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
- `docs/` holds the user docs, one page for each topic, with the index in `README.md`. A new page needs no edit of
  `tests/docs.check.mjs`: it reads every `docs/*.md`. `docs/adr/` holds the design records and is checked for links only.
  `docs/adr/0154-sdk-v2-and-the-2026-protocol.md` is the plan of issue #154 (SDK v2, protocol 2026-07-28) with its baseline numbers and budgets.
- `demo/` holds a read-only demo MCP server with fixed sample data, for a first run without an account. The package
  ships it. `demo/data.mjs` exports the answer of its first task.
- `runtime/runner.mjs` is the sandbox. Node built-ins only. `runtime/task-job.ps1` is the warm Windows PowerShell 5.1
  job helper and `runtime/task-reap.pl` the perl helper of Linux and macOS (issue #149). `runtime/child-guard.cs` is the source of the
  Windows child guard. They are shipped files that `scripts/pack-check.mjs` requires, and the build does not bundle them.
- `hints/` holds the bundled hints and `hints/sha256.json`.
- `changes/` holds one file for each pull request with a user-visible change (`changes/README.md` says how), and
  `scripts/changelog.mjs <version> [--apply]` folds them into `CHANGELOG.md` at the release (Node built-ins only; a
  dry run by default; `tests/changelog.test.ts`). The npm package does not hold `changes/`.
- `.claude-plugin/marketplace.json` makes the repo a Claude Code plugin marketplace with one plugin, `plugin/`. Its
  skill `setup` installs toolscript-mcp from npm, and `config.mjs` beside it changes the
  config without printing secrets. `roots.mjs` beside it is a pure copy of the root rules of `src/core/workspace.ts`
  (`rootProblem`), and `tests/plugin-config.test.ts` compares the two row by row. The skill `start` guides the first
  run, `doctor` checks the whole setup, and `workspace` turns on the built-in Workspace for a project folder with the
  `workspace` commands of `config.mjs`. The npm package does not hold them.
- `bench/` holds the token and cost bench. `run.mjs` and `interactive.mjs` start Claude Code and spend money.
  - `run.mjs`: direct MCP tools against toolscript-mcp in headless Claude Code, and the arm `both`, which lists both
    and counts how often the model picks `run_code`. `--dry-run` starts no run. Results in `RESULTS.md`.
  - `interactive.mjs`: direct tools, Claude Code Code Mode and toolscript-mcp in the interactive TUI. Results in
    `RESULTS-codemode.md`. `spend.mjs` holds its spend cap.
  - `memory.mjs`: what N sessions cost in private bytes, processes and start time, with no model and no spend.
    Fixture mode by default; `--config <file>` is real mode, for the owner only. Results in `RESULTS-memory.md`.
    `tests/memory.e2e.mjs` runs its smoke and the hard-kill case.
  - `broker-race.mjs`: N brokers started at once on a fresh HOME, R rounds, counts the rounds with two brokers at once
    (issue #133). Linux and macOS; no model and no spend. `--contenders 20 --rounds 300` is the case that reproduced it.
  - `bridge-modes.mjs`: interactive Claude Code through node-pty, with the real `claude mcp serve` bridge behind toolscript-mcp
    (issue #94): the permission-mode matrix (`matrix`, `cell`, `print`) and G10 of issue #63 (`g10`, two sessions on one
    broker, Windows only). It spends money on Haiku and stops at `--max-spend` (default 3 USD). Temp HOME and fixture for each cell.
  - `walks.mjs`: N parallel Workspace `search` calls on one tree, in Docker with `--cpus 1` only. Results in `RESULTS-walks.md`.
  - `workspace-bridge.mjs`: the same four questions about one temp repository through hosts with the built-in Workspace or the
    Claude Code bridge (`claude mcp serve`), driven as `run_code` calls: time, result characters, processes and private memory
    (Windows) for 1 and 6 sessions. No model, no spend. Results in `RESULTS-workspace-bridge.md`.
  - `CODEX.md`: the test plan for the same arms in Codex, and the result of the Codex smoke test. `check.mjs`
    judges an answer of another agent.
  - `data.mjs` holds the tasks and their checks, `fake-server.mjs` the fake MCP server, and `forget.mjs` removes the
    Claude Code project folder of a run.
- `.github/workflows/stress.yml` runs repeats, flakes, load, one-CPU, bench and baseline runs on the free runners (Linux, macOS,
  Windows), from the Actions tab, from a push to `stress/**`, and every Sunday on main (flakes and baseline). Its profiles are
  `tests/stress.json`. `scripts/stress.mjs` (Node built-ins only; `tests/stress.test.ts`) repeats one target with the junit
  reporter and writes the summary of each test that failed (runs, fails, rate, first failing run and seed), the budgets of
  `baseline` (with the SHA-256 rows of the upgrade gate: a row that may differ on purpose is named in `baseline.differs` of
  `tests/stress.json`, with a reason and a PR number), and the jobs of a run (`plan`). `.github/actions/test-volumes` holds the vfat, casefold and APFS setup that
  `test.yml` and `stress.yml` share. `stress/**` branches are deleted by the session that pushed them, when the run is read.
- The protocol switch (#154, PR 9) is two environment variables and never a config key (1.0.5 refuses an unknown key, and turns an
  entry with one into an invalid server): `TOOLSCRIPT_PROTOCOL=legacy|auto` (default `legacy`) and `TOOLSCRIPT_LEGACY_SERVERS=<key>,<key>`
  (servers that stay on `legacy`). `parseProtocol` in `src/core/config.ts` reads them into `Config.protocol`, and `protocolOf` gives the
  value of one link. It changes no wire yet: only an `auto` link writes `protocol` in its broker entry frame and share key, so a
  `legacy` and an `auto` link never share a child. `legacy` has the bytes of 1.0.5. `doctor` prints a `protocol` line only when a
  variable is set. Tests: `tests/protocol-flag.test.ts` and `tests/protocol-flag.e2e.mjs` (it needs `tests/first-message-server.mjs`).
- `tests/modern-server.mjs`, `modern-http.mjs`, `modern-client.mjs` and `modern-core.mjs` are the raw JSON-RPC peers of the 2026-07-28 revision (issue #154, C0), plain `.mjs`
  with no SDK: a stdio fake (kinds `modern`, `dual` and the old-server kinds, by argument), an HTTP fake (`startHttp(kind)`, with a record of every
  request), a raw client with the openings as data (`OPENINGS`, `replay`, Claude Code's two among them), and the engine they share.
  `tests/modern-peers.test.ts` checks the peers. `tests/conformance.json` is the matrix, one row for each (side, kind, link, flag), `pending` with
  its PR or `covered` with a test; `tests/conformance.test.ts` keeps a row from being dropped or marked covered with no test.
- `tests/*.test.ts` run with `node:test`. `tests/run.test.ts` runs `src/host/run.ts` with the real sandbox and fake
  servers. `tests/*.check.mjs` and `tests/runner.integration.mjs` are plain Node.

## How to test
- `npm test`, `npm run typecheck`, `npm run build`, `npm run check`.
- `node tests/runner.integration.mjs` runs the real sandbox on Linux, macOS and Windows.
- `node tests/server.e2e.mjs` runs the built server over stdio. Run `npm run build` first.
- `node tests/bridge.e2e.mjs` runs one program through the real `claude mcp serve` bridge (Grep, Read, Edit, a shell test run)
  and the missing-binary case. It needs `claude` on PATH, else it prints one line and exits 0. It is not in `npm test`.
- `node tests/workspace.e2e.mjs` runs the built server with the built-in Workspace and no Claude. Run `npm run build` first.
- `node tests/protocol-flag.e2e.mjs` runs the built server with `TOOLSCRIPT_PROTOCOL` unset, `legacy` and `auto`: the same first message
  and hashes for a direct, a lazy, a shared and an HTTP link, the answers to what a downstream server may not ask, and the child count
  of a shared server. Run `npm run build` first.
- `node tests/modern-upstream.e2e.mjs` runs the built server with `TOOLSCRIPT_PROTOCOL=auto` and the raw client of C0: a 2026-07-28 session
  against a legacy one (discover, `tools/list`, a table of programs), `ask` and the Workspace on a modern connection, the stream, cancel and
  close, and the error of 1.0.5 for `server/discover` with the variable unset. `tests/upstream-golden-auto.test.ts` is the golden of PR 7
  again through `serveStdio` (G2), `tests/upstream-modern-golden.test.ts` the golden of the modern openings, `tests/modern-upstream.test.ts`
  the factory rule (three instances, one state). Run `npm run build` first.
- `node tests/modern-approval.e2e.mjs` runs the built server with `auto` and the raw client of C0 through the approval on a 2026-07-28
  connection: accept, decline, cancel, no or bad answer, a replay, a moved or changed state, a restart, a policy that changed between
  rounds, the policy round, 5 rounds, the capability of each request, two calls in flight, and the opening of Claude Code. The 601 s
  clock is `tests/modern-approval.test.ts`, the pure part `tests/state.test.ts`. Run `npm run build` first.
- `node tests/upgrade.e2e.mjs --base <built 1.0.5 dir> --head <built dir>` runs both builds on one HOME with raw JSON-RPC:
  an OAuth store refreshed both ways, a 1.0.5 host and a head host on one broker or two, and the rollback read (doctor,
  `tools/list`, `run_code`, `search_tools` of one build on the files of the other). With no `--base` it prints one line and
  exits 0. It is not in `npm test`: the `baseline` job of `stress.yml` runs it, beside the SHA-256 rows of the baseline.
- After a change to a bundled hint, run `node scripts/bundled-hints.mjs`.
- `node scripts/start-time.mjs` measures the start, from the spawn to the `tools/list` reply. Run `npm run build` first.

## Rules
- Read `CODING_STANDARDS.md` before a change to code, tests or model-facing text.
- Only `src/host/sdk/` imports the MCP SDK. Callers import from its files (`client.ts`, `server.ts`, `transport.ts`,
  `auth.ts`, `errors.ts`; no barrel). The host is on SDK v2 in the legacy era: `@modelcontextprotocol/client` for every
  link and `login`, `@modelcontextprotocol/server` for the server, the Workspace provider and roots (PR 7). No file of `src/` imports the
  first SDK, and nothing outside the folder reads `ctx.mcpReq`. The tests and `bench/walks.mjs` import the SDK only through `tests/sdk.mjs` (the SDK package
  itself, never `src/host/sdk/`, so the test peers stay on v1 while the host moves). `tests/code.check.mjs` enforces both (issue #154).
- Never weaken a sandbox layer to make a test pass.
- stdout carries only MCP JSON-RPC. Log to stderr.
- A user-visible change adds a file in `changes/`, and never edits `CHANGELOG.md`. The version-bump PR runs
  `node scripts/changelog.mjs <version> --apply`, then rewrites the section by hand as a summary.
- Before the release button, a `flakes` run and a `baseline` run of `stress.yml` on main must be green (the weekly run counts when
  main has not changed since): `gh run list --workflow stress.yml --branch main`. A flake is fixed, never accepted: there is no
  allow list. A red weekly run is read at the start of the next session and taken before other work.
- After a change in `plugin/`, raise `version` in `plugin/.claude-plugin/plugin.json`. Users get a new copy of the
  plugin only when the version changes.
