# toolscript-mcp

A standalone MCP server for code mode. The model writes one JavaScript program that calls the tools of your other MCP
servers in a sandbox. The program filters and joins the data there. Only the result goes back into the context.

The goal is a server that works with any MCP client, for example Claude Code, Claude Desktop, Cursor and Codex.

> **Status: 0.1.0, the first release.** The server lists `search_tools` and `run_code`, with allow, deny and ask
> rules. Read [Limits](#limits) before you use it.

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
tools were measured. The bench ran at commit `cce6ea0`, before the changes of 0.1.0 to the text and the search output. Read [bench/RESULTS.md](bench/RESULTS.md) for the method and the limits.

## How it works

1. Your MCP client connects to toolscript-mcp. toolscript-mcp connects to your other MCP servers.
2. The model finds tools with `search_tools`. A search with 3 or fewer matches shows each tool in full, with a
   TypeScript declaration of its `call()`: the nested types and the note of each argument.
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

## Install

You need Node 22.13 or later. npm installs toolscript-mcp when your client starts it with `npx`.

1. Import the MCP servers of your clients into a config file:

   ```sh
   npx -y toolscript-mcp init
   ```

   init reads the MCP servers of Claude Code, Claude Desktop and Cursor. It does not change these files. It writes
   the config to the default place, and it prints the lines to change in each client. See [init](#init).

   You can also write the config by hand. It uses the `mcpServers` shape of Claude Desktop and Claude Code, with a
   `policy` for the tool calls of programs:

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

2. Add toolscript-mcp to your MCP client, with the server name `toolscript`. See [Client setup](#client-setup).

3. Remove the servers of your config from your client. Then your client sees only `search_tools` and `run_code`.

4. Add `allow` rules for the tools that programs use. See [The policy](#the-policy).

5. Ask the model for a task that needs your tools. It finds them with `search_tools` and runs one program with
   `run_code`.

### Client setup

Claude Code:

```sh
claude mcp add --scope user toolscript -- npx -y toolscript-mcp --config /path/to/config.json
```

On Windows, Claude Code needs `cmd /c` before `npx`:

```sh
claude mcp add --scope user toolscript -- cmd /c npx -y toolscript-mcp --config C:\path\to\config.json
```

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "toolscript": { "command": "npx", "args": ["-y", "toolscript-mcp", "--config", "/path/to/config.json"] }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.toolscript]
command = "npx"
args = ["-y", "toolscript-mcp", "--config", "/path/to/config.json"]
```

If you put the config file in the default place, you can omit `--config`. See [The config file](#the-config-file).

### From source

```sh
git clone https://github.com/yeeyon/toolscript-mcp.git
cd toolscript-mcp
npm ci
npm run build
```

Then start `node /path/to/toolscript-mcp/dist/host/main.js --config /path/to/config.json` in your client.

### init

- `npx -y toolscript-mcp init` imports the user-scope servers of Claude Code. It does not import the servers of a
  project.
- If two clients have a server with the same name, init keeps the first one. The order is Claude Code, Claude
  Desktop, Cursor.
- init does not import an SSE server, a disabled server, or toolscript-mcp itself.
- On Linux and macOS, only your user account can read the config that init writes.
- `--dry-run` shows the config and the steps, and writes nothing. The values of `env` and `headers` show as `***`.
  The user, password and query of a URL also show as `***`. Other arguments show as they are. If an argument holds a
  secret, do not share the output.
- `--force` replaces a config that exists. Without it, init does not change an existing config.
- `--config <path>` writes the config to a different path.
- The config from init has an empty `policy`, so each tool is `ask`.

## Configuration

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

toolscript-mcp reads `policy` again at the start of each run. If the config has errors at that time, the run uses the
last valid policy, and the result tells you so.

A stricter policy applies at once. If a change lets a tool run with less approval, toolscript-mcp asks you before the
run. If your client cannot ask, restart toolscript-mcp to apply that change. Do not let a tool that the policy allows
write the config file.

If a tool does not answer in the call time limit, the call throws an error. toolscript-mcp cancels the request on the
server. The program can catch the error and continue.

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
- If a server entry has an error, for example a variable that is not set, only that server fails.
- `search_tools` shows the error of the server. The error names the variable, not its value.
- An error outside `mcpServers` stops toolscript-mcp at the start.
- A server key contains letters, digits and hyphens, with single underscores between them. A tool is then `mcp__<key>__<tool>`.
- `sandbox.node` sets the Node binary of the sandbox. The default is the Node that runs toolscript-mcp.
- On Windows, `sandbox.node` must be a full path, because the sandbox process has no `PATH`.
- `sandbox.timeoutSeconds` sets the time limit of one run. The default is 120 seconds. The minimum is 5, and the
  maximum is 86400.
- `sandbox.callTimeoutSeconds` sets the time limit of one call of a program. The default is 60 seconds, or
  `sandbox.timeoutSeconds` if that is shorter. The minimum is 1. The value must not be more than
  `sandbox.timeoutSeconds`.
- `policy` holds the rules for the tool calls of programs. See [The policy](#the-policy).
- `"log": false` turns off the run log. See [Run log](#run-log).

A stdio server gets only its `env` from the config and a short list of system variables, for example `PATH` and
`HOME`. Your other environment variables, and the secrets in them, stay out.

If a server does not connect, the other servers still work. `search_tools` shows the failed server and the reason.
toolscript-mcp refuses to start from its own config, so it cannot start copies of itself in a loop.

If a server fails or stops, toolscript-mcp connects to it again on the next search or call. It tries at most 3 times
in 60 seconds for each server. Then `search_tools` shows the time until the next attempt.

### Run log

toolscript-mcp writes one line to `~/.toolscript-mcp/runs.jsonl` for each `run_code` call.

- Each line shows the time, a run id, the duration and how the run ended. It also shows the size of the result.
- For each call of the program, the line shows the tool name, the policy decision, the duration and a short error code.
- The log never holds arguments, results, program text or error messages.
- On Linux and macOS, only your user account can read the file.
- When the file passes 5 MB, toolscript-mcp renames it to `runs.1.jsonl`. It keeps one old file.
- To turn the log off, add `"log": false` to the config.

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

## Limits

- On Windows, the sandbox has no network block and no CPU limit. The host stops the process at the time limit.
- `ask` rules need a client with MCP elicitation. If your client cannot ask, write `allow` rules for the tools that
  programs use.
- Elicitation is tested with the client of the MCP TypeScript SDK. It is not yet tested in the user interface of each
  client.
- toolscript-mcp has no OAuth login. A remote server that needs an OAuth login does not connect.
- An HTTP server that stops does not close its connection, so toolscript-mcp does not connect to it again. Its calls
  fail with an error until you restart toolscript-mcp.
- Programs cannot read MCP resources. `resources()` and `readResource()` answer that they are not available.
- Each `run_code` call starts a new program. No state stays between two calls, except the files of `saveFile`.

## toolscript-mcp and Claude Code Code Mode

Claude Code 2.1.323 added Code Mode, an experimental option. With it, Claude writes JavaScript that calls its tools.
It solves a similar problem inside Claude Code.

- Code Mode works only in Claude Code. It is off by default, and it has more conditions, for example the interactive
  terminal and the Anthropic API.
- Code Mode reaches the built-in tools of Claude Code and the shell. toolscript-mcp reaches only MCP tools.
- toolscript-mcp is for each MCP client that can start a stdio server. It is open source, with a documented sandbox
  and allow, deny and ask rules.
- toolscript-mcp is tested with the client of the MCP TypeScript SDK and with Claude Code.

If you use only Claude Code, try Code Mode or the [claude-code-mode](https://github.com/gabe4coding/claude-code-mode)
plugin first. The bench in [Measured](#measured) ran on Claude Code 2.1.322, the release before Code Mode.

## Roadmap

- [x] Move the core and the sandbox runner out of the Claude Code plugin.
- [x] Start the sandbox on Linux, macOS and Windows.
- [x] Read a server config, connect to your MCP servers and add `search_tools`.
- [x] Add `run_code` with allow, deny and ask rules.
- [x] Write the docs and publish 0.1.0 to npm.
- [ ] Keep state between `run_code` calls, as an option.
- [ ] Serve hint files and saved functions as tools.
- [ ] Log in to remote servers with OAuth.
- [ ] Compare toolscript-mcp with Claude Code Code Mode in the bench.

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
