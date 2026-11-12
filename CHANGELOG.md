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
