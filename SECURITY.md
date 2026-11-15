# Security policy

## Supported versions

Security fixes go into the latest release on npm and on the default branch (`main`). Older versions get no fixes.

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
- The server reads `policy` from the config file again at each run. Do not let any tool that the policy allows write
  the config file, because a program can call that tool to change its own policy. A changed policy applies at once
  only when it comes from the policy in force by these steps alone: insert `deny` rules, remove `allow` rules, and
  lower the action of a rule in place, with the same `match`. No step raises the decision of any tool name, so the
  server compares the rules, not a list of tools. Any other change, a new order of the same rules too, applies only
  after the person approves it in a prompt. If the client cannot ask, it applies only after a restart of
  toolscript-mcp. A declined policy is not asked again until the config file changes. A changed policy that lets a
  tool run with less approval and applies without the person's approval is in scope.
- `saveFile` writes only in the session folder under `~/.toolscript-mcp/files/`, and `readFile` reads only files there.
  The files stay after the session, with read access for your user only on Linux and macOS.
- `toolscript-mcp login` writes the OAuth tokens and the registered client of a server to
  `~/.toolscript-mcp/oauth/<server>-<hash>.json`. On Linux and macOS the file has mode 0600 and the folder 0700. On
  Windows the file gets the access rules of your profile folder. A static `clientSecret` stays in the config and does
  not go into this file. The PKCE verifier and the state stay in the memory of the login process. The login callback
  listens on `127.0.0.1` only, and refuses a callback with a wrong state. No log line, printed line or `search_tools`
  reason holds a token, a code, a verifier or a client secret. A leak of one of them is in scope.
- The running server only reads the store and saves refreshed tokens. It never opens a browser or registers a client.
