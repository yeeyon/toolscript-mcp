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
