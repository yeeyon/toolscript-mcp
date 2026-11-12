# toolscript-mcp

A standalone MCP server for code mode. The model writes one JavaScript program that calls the tools of your other MCP
servers in a sandbox. The program filters and joins the data there. Only the result goes back into the context.

The goal is a server that works with any MCP client, for example Claude Code, Claude Desktop, Cursor and Codex.

> **Status: pre-release.** The server is not built yet, and the package is not on npm. This repository holds the
> core and the sandbox runner. See [Roadmap](#roadmap).

## Why

When a model calls MCP tools one by one, every full result goes into its context. Large results fill the context with
raw JSON, and each step costs a round trip. With code mode, the loops, filters and joins run in a program. The model
sees only the answer.

## How it will work

1. Your MCP client connects to toolscript-mcp. toolscript-mcp connects to your other MCP servers.
2. The model finds tools with `search_tools`.
3. The model sends one program to `run_code`.
4. The program runs in a separate Node process. Each nested tool call goes through your allow, deny and ask rules.
5. The return value of the program goes back to the model.

An example program:

```js
const issues = await call("mcp__jira__search_issues", {
  jql: "assignee = currentUser() AND statusCategory != Done",
})
const cutoff = Date.now() - 14 * 24 * 3600 * 1000
return issues.issues
  .filter(i => Date.parse(i.fields.updated) < cutoff)
  .map(i => ({ key: i.key, title: i.fields.summary }))
```

The model sees a short list of keys and titles, not every full issue.

## Sandbox

| Layer | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Node `vm` context: no `require`, `process`, `fetch` or file system | Yes | Yes | Yes |
| Node permission model and an empty environment | Yes | Yes | Planned |
| No network access | `unshare -rn`, when the kernel allows it | `sandbox-exec` | No |
| CPU limit | `ulimit -t` | `ulimit -t` | No, wall-clock limit only |

The Node `vm` module is not a security boundary by itself. The sandbox limits accidents. It does not contain hostile
code. Read [SECURITY.md](SECURITY.md).

## Roadmap

- [x] Move the core and the sandbox runner out of the Claude Code plugin.
- [ ] Start the sandbox on Linux, macOS and Windows.
- [ ] Read a server config, connect to your MCP servers and add `search_tools`.
- [ ] Add `run_code` with allow, deny and ask rules.
- [ ] Write the docs and publish 0.1.0 to npm.

## Credits

toolscript-mcp is derived from [claude-code-mode](https://github.com/gabe4coding/claude-code-mode) by Gabriele
Pavanello, under the MIT License, at commit `eea4077`. The sandbox runner, its protocol, tool search, output
projection and the hint format are his work.

Do you use only Claude Code? Then use his plugin. It reuses the MCP connections and the permission checks of Claude
Code.

toolscript-mcp is an independent project. Gabriele Pavanello does not endorse it. It is not affiliated with or
endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
