# Security policy

## Supported versions

Nothing is released yet. Security fixes go on the default branch (`main`).

## Reporting a vulnerability

Do not open a public GitHub issue for a security problem. Examples are a sandbox escape, a secret leak, and a permission bypass.

Report privately through GitHub private vulnerability reporting on yeeyon/toolscript-mcp. Do not open a public issue.

Include:

- What you found, and how to reproduce it.
- The version, or the commit SHA.
- The operating system (macOS, Linux or Windows) and the Node version, when they matter.

## Scope

- The sandbox runner (`runtime/runner.mjs`) runs a program from the model. The Node `vm` module is not a security boundary by itself.
- On Linux, the network block runs only when `unshare -rn` works. On macOS it uses `sandbox-exec`.
- A nested MCP call leaves the sandbox. The host must check each call against its own permission rules.
