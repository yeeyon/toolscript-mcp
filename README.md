# toolscript-mcp

A standalone MCP server for code mode. The model writes one JavaScript program that calls the tools of your other MCP
servers in a sandbox. The program filters and joins the data there. Only the result goes back into the context.

The goal is a server that works with any MCP client, for example Claude Code, Claude Desktop, Cursor and Codex.

> **Install from npm.** Set it up [from npm](docs/install.md#from-npm) with `npx -y toolscript-mcp init`. Read
> [Limits](docs/sandbox.md#limits) before you use it.

## Features

- **Two tools.** `search_tools` finds downstream tools and shows their argument types. `run_code` runs an async JavaScript program.
- **Servers.** Local stdio and remote HTTP servers, with OAuth login or AWS SigV4 signing.
- **Policy.** Ordered `allow`, `deny` and `ask` rules check each nested call.
- **Results.** Compact output, `await recall(n)` for kept results and `await saveFile(name, data)` for exports.
- **Local development.** The built-in [Workspace](docs/workspace.md#workspace) lists, searches and reads the files of one folder. With a write grant, it edits them. It is off by default.
- **Clients.** Claude Code, Claude Desktop, Cursor and Codex. See [Client setup](docs/install.md#client-setup). A manual smoke test passed in Codex CLI 0.171.0 with `codex exec`. See the [result](bench/CODEX.md#smoke-test-result).


JavaScript variables do not persist between runs. MCP resources, hint tools and saved-function tools are not available.
See [Roadmap](#roadmap) for the remaining work.

## Why

When a model calls MCP tools one by one, every full result goes into its context. Large results fill the context with
raw JSON, and each step costs a round trip. With code mode, the loops, filters and joins run in a program. The model
sees only the answer.

## How it works

1. Your MCP client connects to toolscript-mcp. toolscript-mcp connects to your other MCP servers.
2. The model finds tools with `search_tools`. A keyword search shows its best matches in full. Each full match has a
   TypeScript declaration of its `call()`: the nested types and the note of each argument. If 3 or fewer tools match,
   each one shows in full. If more match, match 1 always shows in full. Matches 2 and 3 show in full while all full
   matches total 4,000 characters or less. The other matches show as one summary each. The same tool on a second server
   shows as one line that names the full match above. That line takes no full place.
3. The model sends one program to `run_code`.
4. The program runs in a separate Node process. Each nested tool call goes through your allow, deny and ask rules.
5. The return value of the program goes back to the model. If the formatted value is longer than 20,000 characters,
   the model gets its shape and the first 3,000 characters of compact JSON.

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

## Numbers

A bench of 6 tasks in headless Claude Code 2.1.322 with Haiku 5.5, 5 runs per task, compares direct tool calls with toolscript-mcp.
Read [Measured](docs/benchmarks.md#measured) for the method, and the comparison with Claude Code Code Mode.

directly. The other arm used toolscript-mcp.

| Correct answers | 30/30 | 30/30 |
| Mean cost per task | $0.0060 | $0.0033 |
| Tool result characters in the context, mean | 41,595 | 8,133 |

## Quick start

You need Node 22.13 or later and npm.

### Install with the plugin

```text
/plugin marketplace add yeeyon/toolscript-mcp
/plugin install toolscript@toolscript-mcp
```

Then run `/toolscript:setup`. See [With the Claude Code plugin](docs/install.md#with-the-claude-code-plugin).

### Install with npm

```sh
npx -y toolscript-mcp init
```

`init` imports user-scope servers from Claude Code, Claude Desktop, Cursor and Codex. It writes a config and prints the client changes. See [From npm](docs/install.md#from-npm).

### Try the demo server

The demo server has sample data and needs no account.

```sh
npm install --prefix toolscript-demo toolscript-mcp@latest
```

The demo file is `toolscript-demo/node_modules/toolscript-mcp/demo/server.mjs`. Add it to your config as [Demo server](docs/install.md#demo-server) shows.

## Client setup in brief

Replace the example config path with your absolute config path. Use the server name `toolscript`.

Claude Code on Linux and macOS:

```sh
claude mcp add --scope user toolscript '--' npx -y toolscript-mcp --config "/absolute/path/to/config.json"
```

Claude Desktop, Cursor and Codex need a different entry. Read [Client setup](docs/install.md#client-setup) for each client.

## Documentation

| Page | Sections |
| --- | --- |
| [Install](docs/install.md) | [From npm](docs/install.md#from-npm), [Move an existing clone setup to npm](docs/install.md#move-an-existing-clone-setup-to-npm), [With the Claude Code plugin](docs/install.md#with-the-claude-code-plugin), [Client setup](docs/install.md#client-setup), [Configure downstream servers](docs/install.md#configure-downstream-servers), [From source](docs/install.md#from-source), [Demo server](docs/install.md#demo-server) |
| [Command line](docs/cli.md) | [init](docs/cli.md#init), [Doctor](docs/cli.md#doctor), [Check a server and a run](docs/cli.md#check-a-server-and-a-run) |
| [Configuration](docs/configuration.md) | [The policy](docs/configuration.md#the-policy), [Tools that require a person](docs/configuration.md#tools-that-require-a-person), [With Claude Code auto mode](docs/configuration.md#with-claude-code-auto-mode), [Files of a program](docs/configuration.md#files-of-a-program), [Non-text results](docs/configuration.md#non-text-results), [Untrusted text](docs/configuration.md#untrusted-text), [The config file](docs/configuration.md#the-config-file), [Run log](docs/configuration.md#run-log), [Learned result shapes](docs/configuration.md#learned-result-shapes), [Guarded folders](docs/configuration.md#guarded-folders) |
| [Sharing](docs/sharing.md) | [Shared servers](docs/sharing.md#shared-servers), [Lazy start](docs/sharing.md#lazy-start), [Child guard](docs/sharing.md#child-guard) |
| [Authentication](docs/auth.md) | [OAuth login](docs/auth.md#oauth-login), [AWS SigV4](docs/auth.md#aws-sigv4) |
| [Sandbox and limits](docs/sandbox.md) | [Sandbox](docs/sandbox.md#sandbox), [Limits](docs/sandbox.md#limits) |
| [Workspace](docs/workspace.md) | [Turn it on](docs/workspace.md#turn-it-on), [The root of a session](docs/workspace.md#the-root-of-a-session), [The tools](docs/workspace.md#the-tools), [What the read tools cover](docs/workspace.md#what-the-read-tools-cover), [Named tasks](docs/workspace.md#named-tasks), [Set a task up safely](docs/workspace.md#set-a-task-up-safely), [Change files](docs/workspace.md#change-files), [How a file is opened](docs/workspace.md#how-a-file-is-opened), [What stays possible](docs/workspace.md#what-stays-possible), [Check it](docs/workspace.md#check-it), [Tested clients](docs/workspace.md#tested-clients) |
| [Claude Code as a downstream server](docs/claude-code-bridge.md) | [The entry and the policy](docs/claude-code-bridge.md#the-entry-and-the-policy), [The risks](docs/claude-code-bridge.md#the-risks), [In a program](docs/claude-code-bridge.md#in-a-program), [Measured with Claude Code 2.1.325](docs/claude-code-bridge.md#measured-with-claude-code-21325) |
| [Benchmarks](docs/benchmarks.md) | [Measured](docs/benchmarks.md#measured), [Comparison with native Code Mode](docs/benchmarks.md#comparison-with-native-code-mode), [toolscript-mcp and Claude Code Code Mode](docs/benchmarks.md#toolscript-mcp-and-claude-code-code-mode) |

## Roadmap

- [x] Move the core and the sandbox runner out of the Claude Code plugin.
- [x] Start the sandbox on Linux, macOS and Windows.
- [x] Read a server config, connect to your MCP servers and add `search_tools`.
- [x] Add `run_code` with allow, deny and ask rules.
- [x] Write the docs and add the release workflow.
- [x] Compare toolscript-mcp with Claude Code Code Mode in the bench.
- [x] Log in to remote servers with OAuth.
- [x] Offer guided setup through the Claude Code plugin.
- [x] Run Claude Code tools through the optional stdio bridge, with a project `cwd`.
- [x] Require per-run approval for tools marked for user interaction.
- [x] Keep images and other non-text results as files, and show the images that a program returns.
- [x] Publish 1.0.0 to npm.
- [ ] Run the Codex comparison and publish its results.
- [ ] Keep state between `run_code` calls, as an option.
- [ ] Serve hint files and saved functions as tools.

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

The package has no runtime dependency. `dist/host/main.js` holds the MCP TypeScript SDK, `@modelcontextprotocol/sdk`
1.32.2 (MIT License), and the packages that it uses. These are under the MIT, ISC and BSD-3-Clause licences.
`dist/third-party-licenses.txt` holds their licence texts.
