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
- The server connects to all downstream servers in parallel. A failed server shows in `search_tools` with its reason, and the others still work. The reason hides the secrets that the rules of `init --dry-run` find in the args or the URL of that server, also as the URL parser encodes them, and the user and password of any URL. It also hides each `env` and `headers` value of that server whose name or form looks secret, or that has 12 or more characters. In both cases a number of fewer than 12 digits stays, and a short word of letters only is hidden only as a whole word, so `localhost:3000` stays readable.
- `search_tools` waits at most 10 seconds after the start for servers that are still connecting, and then shows them as connecting. A server whose connection closes later shows as failed until it connects again.
- A stdio child gets only its config `env` and the SDK's short list of system variables, and `TOOLSCRIPT_MCP_DEPTH`. A copy of toolscript-mcp that sees this variable refuses to start.
- The state folder is `.toolscript-mcp`, not `.claude/code-mode`. Model-facing text no longer names `ToolSearch`, `~/.claude/settings.json` or tools that the server does not list. The tool ids are `mcp__toolscript__<tool>`.
- `tests/code.check.mjs` fails on a stdout write in `src/host`. `tests/server.e2e.mjs` runs the built server in CI on Linux, macOS and Windows.

`run_code` and the policy (M4):

- Added `run_code`. It runs one program in the sandbox and answers its nested calls through the downstream connections, at most 8 at a time. The server now lists `run_code` and `search_tools`.
- Before a sandbox starts, the tool and argument names of the literal `call("…")`s are checked against the connected tools and their input schemas. A wrong name never starts a sandbox.
- Added the `policy` config: ordered rules `{ "match": "<glob>", "action": "allow" | "deny" | "ask" }` over `mcp__<server>__<tool>`. The first match wins, and the default is `ask`. Each error names the rule, as `policy[2].action`.
- A deny rule on a literal tool name refuses the run and names the rule. `ask` asks the person one time per run with MCP elicitation, and the answer covers that run only. A client without elicitation, or a decline, gets a refusal that names the allow rule to add.
- Each nested call is checked again at call time. A tool name built at run time runs only with an allow rule. A name that its connected server does not list is refused before the policy check, also when the server answers it, and the run log records it as `invalid`. A refusal is an error that the program can catch.
- A downstream tool with `_meta["anthropic/requiresUserInteraction"]` set to `true` needs the person's approval before each run that calls it, also under an allow rule (#35). A deny rule still denies it. Without elicitation, or with a tool name built at run time, the call is refused. `search_tools` shows the mark. A server that sends `notifications/tools/list_changed` is listed again. One list of a server runs at a time, and a change during a list lists once more at its end. So a storm of notifications costs two lists. A run and each nested call wait for a list in flight. A list that fails fails the server, so the next use connects again and lists anew. The README says that Claude Code rules and hooks do not apply to nested calls.
- Added `sandbox.timeoutSeconds` (5 to 86400, default 120). On Windows, a bare `sandbox.node` is refused, because the sandbox has no `PATH`.
- `saveFile` writes in `~/.toolscript-mcp/files/<session>/` (mode 0700 and 0600), and `readFile` reads only those files. `recall(n)` and output projection work as in the plugin. `resources()` and `readResource()` answer that they are not available.
- A run in flight when the server shuts down, or whose call the client cancels, gets its sandbox killed and its exchange dir removed. A busy loop ends at the limit, and the server stays usable. A SIGKILL from the CPU limit (Linux sets the soft and the hard limit to one value) reads as the time limit.
- A reply file that cannot be written stops the run at once with the reason, not at the time limit, and never as an unhandled rejection.
- A policy glob matches with no regular expression: `*` also matches a line break, and a long tool name that a program builds cannot stall the server.
- `approvalNote` moved to `src/core/policy.ts` and names the rule to add in the config. The check before a run no longer says that a deny rule hides a tool.
- `normalizePath` keeps a Windows drive, so `appPath` works with a Windows home folder.
- A return value cut at 20,000 characters now shows its shape first, then the first 3,000 characters as compact JSON, then the `recall(n)` note. Before, it showed 20,000 characters of indented JSON and the shape came after the cut. A 71k-character result now takes 3,414 characters, not 20,342.
- Each kept call in the footer names its handle, as `#1 mcp__bench__get_deploys 71k {…} -> await recall(1)`. The handle carries `await`, because the model copies it as written: in real use, `recall(n)` without `await` gave a Promise and failed the next program. The `run_code` description lists `recall(n)`. In the bench, 5 of 9 second programs called the same tool again instead of `recall(n)`.
- `tests/run.test.ts` runs `run_code` with the real sandbox and fake servers: the run_code, files, check, output projection and approval cases of the plugin that apply. `tests/policy.test.ts` covers the rules and the config. `tests/server.e2e.mjs` covers paging, deny, ask with and without elicitation, a name built at run time, a busy loop, a wrong name, a secret probe, a cut result with recall, and the cleanup of the exchange dir.

