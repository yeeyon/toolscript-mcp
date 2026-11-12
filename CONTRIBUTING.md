# Contributing to toolscript-mcp

Small pull requests are welcome.

## Before you start

- Use Node.js 22.13 or later.
- Read [README](README.md) and [CODING_STANDARDS](CODING_STANDARDS.md).

## How to run locally

```bash
npm ci
npm test
npm run typecheck
npm run check
```

`npm run check` runs the doc, code and hint checks. `node tests/runner.integration.mjs` runs the real sandbox. It needs a POSIX system.

## What a pull request needs

- Keep the change small. One problem per pull request.
- Add a test when the change touches behavior.
- Do not add a runtime dependency without a reason.
- Use short sentences. Give a measured number only when you have a method.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Code of conduct

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
