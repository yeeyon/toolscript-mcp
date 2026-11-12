# toolscript-mcp

A standalone MCP server in progress (pre-release): the model writes one JavaScript program that calls the tools of
other MCP servers in a sandbox, and only the return value goes back into the context. It is derived from the MIT
project claude-code-mode (see `NOTICE`). The server itself is not written yet.

## Layout
- `src/core/` holds the pure helpers, with no Node modules and no host types: `protocol.ts` (runner protocol,
  results, search), `hints.ts` (hint files and matching), `functions.ts` (saved functions), `paths.ts` (folders and
  guarded ones), `tools.ts` (the tool table). Imports between them use `.ts` extensions.
- `src/host/` holds the host code, which runs in Node: `launch.ts` (starts the runner with the sandbox layers of
  each OS, the host kill timer and the exchange dir). It builds with `tsconfig.host.json`.
- `runtime/runner.mjs` is the sandbox. Node built-ins only.
- `hints/` holds the bundled hints and `hints/sha256.json`. `bench/` holds the output projection bench.
- `tests/*.test.ts` run with `node:test`. `tests/*.check.mjs` and `tests/runner.integration.mjs` are plain Node.

## How to test
- `npm test`, `npm run typecheck`, `npm run build`, `npm run check`.
- `node tests/runner.integration.mjs` runs the real sandbox on Linux, macOS and Windows.
- After a change to a bundled hint, run `node scripts/bundled-hints.mjs`.

## Rules
- Read `CODING_STANDARDS.md` before a change to code, tests or model-facing text.
- Never weaken a sandbox layer to make a test pass.