The bench:

- `bench/run.mjs` compares two arms in headless Claude Code: the fake server's tools called directly, and the same server behind toolscript-mcp. It records correctness, cost, the token kinds, turns, wall time and the calls of each run, and prints the median and range per arm and per task. Removed the plugin-only parts and `scripts/projection-report.mjs`.
- `bench/forget.mjs` removes only the Claude Code project folder of each run's temp cwd, where Claude Code saves a large MCP result.
- `bench/RESULTS.md` holds the first measurement with Haiku 5.5 and its limits.
- `bench/interactive.mjs` compares three arms in interactive Claude Code: direct calls, Claude Code Code Mode and toolscript-mcp. It drives the TUI through node-pty, stops before a run that the estimate puts past `--max-spend`, and counts the saved runs of a resumed `--out`. It refuses a spend flag that is not a number of dollars and a model with no price before any run, and saves the cost of a run that fails.
- `bench/RESULTS-codemode.md` holds that comparison with Sonnet 5.5 (2026-11-14, 54 runs).
- `bench/CODEX.md` is the test plan for the same three arms in Codex.
- `bench/check.mjs` judges one answer of another agent with the check of `bench/run.mjs`.
- `bench/spend.mjs` holds the spend cap of `bench/interactive.mjs`: the spend so far and the estimate of the next run.

The release:

- `.github/workflows/release.yml` publishes the version in `package.json` to npm with provenance, then tags the commit and makes the GitHub release with the tarball. It runs every job of `test.yml` first. A read-only job builds and checks the tarball, and the publish job uploads only that tarball. A rerun skips the steps that are done, and fails when npm holds a different tarball for the version.
- `scripts/pack-check.mjs` packs the package, checks its file list, installs the tarball in an empty folder and runs `tests/server.e2e.mjs` against the installed command. CI runs it on Linux, macOS and Windows.
- The README has install lines for Claude Code, Claude Desktop, Cursor and Codex, a Limits section and a comparison with Claude Code Code Mode.
- `bench/run.mjs` answers `--help` and refuses an unknown flag before any run, so neither spends money.
- The build bundles the host code and the SDK into one file, `dist/host/main.js`, with esbuild. The package has no runtime dependency, so an install adds 1 package instead of 96. On Windows the time from the spawn to the `tools/list` reply went from 423 ms to 232 ms (median of 40 starts), and from 631 ms to 294 ms on the first start after an install (10 starts). `dist/third-party-licenses.txt` holds the licences of the bundled packages. `scripts/start-time.mjs` measures the start.

Setup and configuration:

