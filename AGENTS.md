# toolscript-mcp

A standalone MCP server in progress (pre-release): the model writes one JavaScript program that calls the tools of
other MCP servers in a sandbox, and only the return value goes back into the context. It is derived from the MIT
project claude-code-mode (see `NOTICE`). The server lists `search_tools` now. `run_code` comes in M4.

## Layout
- `src/core/` holds the pure helpers, with no Node modules and no host types: `protocol.ts` (runner protocol,
  results, search, model-facing text), `hints.ts` (hint files and matching), `functions.ts` (saved functions),
  `paths.ts` (folders and guarded ones), `tools.ts` (the tool table and `SERVED`), `config.ts` (config parse,
  `${VAR}` expansion, config location, self-loop guard), `catalog.ts` (downstream tools and the `search_tools`
  result). Imports between them use `.ts` extensions.
- `src/host/` holds the host code, which runs in Node. It builds with `tsconfig.host.json`.
  - `main.ts`: the `toolscript-mcp` command. It reads the config, starts the server and closes the children.
  - `server.ts`: the SDK `McpServer`, with a handler for each tool in `SERVED`.
  - `downstream.ts`: connects to the servers of the config in parallel. A failed server stays failed.
  - `launch.ts`: starts the runner with the sandbox layers of each OS, the host kill timer and the exchange dir.
- `runtime/runner.mjs` is the sandbox. Node built-ins only.
- `hints/` holds the bundled hints and `hints/sha256.json`. `bench/` holds the output projection bench.
- `tests/*.test.ts` run with `node:test`. `tests/*.check.mjs` and `tests/runner.integration.mjs` are plain Node.

## How to test
- `npm test`, `npm run typecheck`, `npm run build`, `npm run check`.
- `node tests/runner.integration.mjs` runs the real sandbox on Linux, macOS and Windows.
- `node tests/server.e2e.mjs` runs the built server over stdio. Run `npm run build` first.
- After a change to a bundled hint, run `node scripts/bundled-hints.mjs`.

## Rules
- Read `CODING_STANDARDS.md` before a change to code, tests or model-facing text.
- Never weaken a sandbox layer to make a test pass.
- stdout carries only MCP JSON-RPC. Log to stderr.
