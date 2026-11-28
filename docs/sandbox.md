# Sandbox and limits

Back to the [documentation index](../README.md#documentation).

## Sandbox

| Layer | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Node `vm` context: no `require`, `process`, `fetch` or file system | Yes | Yes | Yes |
| Node permission model: no file writes, no reads outside the runner, no processes or workers | Yes | Yes | Yes |
| No environment variables from the host | Yes, `env -i` | Yes, `env -i` | Yes, except `SYSTEMROOT` |
| No network access | `unshare -rn`, when the kernel allows it | `sandbox-exec` | No |
| CPU limit | `ulimit -t` | `ulimit -t` | No |
| Wall-clock limit: the host stops the process | Yes | Yes | Yes |

Node does not start on Windows without `SYSTEMROOT`. A busy loop in a program blocks the timer of the runner. Then the
CPU limit or the host stops the process.

The Node `vm` module is not a security boundary by itself. The sandbox limits accidents. It does not contain hostile
code. Read [SECURITY.md](../SECURITY.md).

## Limits

- From 1.0.0, semantic versioning covers the program API (`call()`, `saveFile`, `readFile`, `recall`, `sleep`), the
  CLI commands, the config keys, hint files and saved functions. The run log and `learned/shapes.json` can change in
  a minor release.
- On Windows, the sandbox has no network block and no CPU limit. The host stops the process at the time limit.
- `ask` rules need a client with MCP elicitation. Without it, only tools with `allow` rules and no user-interaction mark can run.
- Elicitation is tested with the client of the MCP TypeScript SDK. It is not yet tested in the user interface of each
  client.
- If an HTTP server restarts or loses the session, one call to it can fail. The next use of the server connects
  again. toolscript-mcp sees a lost session in a 404, or in a 400 with a session error text of the MCP TypeScript
  SDK. If a server answers a lost session with a different 400, restart toolscript-mcp.
- Programs cannot read MCP resources. `resources()` and `readResource()` answer that they are not available.
- A program gets each image, audio or binary resource of a result as a file, not as data. A `run_code` result shows
  at most 4 images. See [Non-text results](configuration.md#non-text-results).
- Each `run_code` call starts a new program. No variables stay between two calls. The files of `saveFile` and the
  results kept for `await recall(n)` stay within the session limits.
- A run ends at `sandbox.timeoutSeconds`. For a longer wait, such as a CI run of 20 minutes, use a background task of
  your client. Then send a program that reads the result.
- The Claude Code bridge starts another process. It adds memory use, and `cwd` does not restrict file or shell access.
- The Codex bench is a [test plan](../bench/CODEX.md). No Codex performance results are published in this repo.
- Workspace reads files, runs the named tasks that you put in the config, and with a write grant changes files. A task is not contained. Its change tools write in place on Windows and macOS. See [Workspace](workspace.md#workspace) and [Named tasks](workspace.md#named-tasks).
