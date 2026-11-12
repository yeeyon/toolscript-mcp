# Security policy

## Supported versions

Nothing is released yet. Security fixes go on the default branch (`main`).

## Reporting a vulnerability

Do not open a public GitHub issue for a security problem, for example a sandbox escape, a secret leak or a permission
bypass. Report it privately at
[github.com/yeeyon/toolscript-mcp/security/advisories/new](https://github.com/yeeyon/toolscript-mcp/security/advisories/new).

Include:

- What you found, and how to reproduce it.
- The version, or the commit SHA.
- The operating system (macOS, Linux or Windows) and the Node version, when they matter.

## Scope

- The sandbox runner (`runtime/runner.mjs`) runs a program from the model. The Node `vm` module is not a security
  boundary by itself. The sandbox limits accidents. It does not contain hostile code.
- On Linux, the network block runs only when `unshare -rn` works. On macOS it uses `sandbox-exec`. Windows has no
  network block and no CPU limit.
- On Windows, the sandbox process gets one variable from the host: `SYSTEMROOT`. Node does not start without it.
- On every system, the host stops the sandbox process when the run is longer than its time limit.
- A nested MCP call leaves the sandbox. The server checks each call against the `policy` rules of the config, before
  the run for the tool names the program writes as strings, and again at each call. A way past that check is in scope.
- `saveFile` writes only in the session folder under `~/.toolscript-mcp/files/`, and `readFile` reads only files there.
  The files stay after the session, with read access for your user only on Linux and macOS.
