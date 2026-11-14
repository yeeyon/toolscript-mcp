# Changelog

## 0.1.0

The first release on npm. Install it with `npx -y toolscript-mcp --config <path>`. toolscript-mcp is derived from claude-code-mode by Gabriele Pavanello at commit eea4077 (MIT).

The package skeleton:

- Moved the pure core (`protocol`, `hints`, `functions`, `paths`, `tools`) to `src/core/`. Relative imports use `.ts` extensions.
- Removed the Claude Code plugin parts: the engine module, manifest, session hook, generated types, docs, risk tooling, issue templates and the e2e smoke test.
- Ported the tests of the pure core to `node:test` (74 tests). Dropped the tests that need the plugin engine.
- Added `package.json`, one `tsconfig.json` that builds to `dist/`, `.gitattributes`, `NOTICE` and a second copyright line in `LICENSE`.
- Rewrote the README, SECURITY, CONTRIBUTING, AGENTS and CODING_STANDARDS files, and the CI workflow.

The sandbox launcher:

- Added `src/host/launch.ts`: it starts the runner on Linux, macOS and Windows, with a host kill timer on every system. Windows gets Node `--permission` and an environment with only `SYSTEMROOT`. The exchange dir is made and removed in Node, not with `mktemp` and `rm`.
- `tests/runner.integration.mjs` runs the real launcher, also on Windows in CI, and checks that a layer a system does not have is absent.
- The time limit of the runner and the host kill timer both count from the launch. On a busy machine where Node starts slowly, a run at the limit still reports its timeout and its console lines.

The first server (M3):

- Added the `toolscript-mcp` command (`dist/host/main.js`), an MCP server over stdio, with `search_tools`.
- Added `@modelcontextprotocol/sdk` 1.32.2 (MIT), the first runtime dependency.
- Added the config file: the `mcpServers` shape of Claude Desktop and Claude Code, with stdio and HTTP servers, `${VAR}` expansion and `sandbox.node`. It is found with `--config`, `TOOLSCRIPT_CONFIG` or a per-user default.
- The server connects to all downstream servers in parallel. A failed server shows in `search_tools` with its reason, and the others still work. The reason hides the `env` and `headers` values of that server. It also hides the secrets in the args or the URL of that server.
- `search_tools` waits at most 10 seconds after the start for servers that are still connecting, and then shows them as connecting. A server whose connection closes later shows as failed until it connects again.
- A stdio child gets only its config `env` and the SDK's short list of system variables, and `TOOLSCRIPT_MCP_DEPTH`. A copy of toolscript-mcp that sees this variable refuses to start.
- The state folder is `.toolscript-mcp`, not `.claude/code-mode`. Model-facing text no longer names `ToolSearch`, `~/.claude/settings.json` or tools that the server does not list. The tool ids are `mcp__toolscript__<tool>`.
- `tests/code.check.mjs` fails on a stdout write in `src/host`. `tests/server.e2e.mjs` runs the built server in CI on Linux, macOS and Windows.

`run_code` and the policy (M4):