- Added `toolscript-mcp init`. It imports the user-scope MCP servers of Claude Code, Claude Desktop and Cursor into a new config (mode 0600 on Linux and macOS, written through a temp file, which is copied on a file system without hard links), and prints the lines to change in each client. It never edits a client file. `--dry-run` writes nothing. It hides env and header values, and the user, password, query values, bare query parts, fragment and long random path segments of URLs. It also hides the value of an argument whose name holds key, token, secret, pass, pwd, auth, bearer, header, credential, cookie, session or dsn, or the name part pat, sig or sas, also in `Server=db;Password=value`. It hides the value after `-t` or `-p` unless it is a number, a port such as `8080:80`, a path or a scoped package, a secret header value after `-H`, the word after Bearer or Basic, and a long random word, such as a JWT or a base64 key. An argument of several words, such as a `sh -c` script, gets these rules word by word. Other arguments show as they are. The printed commands quote each word, so nothing in a name or path expands in the shell.
- The `--dry-run` rules, and the reasons of `search_tools` with them, also hide each value under a secret key in a JSON argument, also nested, except a label such as `name` or `user`, the password of `user:password` after `-u`, `--user` or `--proxy-user`, also with an empty user, an email or `DOMAIN\name`, the value after an empty `--name=`, the value of the name part pw, and each `;name=value` path value of a URL. A docker user and group after `-u`, such as `1000:1000`, stays.
- `--force` keeps the old config as `<config>.bak` (mode 0600 on Linux and macOS) and lists the top-level keys and servers that the new config leaves out or changes.
- A server entry with an error, for example an unset `${VAR}`, fails alone. The other servers start, and `search_tools` shows the error. An error outside `mcpServers` still stops the start.
- `run_code` reads `policy` from the config file at each run. A config with errors keeps the last valid policy, and the result says so.
- A changed policy from the config file applies at once only when it comes from the policy in force by these steps alone: insert `deny` rules anywhere, remove `allow` rules, and lower the action of a rule in place (`allow` to `ask` or `deny`, `ask` to `deny`, same `match`). No step raises the decision of any tool name, so the check reads the rules alone, never a tool list. Any other change, a new order of the same rules too, applies only after the person approves it in a prompt, or after a restart when the client cannot ask. So a program that writes the config through an allowed tool cannot loosen its own policy, also not with a rule that shadows a new allow, or for a tool that its server does not list. Each applied change logs one line to stderr and adds a note to the result of the run.
- The prompt shows every rule added and removed, uncut, added `allow` and removed `deny` rules first, and says when the other rules changed order. Below that it lists every rule of the new policy in order, with its whole `match`. Each `match` from the file shows as JSON on one line, with every character outside printable ASCII escaped, so a blank or look-alike character shows. The log line and the note of a run cut a `match` at 120 characters and a list at 10 rules. The prompt also says that a declined policy still applies at the next start.
- A declined policy is remembered: while the config file holds it, runs keep the policy in force with a short note and no new prompt. A change of the file asks again. A prompt that fails, times out or gets no answer is asked again at the next run.
- The init report says that a new `allow` rule applies after the person approves it in a prompt, or after a restart when the client cannot ask. Before, it said that a new rule needs no restart. With a client that cannot ask, the note that names the `allow` rule to add also says that the rule applies only after a restart.
- `npm pack` and `npm publish` build `dist/` first (`prepack`). `npm ci` in a clone, and an install from GitHub, build it too (`prepare`). The `beta` workflow moves the `beta` branch to a commit of `main` after every test passes on it.
- The repo is a Claude Code plugin marketplace, `toolscript-mcp`, with one plugin, `toolscript`, and its skill `/toolscript:setup`. Its skill installs or updates the `beta` clone, runs `init`, adds the server with `claude mcp add`, sets the policy, gives the `login` commands and uninstalls. It asks before each change, and it never reads the config: `config.mjs` prints the default config path, shows the servers and the policy without secrets, and replaces the policy or adds a server. `tests/docs.check.mjs` checks the skill text with the README rules. The npm package does not hold the plugin, and `scripts/pack-check.mjs` fails if it does.

Downstream servers:

- A server that failed to connect, or whose connection closed, connects again on the next `search_tools` or call. At most 3 attempts per server in 60 seconds. Concurrent callers share one attempt.
- Added `sandbox.callTimeoutSeconds` (1 to `sandbox.timeoutSeconds`, default 60, or `sandbox.timeoutSeconds` when that is shorter). A call past it throws an error that the program can catch, and the server gets `notifications/cancelled`. A server's own error with the timeout code, such as a failed login in `mcp-remote`, keeps its text.
- The end of a run no longer sends `notifications/cancelled` for calls that already finished.
- An HTTP server that restarts, or loses the session, no longer fails every later call until toolscript-mcp restarts. The first call that finds the server unreachable, or the session unknown, fails, and the next use connects again. A session is unknown after a 404 to a request with a session id, or a 400 with a session error text of the MCP TypeScript SDK. Any other 400 fails only its call. An error of the optional GET stream does not end the session, so a server with only POST /mcp stays connected.
- An HTTP `url` that does not parse, also after `${VAR}` expansion, fails only its entry. It no longer stops toolscript-mcp at the start. The error names the key, not the URL.

