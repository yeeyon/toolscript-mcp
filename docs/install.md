# Install

Back to the [documentation index](../README.md#documentation).

You need Node 22.13 or later and npm.

## From npm

```sh
npx -y toolscript-mcp init
```

init imports user-scope servers from Claude Code, Claude Desktop, Cursor and Codex. It writes a toolscript-mcp config
and prints the client changes. For a manual setup, see [Client setup](#client-setup). Then follow
[Configure downstream servers](#configure-downstream-servers).

To print the version of the package, run `npx -y toolscript-mcp --version`.
To update, run `npx -y toolscript-mcp@latest --help` and restart your client. If your client entry pins a version,
change the version in that entry before you restart.

Questions about setup, the demo, approval prompts or a failed check? Read the [FAQ](../FAQ.md).

### Move an existing clone setup to npm

1. Find the config path in the existing client entry. If it uses the default path, keep that default.
2. Replace the client entry's command and arguments. Keep the same config path and any environment variables. Use
   [Client setup](#client-setup).
3. Restart the client and run a task through toolscript-mcp. Check it with [runs](cli.md#check-a-server-and-a-run).

The config keeps your servers and policy. The same user account also keeps its saved OAuth tokens.
If an entry uses a file inside the clone, keep that file or update its path first.

### With the Claude Code plugin

This repo is also a Claude Code plugin marketplace. Its plugin `toolscript` guides the npm setup. In Claude Code, run:

```text
/plugin marketplace add yeeyon/toolscript-mcp
/plugin install toolscript@toolscript-mcp
```

Then run `/toolscript:setup`, or ask Claude to set up toolscript-mcp. The skill asks you before each step that changes
something:

1. It checks Node and npm, then checks that the published package starts.
2. It runs `init` when you agree, and shows the servers that init imported.
3. It adds toolscript-mcp to Claude Code with `claude mcp add`.
4. It sends you to `/toolscript:start` for the first run. See the list below.
5. It helps you choose a policy and add servers. It never reads the config, because the config holds your secrets.
6. It gives you the `login` command for each server that needs OAuth. You run the command.
7. It adds Claude Code as a server when you agree, with the policy of [Claude Code as a downstream server](claude-code-bridge.md#claude-code-as-a-downstream-server).

`/toolscript:start` guides the first run. It ends after one `run_code` task works. Run it again at any time:

1. You pick one server from `init --list`, which shows the servers of your clients with their scope. With no server, you can pick the demo server. It needs no account.
2. The skill runs `tools` on that server. It shows each tool with its hint and its policy action, or the login command when the server needs OAuth.
3. The skill proposes a small read task. For the demo, the task is "Count the open pull requests per author".
4. You pick the starter policy. With "Ask when needed", Claude Code asks you before each program. "Allow this workflow" runs the `allow` commands that `tools` prints for the tools of the task. Each one shows the new policy first, and it writes the policy only after you agree. It keeps each deny rule that matches one of these tools.
5. You start a new session and give the task. Then `/toolscript:start verify` runs `runs --server <server> --since 2h`. It confirms a recent run that called the server, or it names the step that fixes it.
6. After a run works, the skill offers to remove the direct copy of the server from Claude Code. It shows the scope of the copy first.

`/toolscript:doctor` checks the whole setup and changes no setting. It runs [doctor](cli.md#doctor), then checks the Claude
Code registration and the direct copies of your servers. For each problem, it names the step that fixes it.

`/toolscript:workspace` turns on the built-in [Workspace](workspace.md#workspace) for a project folder. It first runs
`toolscript-mcp --version` and stops when the package is older than 1.0.4, because an older package refuses a config
with a `workspace` section. It proposes the folder where Claude Code started, adds it as a root, and asks before each
extra grant: write access and one named task. It checks the root with `doctor`. After you restart Claude Code in that
folder, `/toolscript:workspace verify` lists the folder through a program and reports a count of entries.

The skills do not edit the config files of your clients. They show the lines to change. To update or uninstall
toolscript-mcp, ask Claude again.

## Client setup

Replace the example config path with your absolute config path. Use the server name `toolscript`.

Claude Code on Linux and macOS:

```sh
claude mcp add --scope user toolscript '--' npx -y toolscript-mcp --config "/absolute/path/to/config.json"
```

Claude Code on Windows, in PowerShell:

```powershell
claude mcp add --scope user toolscript '--' cmd /c npx -y toolscript-mcp --config "C:/tools/toolscript-config.json"
```

Keep the quotes around `'--'`. The PowerShell `claude.ps1` shim drops a bare `--`, so it can misread `--config`.

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "toolscript": {
      "command": "npx",
      "args": ["-y", "toolscript-mcp", "--config", "/absolute/path/to/config.json"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.toolscript]
command = "npx"
args = ["-y", "toolscript-mcp", "--config", "/absolute/path/to/config.json"]
default_tools_approval_mode = "approve"
```

Keep `default_tools_approval_mode = "approve"` in the Codex entry. Without it, `codex exec` refuses every MCP call.
toolscript-mcp still checks its own policy on each call of a program.
In a test on Windows, Codex started toolscript-mcp in the folder where `codex exec` ran. A downstream server with
no `cwd` in its entry starts in that folder too.

On Windows, set the command to `cmd` and put `"/c", "npx"` at the start of the arguments in JSON and TOML.
Use a config path such as `C:/tools/toolscript-config.json`.
If you put the config file in the default place, you can omit `--config` and its path.
See [The config file](configuration.md#the-config-file).

## Configure downstream servers

Use the config from init, or write one by hand. The config uses the `mcpServers` shape and adds a `policy`:

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

1. Set `NOTES_DIR` and `TRACKER_TOKEN` in the environment that starts toolscript-mcp. Replace the example server with your own.
2. Choose the rules for your tools. The config from init has no `allow` rules, so each tool is `ask`.
3. If a server needs OAuth, run its [login command](auth.md#oauth-login) in a terminal.
4. Start a new client session and confirm that `search_tools` lists your servers and tools.
5. Remove the imported servers from your client config. This prevents duplicate direct connections.
6. Ask the model for a task that needs your tools. It finds them with `search_tools` and uses `run_code`.

Keep one path to each server. If your client also lists a server directly, the model calls the direct tools, and each
full result goes into the context. In one real session with both paths, the model never called `run_code`. MCP gives
a server no list of the servers of its client. So toolscript-mcp does not check for a duplicate while it runs. init
imports only the user-scope servers of each client. In Claude Code, run `claude mcp list` to find a project or local
copy.

If your client cannot ask for approval, add explicit `allow` rules for the tools that programs need.
Tools marked for user interaction still cannot run without approval. See [The policy](configuration.md#the-policy).

## From source

For development on `main`:

```sh
git clone https://github.com/yeeyon/toolscript-mcp.git
cd toolscript-mcp
npm ci
npm run build
```

For a development session, use `node` as the client command. Replace the npm arguments with
`["/absolute/path/to/toolscript-mcp/dist/host/main.js", "--config", "/absolute/path/to/config.json"]`.

## Demo server

`demo/server.mjs` is a read-only MCP server with 40 sample pull requests. It needs no account.
Install the npm package in a folder of your choice to give the demo file a stable path.

```sh
npm install --prefix "/absolute/path/to/demo-package" toolscript-mcp@latest
```

Add the demo file to your config. Replace the example path with your path.

```json
{
  "mcpServers": {
    "demo": { "command": "node", "args": ["/absolute/path/to/demo-package/node_modules/toolscript-mcp/demo/server.mjs"] }
  },
  "policy": [{ "match": "mcp__demo__list_pull_requests", "action": "allow" }]
}
```

Then give the model the task "Count the open pull requests per author". The task needs more than one page of
`list_pull_requests`. The correct answer is ada 7, bruno 6, chen 5, dara 4, emil 3 and farah 1. `demo/data.mjs`
exports it as `OPEN_BY_AUTHOR`.
