# Changelog

## Unreleased

toolscript-mcp is derived from claude-code-mode by Gabriele Pavanello at commit eea4077 (MIT).

The package skeleton:

- Moved the pure core (`protocol`, `hints`, `functions`, `paths`, `tools`) to `src/core/`. Relative imports use `.ts` extensions.
- Removed the Claude Code plugin parts: the engine module, manifest, session hook, generated types, docs, risk tooling, issue templates and the e2e smoke test.
- Ported the tests of the pure core to `node:test` (74 tests). Dropped the tests that need the plugin engine.
- Added `package.json` (private, 0.0.0), one `tsconfig.json` that builds to `dist/`, `.gitattributes`, `NOTICE` and a second copyright line in `LICENSE`.
- Rewrote the README, SECURITY, CONTRIBUTING, AGENTS and CODING_STANDARDS files, and the CI workflow.

The sandbox launcher:

- Added `src/host/launch.ts`: it starts the runner on Linux, macOS and Windows, with a host kill timer on every system. Windows gets Node `--permission` and an environment with only `SYSTEMROOT`. The exchange dir is made and removed in Node, not with `mktemp` and `rm`.
- `tests/runner.integration.mjs` runs the real launcher, also on Windows in CI, and checks that a layer a system does not have is absent.

The first server (M3):

- Added the `toolscript-mcp` command (`dist/host/main.js`), an MCP server over stdio. It lists one tool, `search_tools`. `run_code` comes in M4.
- Added `@modelcontextprotocol/sdk` 1.32.2 (MIT), the first runtime dependency.
- Added the config file: the `mcpServers` shape of Claude Desktop and Claude Code, with stdio and HTTP servers, `${VAR}` expansion and `sandbox.node`. It is found with `--config`, `TOOLSCRIPT_CONFIG` or a per-user default.
- The server connects to all downstream servers in parallel. A failed server shows in `search_tools` with its reason, and the others still work. The reason hides the `env` and `headers` values of that server.
- `search_tools` waits at most 10 seconds after the start for servers that are still connecting, and then shows them as connecting. A server whose connection closes later shows as failed.
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