- Added `run_code`. It runs one program in the sandbox and answers its nested calls through the downstream connections, at most 8 at a time. The server now lists `run_code` and `search_tools`.
- Before a sandbox starts, the tool and argument names of the literal `call("…")`s are checked against the connected tools and their input schemas. A wrong name never starts a sandbox.
- Added the `policy` config: ordered rules `{ "match": "<glob>", "action": "allow" | "deny" | "ask" }` over `mcp__<server>__<tool>`. The first match wins, and the default is `ask`. Each error names the rule, as `policy[2].action`.
- A deny rule on a literal tool name refuses the run and names the rule. `ask` asks the person one time per run with MCP elicitation, and the answer covers that run only. A client without elicitation, or a decline, gets a refusal that names the allow rule to add.
- Each nested call is checked again at call time. A tool name built at run time runs only with an allow rule. A refusal is an error that the program can catch.
- Added `sandbox.timeoutSeconds` (5 to 86400, default 120). On Windows, a bare `sandbox.node` is refused, because the sandbox has no `PATH`.
- `saveFile` writes in `~/.toolscript-mcp/files/<session>/` (mode 0700 and 0600), and `readFile` reads only those files. `recall(n)` and output projection work as in the plugin. `resources()` and `readResource()` answer that they are not available.
- A run in flight when the server shuts down, or whose call the client cancels, gets its sandbox killed and its exchange dir removed. A busy loop ends at the limit, and the server stays usable. A SIGKILL from the CPU limit (Linux sets the soft and the hard limit to one value) reads as the time limit.
- A reply file that cannot be written stops the run at once with the reason, not at the time limit, and never as an unhandled rejection.
- A policy glob matches with no regular expression: `*` also matches a line break, and a long tool name that a program builds cannot stall the server.
- `approvalNote` moved to `src/core/policy.ts` and names the rule to add in the config. The check before a run no longer says that a deny rule hides a tool.
- `normalizePath` keeps a Windows drive, so `appPath` works with a Windows home folder.
- `tests/run.test.ts` runs `run_code` with the real sandbox and fake servers: the run_code, files, check, output projection and approval cases of the plugin that apply. `tests/policy.test.ts` covers the rules and the config. `tests/server.e2e.mjs` covers paging, deny, ask with and without elicitation, a name built at run time, a busy loop, a wrong name, a secret probe, a cut result with recall, and the cleanup of the exchange dir.

The bench:

- `bench/run.mjs` compares two arms in headless Claude Code: the fake server's tools called directly, and the same server behind toolscript-mcp. It records correctness, cost, the token kinds, turns, wall time and the calls of each run, and prints the median and range per arm and per task. Removed the plugin-only parts and `scripts/projection-report.mjs`.
- `bench/forget.mjs` removes only the Claude Code project folder of each run's temp cwd, where Claude Code saves a large MCP result.
- `bench/RESULTS.md` holds the first measurement with Haiku 5.5 and its limits.

The release:

- `.github/workflows/release.yml` publishes the version in `package.json` to npm with provenance, then tags the commit and makes the GitHub release with the tarball. It runs every job of `test.yml` first. A read-only job builds and checks the tarball, and the publish job uploads only that tarball. A rerun skips the steps that are done, and fails when npm holds a different tarball for the version.
- `scripts/pack-check.mjs` packs the package, checks its file list, installs the tarball in an empty folder and runs `tests/server.e2e.mjs` against the installed command. CI runs it on Linux, macOS and Windows.
- The README has install lines for Claude Code, Claude Desktop, Cursor and Codex, a Limits section and a comparison with Claude Code Code Mode.
- `bench/run.mjs` answers `--help` and refuses an unknown flag before any run, so neither spends money.
- The build bundles the host code and the SDK into one file, `dist/host/main.js`, with esbuild. The package has no runtime dependency, so an install adds 1 package instead of 96. On Windows the time from the spawn to the `tools/list` reply went from 423 ms to 232 ms (median of 40 starts), and from 631 ms to 294 ms on the first start after an install (10 starts). `dist/third-party-licenses.txt` holds the licences of the bundled packages. `scripts/start-time.mjs` measures the start.

Setup and configuration:

- Added `toolscript-mcp init`. It imports the user-scope MCP servers of Claude Code, Claude Desktop and Cursor into a new config (mode 0600, written through a temp file), and prints the lines to change in each client. It never edits a client file. `--dry-run` writes nothing. It hides env and header values, and the user, password, query values, fragment and long random path segments of URLs. It also hides the value of an argument whose name holds key, token, secret, pass, auth, bearer, header or credential, the word after Bearer or Basic, and an argument that is one long random word. Other arguments show as they are. The printed commands quote each word, so nothing in a name or path expands in the shell.
- `--force` keeps the old config as `<config>.bak` (mode 0600) and lists the top-level keys and servers that the new config leaves out or changes.
- A server entry with an error, for example an unset `${VAR}`, fails alone. The other servers start, and `search_tools` shows the error. An error outside `mcpServers` still stops the start.
- `run_code` reads `policy` from the config file at each run. A config with errors keeps the last valid policy, and the result says so.
- A stricter policy from the config file applies at once. A policy that lets a tool run with less approval applies only after the person approves it in a prompt, or after a restart when the client cannot ask. So a program that writes the config through an allowed tool cannot loosen its own policy. Each applied change logs one line to stderr and adds a note to the result of the run.
- `npm pack` and `npm publish` build `dist/` first (`prepack`).

