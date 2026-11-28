# Coding standards

Rules for changing code, tests, model-facing text and docs in this repo. `[test: x]` marks a rule that a test
enforces; the others rely on discipline.

## Code
- Prettier formats code, JSON and YAML, not Markdown. Run it only through `scripts/format.sh`: the script holds the
  pinned version. Turn on the pre-commit hook one time per clone: `git config core.hooksPath .githooks`.
  `[test: code.check.mjs]`
- `src/core/` holds the pure helpers: `protocol.ts`, `hints.ts`, `functions.ts`, `paths.ts`, `tools.ts`,
  `config.ts`, `catalog.ts`, `policy.ts`, `serial.ts`, `guard.ts`, `mux.ts`, `share.ts`, `broker.ts`, `lock.ts`, `workspace.ts`, `task.ts`, `roots.ts`, `ignore.ts`, `toml.ts` and `codex.ts`. They import no Node module and no host package, so tests call them directly.
  `[test: tsc fails when a file in src/core uses a Node type: tsconfig.json sets types to an empty list]`
- `src/host/` holds the code that runs in Node. `tsconfig.host.json` checks it with the Node types.
- The package runs `dist/host/main.js`, and starts `dist/host/broker.js` on demand when sharing is on (issue #63).
  `scripts/build.mjs` bundles `src/host/main.ts` and `src/host/brokermain.ts` with the packages they import, and writes
  the licences of both to `dist/third-party-licenses.txt`. The broker bundle holds Node built-ins and `cross-spawn` only. Node loads one file faster than
  the modules of the SDK: see `scripts/start-time.mjs`. Add a package that the host needs at run time to
  `devDependencies`, because the bundle holds it.
  `[test: build.mjs fails on a bundled package without a licence file; pack-check.mjs fails when the package installs a dependency]`
- Parse the config only in `parseConfig` (`src/core/config.ts`). The host trusts a `Config`. Each error names the
  key it is about. `[test: server.test.ts]`
- stdout carries only MCP JSON-RPC. Log to stderr with `console.error`.
  `[test: code.check.mjs fails on a stdout write in src/host; tsc fails on console in src/core; server.e2e.mjs reads every stdout line]`
- A failed downstream server must not stop the others. `connectAll` catches each failure and keeps the server as
  failed. `[test: server.e2e.mjs]`
- A failed or closed server connects again on next use: a search, or a call of a program. All callers wait for one
  attempt, at most 3 attempts in 60 s, and none after `close`. `[test: downstream.test.ts, server.e2e.mjs]`
- The SDK HTTP client transport fires `onclose` only from `close()`. So an HTTP link fails in `HttpTransport.send`
  (`src/host/downstream.ts`), before the request rejects, when the request finds the server unreachable or the
  session unknown: a 404 to a request with a session id, or a 400 with an SDK session text. Any other 400 fails only
  its call. Never end a link in `client.onerror`: it also gets the errors of the optional GET stream, and a server
  without GET answers 400 or 404 there. `[test: downstream.test.ts, describe http]`
- Every nested call has the time limit `sandbox.callTimeoutSeconds`, through the SDK's `timeout`, so the SDK sends
  `notifications/cancelled` when it ends. `[test: server.e2e.mjs, case run (l)]`
- The running server never opens a browser, registers an OAuth client or starts a login: its provider in
  `src/host/oauth.ts` throws `LoginNeeded` at each of these steps, and the link fails with the login command as its
  reason. Only `toolscript-mcp login` does them. The provider answers each refresh in its `fetch`: a 4xx other than
  408 and 429 is a refusal and throws `LoginNeeded`. No answer, none within `REFRESH_TIMEOUT_MS`, a 5xx, 408 or 429 throws `RefreshFailed`: the tokens
  stay, and the next use tries again. One refresh of a store file runs at a time in a process (`refreshes`): a
  rotating refresh token works once, so every other caller waits for that refresh and gets its tokens. Across
  processes, a refresh holds `<store>.lock` (`src/host/oauthlock.ts`, made with `wx`, in the `oauth` folder, never a
  secret in it). It reads the store again after it takes the lock, and returns the tokens of the winner when the store
  holds a refresh token other than the one it holds, or an access token that no server refused in this process. The
  lock wait and the request share `refreshTimeoutMs`. A waiter that gets the lock with less than half of that time
  left, and no new tokens in the store, sends no request. A lock is stale when its pid is dead, or when it is older than
  the refresh time plus the rename wait plus a margin. Only the waiter that makes the claim file of a stale lock removes
  it. `login` takes no lock. A lock that cannot be made (a full disk) lets the refresh run without it. Both are an `OAuthError`, so the SDK passes them on and starts no login.
  A refresh saves its tokens only when the store still holds the refresh token that it held when the refresh started: a login in
  another process can save during the refresh, and then the refresh leaves the store to that login. A login that
  saves between the read and the rename of the refresh is still lost. No log line, printed line, reason or nested-call error holds a token, code,
  verifier or client secret: each downstream error goes through the `hide` of its link, which passes the secrets of
  the provider to `redact`. `[test: oauth.test.ts, server.e2e.mjs case (p)]`
- `src/host/launch.ts` holds the sandbox layers of each OS in `SANDBOXES`. To add or change a layer, change it there
  and in the sandbox table of `docs/sandbox.md`. `[test: runner.integration.mjs checks each layer that LAYERS names]`
- Imports between files use the `.ts` extension, so Node can run the sources and `tsc` rewrites them. Use only
  syntax that Node can strip: no enums, no parameter properties, no namespaces. `[test: tsc, erasableSyntaxOnly]`
- Make each path into `.toolscript-mcp` with a helper from `src/core/paths.ts`: `hintsFolder`, `functionsFolder`,
  `shapesFile` or `appPath`. `[test: code.check.mjs]`
- The learned shapes file and the tool lists of lazy servers (`learned/tools.json`) are alone in their folder, which
  `guardedDirs` lists. The tool lists are for display only: no policy decision, approval prompt, argument check or
  `requiresUserInteraction` check reads them, and only a hash of the launch is on disk. `[test: lazy.test.ts, run.test.ts]`
  Read the shapes file as written by an attacker:
  an entry loads only when `isLearnedShape` accepts its shape. Never widen that grammar to free text. A run that read
  untrusted content saves no shape. `[test: code-mode.test.ts, run.test.ts, shapes.test.ts]`
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
  before the run passed: a tool name built at run time is never asked, while a name in a plain string (`mentionedTools`)
  is asked before the run when the client can ask. A deny rule that matches such a name refuses only its call, at call
  time. `[test: run.test.ts and server.e2e.mjs, case (e)]`
- A deny rule refuses a nested call first, and the call sends nothing to its server, not even a list for a miss. A
  nested call of a name that its connected server does not list is refused (`listedNames` in
  `src/core/catalog.ts`), before the other policy checks, so the refusal offers no rule for a name that cannot run. A miss
  first lists the server again, at most one time in 10 s (`downstream.relist`). Rules and marks match listed names,
  and a server can answer a name in another case.
  `[test: run.test.ts]`
- A tool whose server sets `_meta["anthropic/requiresUserInteraction"]` to `true` needs the person's approval before
  each run, also under an allow rule: `planRun` asks for it and `checkCall` refuses it unless approved. `checkCall` runs
  on the list that `downstream.client` returns: the list after the last `tools/list_changed` of the server. The
  lists of a server are in `startLists` (`src/host/downstream.ts`): one at a time, `LIST_FLOOR_MS` apart, and more
  than `MAX_CHANGES` lists for a change in `CHANGE_WINDOW_MS` fail the link. Every wait for a connect or a list ends
  at `RETRY_WAIT_MS` or at the abort of the caller's signal. A call with no list after the last change is refused,
  and a list that fails fails the link. So no call uses a list that can lack a new mark.
  `[test: run.test.ts and server.e2e.mjs, cases run (q) and run (r)]`
- A program can write the config file through a tool. So a policy read at a run applies at once only when
  `onlyTightens` (`src/core/policy.ts`) says it comes from the policy in force by inserted deny rules, removed allow
  rules and actions lowered in place. Decide it from the rules and the bridges alone: a check that tries tool names
  misses a name that a rule shadows or that no server lists. Any other change applies only after the person approves
  it, or at a restart. `[test: policy.test.ts and server.e2e.mjs, cases run (m), run (n) and run (o)]`
- A bridge serves the client's own tools, such as Claude Code with `claude mcp serve`, and a program that calls them
  skips the client's permission rules and hooks. `parseConfig` finds the bridges (`isBridge` in `src/core/config.ts`):
  the key `claude-code`, or a stdio entry whose words, each argument split at its spaces, shell operators and commas, with
quotes and the `^` of cmd dropped, hold the
  Claude Code word (`CLAUDE`), then `mcp`, then `serve`, with any words between. One pass over the words: a config can
  hold a long hostile command line, so never rescan the words from each word. `main.ts` logs the bridges at start. Add a launch form
  there and to the list in `docs/claude-code-bridge.md`, and keep the docs saying to use the key `claude-code` for any other. An allow rule allows a tool of a bridge only when its match starts with
  `mcp__<key>__` (`counts` in `src/core/policy.ts`). Never keep a list of the tools of a bridge: a later version adds
  tools. `[test: policy.test.ts and run.test.ts]`
- `guardedDirs` is enforced at each nested call (`callTool` in `src/host/run.ts`, `src/core/guard.ts`), after the
  policy check and before the call leaves for its server, for every server and with no list of tool names. A string in
  the arguments is refused when its path, or its real path (`realpath` of the deepest part that exists), is in a
  guarded folder, or when it holds a marker (`GUARD_MARKERS`) at a name boundary. No allow rule or approval lifts it.
  The log code is `guarded`, and the refusal text (`guardedText`) never holds the argument. Keep the caps: depth 16,
  4096 characters for a path candidate (the text check reads a string of any length), 16 `realpath` calls for a call, 32 parent steps, and no file system call for a call with no path
  candidate. A path under `files/`, the run log and the config must never be refused.
  `[test: guard.test.ts and run.test.ts, describe the guarded folders]`
- A command that the CLI prints for a person or an agent to run (init, tools, allow) holds a name from a client file
  or a server only when it fits `PLAIN_NAME`, and a path only when it fits `PLAIN_PATH` (`src/core/commands.ts`). Any
  other name or path gets no command, and the text says why. Never quote a hostile word for the shells instead: a
  person pastes a command into any shell, and two rounds of quoting rules each failed a review. Each command is alone
  on its line, indented by 4 spaces, and starts with `node`, `npx`, `claude` or `pushd`. Each label line starts with
  `- `, so it never reads as a command. A skill runs only such printed lines, exactly as printed, and never types a
  name from a file or a server into a command. `[test: init.test.ts and allow.test.ts, the printed commands in each shell]`
- The built-in Workspace (issue #144, `docs/adr/0144-workspace-provider.md`) shows no byte and no name that did not
  come through a proven handle: an open file or folder that is shown to be inside the root, with no link on the way.
  Open and read only through `src/host/workspace/confined.ts`. Never open a path by name after a check that came before.
  `pathParts` checks the text of a path before any file system call, and the exclusions match the real spelling, with no
  regard to case, after NFC. The first use tests the method of the OS, and a failed test makes Workspace unavailable with
  a reason in our own text that holds no path. The tools read the section of the config one time, at the start. Its
  results are untrusted (`"untrusted": true` on its entry), and its read tools run with no rule only while the section
  is present (`Guards.workspace`). A tool is one entry of `WORKSPACE_TOOLS` and one handler in `provider.ts`.
  Client roots (issue #150) only narrow the bound root and never widen it. The server reads them one time, after the
  client initialized, and the provider is bound after that: no call runs on a wider root. `roots.ts` and `bind.ts` prove
  each entry, and a late answer or `list_changed` changes nothing. The `.gitignore` of the root is discovery only: `list`
  and `search` leave out its names, an exclusion and `skip` decide first, and no other tool reads it. Never use it as
  access control. The matcher in `src/core/ignore.ts` builds no regular expression from the file and is not the matcher
  of the exclusions.
  `[test: workspace.test.ts, workspace-fs.test.ts (swap hook patterns for every lookup), workspace-roots.test.ts, workspace-roots-fs.test.ts, workspace-ignore.test.ts, workspace-ignore-fs.test.ts, run.test.ts describe workspace, workspace.e2e.mjs]`
- A named task of the Workspace (`run_task`, `src/host/workspace/task.ts`) is a fixed program, argument list, folder and
  environment from the config: the model sends only the name. The spawn is `node:child_process` with no `shell` and never
  `cross-spawn`, which starts `cmd.exe` for a `.cmd` file, so on Windows a command that is not an `.exe` or `.com` file
  makes the task invalid. The child gets the variables of `TASK_ENV_NAMES` and the `env` of the task, never any other
  variable of the server. A task ends with its process tree however it ends (exit, time limit, cancel, shutdown, hard
  kill of the server), through a helper of the OS (`src/host/taskjob.ts`, ADR 0144): a Job Object on Windows, a perl
  subreaper on Linux, a search on macOS. No value of a task is ever part of PowerShell source, of a command line of
  `powershell.exe` or of the environment of a helper: it is a frame on standard input or on the socket. The host decides
  from the reports after the channel ended, and the direct spawn takes a call only before `begin`, so a task never runs
  two times. When no helper can run, the direct spawn ends the task with one note on stderr. One task runs at a time. A
  task is not contained, and no text may claim it is. `run_task` is the exec
  class: only an allow rule with its exact name allows it (`counts` and `onlyTightens` in `src/core/policy.ts`), and the
  prompt names the tasks and says that a task runs project code with the rights of the user.
  `[test: workspace-task.test.ts (argv, environment, argumentLine, the report grammar and decision, pids gone after a timeout, a cancel, a shutdown, a normal exit and a hard kill of the server, the orphan case, the fallback of a failed helper), workspace.test.ts, run.test.ts describe run_task, workspace.e2e.mjs]`
- The change tools of the Workspace (`edit`, `write`, class `write`) are listed only with `"write": true`, and their
  handlers refuse without it. They write only through `confined.ts` (Linux: a temp file and a rename in the held folder,
  Windows and macOS: in place through the proven handle). A change takes the lock of its file first (`write.ts`), checks
  the hash of the bytes that it read, and drops the lock after a failed or cancelled call. Each `old` is matched against
  the file as read, and the new bytes differ from the old only in the replaced ranges. No log holds file content, `old` or
  `new` text, or a diff: the run log has the relative path and the line counts of an applied change. An allow rule allows
  a change tool only when its match starts with `mcp__workspace__` (`needs` in `src/core/policy.ts`).
  `[test: workspace.test.ts, workspace-write.test.ts, workspace-lock.test.ts, run.test.ts describe workspace, runlog.test.ts, workspace.e2e.mjs]`
- Every run removes its exchange dir, also after a timeout, a kill or a shutdown.
  `[test: run.test.ts and server.e2e.mjs check the temp dir after the runs]`
- Never weaken a sandbox layer, the policy check, the guard of hint and function files or the approval of proposals
  to make a test pass. Each one is a safety rule.

## Tests and commits
- The checks:
  - `npm test`: the pure-core tests and `tests/run.test.ts`, which runs `run_code` with the real sandbox
    (`tests/*.test.ts`, `node:test`).
  - `npm run typecheck`: `tsc` with the pinned TypeScript. `npm run build` runs it, then `scripts/build.mjs`.
  - `npm run check`: `tests/docs.check.mjs` (the doc rules below) and `tests/code.check.mjs` (the code rules).
  - `node tests/runner.integration.mjs`: the real sandbox under Node, on Linux, macOS and Windows.
  - `node tests/server.e2e.mjs`: the built server over stdio, with the bench fake server and a probe server. Run
    `npm run build` first.
  - `sh scripts/format.sh --check .`: the format of code, JSON and YAML.
- CI (`.github/workflows/test.yml`) runs the sandbox test and the server test on Linux, macOS and Windows. Linux and macOS each have
  a network block (`unshare -rn` on Linux, `sandbox-exec` on macOS). `EXPECT_NETWORK_BLOCK` makes the test fail
  where neither works. On Windows the test checks that the network block is absent. The Linux legs of the job `test` mount a
  vfat image and set `TOOLSCRIPT_TEST_ALIAS_DIR`, so the alias test of `tests/workspace-fs.test.ts` runs there.
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
User docs are `README.md`, `FAQ.md`, every `docs/*.md` page (not `docs/adr/`) and the four skills `plugin/skills/setup/SKILL.md`, `plugin/skills/start/SKILL.md`, `plugin/skills/doctor/SKILL.md` and `plugin/skills/workspace/SKILL.md`. Out of this set: `AGENTS.md`, this file and the model-facing text above.
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
