# toolscript-mcp

A standalone MCP server for code mode. The model writes one JavaScript program that calls the tools of your other MCP
servers in a sandbox. The program filters and joins the data there. Only the result goes back into the context.

The goal is a server that works with any MCP client, for example Claude Code, Claude Desktop, Cursor and Codex.

> **Status: pre-release.** The server lists `search_tools` and `run_code`, with allow, deny and ask rules. The
> package is not on npm yet. See [Roadmap](#roadmap).

## Why

When a model calls MCP tools one by one, every full result goes into its context. Large results fill the context with
raw JSON, and each step costs a round trip. With code mode, the loops, filters and joins run in a program. The model
sees only the answer.

## Measured

We ran 6 bench tasks in headless Claude Code 2.1.322 with Haiku 5.5, 5 runs per task. One arm called the MCP tools
directly. The other arm used toolscript-mcp.

| | Direct tool calls | toolscript-mcp |
| --- | --- | --- |
| Correct answers | 30/30 | 30/30 |
| Mean cost per task | $0.0060 | $0.0033 |
| Tool result characters in the context, mean | 41,595 | 8,133 |
| Turns, mean | 4.7 | 5.8 |

The saving comes from tasks with large tool results: 27% to 69% lower cost. On the 2 tasks with small results,
toolscript-mcp cost more (38% and 91%), because it adds a search step. Only one model, one operating system and 5
tools were measured. Read [bench/RESULTS.md](bench/RESULTS.md) for the method and the limits.

## How it works

1. Your MCP client connects to toolscript-mcp. toolscript-mcp connects to your other MCP servers.
2. The model finds tools with `search_tools`.
3. The model sends one program to `run_code`.
4. The program runs in a separate Node process. Each nested tool call goes through your allow, deny and ask rules.
5. The return value of the program goes back to the model.

Your MCP client sees only `search_tools` and `run_code`. It does not see the tools of your other servers.

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

## Try it (from source)

You need Node 22.13 or later.

1. Build the server:

   ```sh
   git clone https://github.com/yeeyon/toolscript-mcp.git
   cd toolscript-mcp
   npm ci
   npm run build
   ```

2. Write a config file. It uses the `mcpServers` shape of Claude Desktop and Claude Code, with a `policy` for the
   tool calls of programs:

   ```json
   {
     "mcpServers": {
       "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "${NOTES_DIR}"] },
       "tracker": {
         "type": "http",
         "url": "https://mcp.example.com/mcp",
         "headers": { "Authorization": "Bearer ${TRACKER_TOKEN}" }
       }
     },
     "policy": [
       { "match": "mcp__tracker__delete_*", "action": "deny" },
       { "match": "mcp__tracker__*", "action": "allow" },
       { "match": "mcp__files__read_*", "action": "allow" }
     ]
   }
   ```

3. Add toolscript-mcp to your MCP client, with the server name `toolscript`. For example, in Claude Code:

   ```sh
   claude mcp add toolscript -- node /path/to/toolscript-mcp/dist/host/main.js --config /path/to/config.json
   ```

4. Ask the model for a task that needs your tools. It finds them with `search_tools` and runs one program with
   `run_code`.

### The policy

Each tool call of a program goes through the rules in `policy`. A tool is `mcp__<server>__<tool>`, with the server key
of your config.

- `match` is a glob over the tool name. `*` matches any characters.
- `action` is `allow`, `deny` or `ask`.
- The first rule that matches decides. A tool that no rule matches is `ask`.
- Before a program starts, toolscript-mcp reads the tool names that the program writes as strings in `call("…")`.
- If a `deny` rule matches one of these names, the program does not start.
- If some names need `ask`, toolscript-mcp asks you one time, with MCP elicitation. Your answer applies to that run only.
- If your client cannot ask, the program does not start. The result names the `allow` rule to add.
- toolscript-mcp checks each call again while the program runs. A tool name that the program builds at run time runs
  only with an `allow` rule.

A refused call throws an error in the program. The program can catch it.

### Files of a program

- `saveFile(name, data)` writes a file in `~/.toolscript-mcp/files/<session>/` and returns its path. On Linux and
  macOS, only your user account can read it. toolscript-mcp does not delete these files.
- `readFile(path)` reads only the files that `saveFile` wrote in the same session.
- `recall(n)` returns result `#n` of an earlier call again, with no new call. The result of `run_code` shows these
  numbers.

### The config file

- toolscript-mcp reads the file from `--config`, else from `TOOLSCRIPT_CONFIG`.
- Without both, it reads `%APPDATA%\toolscript-mcp\config.json` on Windows.
- On other systems, it reads `$XDG_CONFIG_HOME/toolscript-mcp/config.json`, else `~/.config/toolscript-mcp/config.json`.
- A stdio server has `command`, `args` and `env`. An HTTP server has `"type": "http"`, `url` and `headers`.
- `${VAR}` in `args`, `env`, `url` and `headers` gets the value of `VAR` from the environment of toolscript-mcp.
- If a variable is not set, toolscript-mcp does not start. The error names the variable, not its value.
- A server key contains letters, digits and hyphens, with single underscores between them. A tool is then `mcp__<key>__<tool>`.
- `sandbox.node` sets the Node binary of the sandbox. The default is the Node that runs toolscript-mcp.
- On Windows, `sandbox.node` must be a full path, because the sandbox process has no `PATH`.
- `sandbox.timeoutSeconds` sets the time limit of one run. The default is 120 seconds. The minimum is 5, and the
  maximum is 86400.
- `policy` holds the rules for the tool calls of programs. See [The policy](#the-policy).

A stdio server gets only its `env` from the config and a short list of system variables, for example `PATH` and
`HOME`. Your other environment variables, and the secrets in them, stay out.

If a server does not connect, the other servers still work. `search_tools` shows the failed server and the reason.
toolscript-mcp refuses to start from its own config, so it cannot start copies of itself in a loop.

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
code. Read [SECURITY.md](SECURITY.md).

## Roadmap

- [x] Move the core and the sandbox runner out of the Claude Code plugin.
- [x] Start the sandbox on Linux, macOS and Windows.
- [x] Read a server config, connect to your MCP servers and add `search_tools`.
- [x] Add `run_code` with allow, deny and ask rules.
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

The one runtime dependency is the MCP TypeScript SDK, `@modelcontextprotocol/sdk` 1.32.2, under the MIT License.
The packages it installs are under the MIT, ISC, BSD-2-Clause and BSD-3-Clause licences.