Downstream servers:

- A server that failed to connect, or whose connection closed, connects again on the next `search_tools` or call. At most 3 attempts per server in 60 seconds. Concurrent callers share one attempt.
- Added `sandbox.callTimeoutSeconds` (1 to `sandbox.timeoutSeconds`, default 60, or `sandbox.timeoutSeconds` when that is shorter). A call past it throws an error that the program can catch, and the server gets `notifications/cancelled`.
- The end of a run no longer sends `notifications/cancelled` for calls that already finished.
- An HTTP server that restarts, or loses the session, no longer fails every later call until toolscript-mcp restarts. The first call that finds the server unreachable, or the session unknown (HTTP 400 or 404), fails, and the next use connects again.
- An HTTP `url` that does not parse, also after `${VAR}` expansion, fails only its entry. It no longer stops toolscript-mcp at the start. The error names the key, not the URL.

Tool search:

- `search_tools` shows each of 3 or fewer matches in full: the description and a TypeScript declaration of `call()` with nested object types, enums, unions, local `$ref`s and the note of each argument. A tool with an `outputSchema` gets a `Promise<…>` result type. Without one, the search shows the shape of a result from an earlier run in the session (`returned earlier:`). 4 or more matches keep the one-line list.
- The check before a run gives the state and the reason of a server that failed or is still connecting. It no longer guesses a tool of another server.
- The declaration has a work budget, so a recursive schema cannot stall the server. A literal is never cut.
- A declaration too large with its notes shows again without its notes and its result type. Required arguments come first.
- The one-line list keeps whole arguments up to 500 characters and ends with `… N more arguments`. A required argument shows whenever any argument shows.
- An empty `enum` shows as `never`, and an empty `type` list shows as `unknown`.
- The check before a run accepts the argument names that other keys next to the properties can add: `allOf`, `anyOf`, `oneOf`, `patternProperties`, `if`, `then`, `else`, `dependentSchemas`, `dependencies` and `$ref`.

Run log:

- Each `run_code` call appends one JSON line to `~/.toolscript-mcp/runs.jsonl`: time, run id, duration, ending, result size, and per call the tool name, policy decision, duration and a short error code. Never arguments, results, program text or error messages. It rotates to `runs.1.jsonl` at 5 MB. `"log": false` turns it off.
- The run log keeps the tool name of a call whose server closed during the run. Before, the log named that call `unknown`.
- The run log shows the ending `timeout` only when a time limit stopped the run.
- The run log keeps the entry of a call whose reply came after the end of the run.
- The run log of a refused run lists each call that has a literal tool name, with its policy decision, `ok: false` and 0 ms.
- A program that changes `Array.prototype.toJSON` or `JSON.stringify` now gets its result instead of "the sandbox exited without a result".

Runner fixes (inherited from claude-code-mode at eea4077):

- A failed call that the program awaits later no longer crashes the sandbox.
- After the result, the runner gives no more answers to the program, so a looping callback cannot block the result (upstream #71).
- A timeout keeps the console lines collected so far.
- A cut result never splits a surrogate pair.
- The "calls returned data" note counts only results that hold data.
- Sizes and ages round before the unit is picked (upstream #82).
- `call(tool, "text")` throws a catchable error. A return value with a cycle or a BigInt is an error, not `"[object Object]"`.