OAuth login:

- Added `toolscript-mcp login <server> [--config <path>]`. It logs in to a remote HTTP server with OAuth, with no proxy such as `mcp-remote`. It listens on `127.0.0.1`, opens the browser, checks the state, and connects and counts the tools after the token exchange. An OAuth error without a description, such as a bare `invalid_grant` at the code exchange, prints its error code. The MCP TypeScript SDK does the discovery, the dynamic client registration, PKCE and the refresh.
- login opens only an authorization URL with `https`, or with `http` on `127.0.0.1`, `::1` or `localhost`, and refuses any other before it prints or opens it. A callback with a wrong or no state gets 400, and login waits for the right one. login prints the error of a callback with its control characters, line and paragraph separators and bidi controls escaped.
- An HTTP server without `headers` logs in with OAuth. `"oauth": true` turns it on for a server with other headers, and `"oauth": false` turns it off. `"oauth": { "clientId", "clientSecret", "scopes", "callbackPort" }` sets a client registered by hand, as Google needs. A bad `oauth` entry, an empty `clientSecret`, or `oauth` with an `Authorization` header, fails only its server. `clientSecret` takes `${VAR}`, and a failure reason hides it.
- The `headers` of an HTTP entry go only to the origin of its `url`, never to its authorization server.
- The tokens and the registered client go to `~/.toolscript-mcp/oauth/<server>-<hash of the URL>.json`, written with a rename, mode 0600 in a 0700 folder on Linux and macOS. A new URL needs a new login. A client that login registers goes into the file only with the tokens of that login, so a cancelled login keeps the old client and tokens. When the token endpoint refuses the stored client at the code exchange, login removes it and fails, and the next login registers a new client. Before, each later login failed with "Existing OAuth client information is required". The next login uses the port of the registered redirect URL again. A stored redirect URL that is not `http` on a loopback host is dropped.
- The running server refreshes the tokens and saves them in the store. It never opens a browser, registers a client or starts a login. A server that needs a login fails with a reason that names `npx -y toolscript-mcp login <server>`. So does a server that answers 401 after a refresh, and a stored client of another authorization server. The next search or call after the login connects again, with no restart.
- The calls and links of one server in one process share one refresh: the others wait for it and use its tokens. Before, each call at expiry refreshed, so with three or more calls all but two failed. A refresh without an answer in 20 s fails with "the token endpoint did not answer in 20 s", and the next use tries again. So a token endpoint that never answers does not hold the calls and links that wait for the refresh. A server that rotates refresh tokens and answers after 20 s has used up the old one, so the next use asks for a login.
- When Windows refuses the rename of the store because another reader or writer has the file open, the save tries again for up to 1 s. Refreshed tokens that the store never takes work until toolscript-mcp stops, or until the store gets other tokens, as from a login. stderr gets one line. Before, the refresh lost the new refresh token and asked for a login.
- When another call or process with the same store refreshed a rotating refresh token first, the running server uses the new token from the store and needs no login. It compares the store with the refresh token of the refused request. Before, it compared with the refresh token that any call read last, so a late `invalid_grant` asked for a login. A refresh that gets no answer, a 5xx, 408 or 429 shows "could not refresh the OAuth token", its cause and "No login is needed", and the next use tries again. Any other 4xx of the token endpoint, such as a revoked token or an HTML 403, ends the link and asks for a login. Before, a 4xx without a known OAuth error code showed "could not refresh" on every use, and `invalid_token` or `invalid_request` failed each call with the raw error.
- A log line, a printed line, a `search_tools` reason or an error of a nested call hides each OAuth token, code, verifier, state and client secret that toolscript-mcp sent, also URL- or form-encoded with upper- or lowercase hex digits, escaped as in a JSON string, and as a Basic header value. A token or client secret shorter than 8 characters is not hidden, so a server cannot make a common word a token and blank it in each reason.
- The init report names the imported HTTP servers without headers, and `npx -y toolscript-mcp login <server>` for them.

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
