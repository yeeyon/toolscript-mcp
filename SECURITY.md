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
- The server refuses a nested call when a string in its arguments names a guarded folder: `~/.toolscript-mcp/hints`,
  `functions`, `learned`, `oauth` and `broker`, and the `hints` folder of the project. It checks paths and the text of the
  call, also through `..`, letter case, symlinks, junctions and 8.3 names. No allow rule or approval lifts it. This is
  a net for a confused model and the simple injected program. It is not containment. A shell command that no name
  matches, the native tools of the client, another process, a tool that writes from an id or a URL, a hard link, a
  `..` in the middle of a shell command, a path split across 2 arguments, nesting deeper than 16 levels, a name
  encoded twice, a UNC path to the same machine on Windows and a change between the check and the write pass it. The
  text check reads a string of any length, and a path candidate has at most 4096 characters. So each file in a
  guarded folder is read as written by an attacker.
  A call that reaches a guarded folder in the cases it names is in scope.
- `saveFile` writes only in the session folder under `~/.toolscript-mcp/files/`, and `readFile` reads only files there.
  The files stay after the session, with read access for your user only on Linux and macOS.
- `toolscript-mcp login` writes the OAuth tokens and the registered client of a server to
  `~/.toolscript-mcp/oauth/<server>-<hash>.json`. On Linux and macOS the file has mode 0600 and the folder 0700. On
  Windows the file gets the access rules of your profile folder. A static `clientSecret` stays in the config and does
  not go into this file. The PKCE verifier and the state stay in the memory of the login process. A client that a
  login registers goes into the file only with the tokens of that login. The login callback listens on `127.0.0.1`
  only. It answers a callback with a wrong or no state with 400 and waits for the right one.
- login opens only an authorization URL with `https`, or with `http` on `127.0.0.1`, `::1` or `localhost`. The server
  metadata names this URL, and the browser opener of the system also runs files and other schemes.
- The `headers` of an HTTP entry go only to the origin of its `url`, never to its authorization server.
- No log line, printed line, `search_tools` reason or error of a nested call holds a token, a code, a verifier or a
  client secret, also when a server echoes one. toolscript-mcp hides each one that it sent, and the state, as it is,
  URL- or form-encoded, and as the Basic header value of the client ID and secret. Only the authorization URL that
  login prints for the browser holds the state. A leak of one of them is in scope.
- The running server only reads the store and saves refreshed tokens. It never opens a browser or registers a client.
