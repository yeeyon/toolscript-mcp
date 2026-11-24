# toolscript-mcp FAQ

Answers for the npm setup and for daily use. The [README](README.md) has the full reference.

Every example uses sample data and placeholder values. Replace each path, server name and credential with your own.
Do not paste a real token into a config or a bug report.

- [What does toolscript-mcp do?](#what-does-toolscript-mcp-do)
- [How do I install and update it from npm?](#how-do-i-install-and-update-it-from-npm)
- [How do I move a GitHub clone setup to npm?](#how-do-i-move-a-github-clone-setup-to-npm)
- [How do I add servers?](#how-do-i-add-servers)
- [How can a program read my project files without Claude Code?](#how-can-a-program-read-my-project-files-without-claude-code)
- [How can a program run my tests?](#how-can-a-program-run-my-tests)
- [How can I try it without an account?](#how-can-i-try-it-without-an-account)
- [Why did the model use the server tool directly, find no tools, or stop for approval?](#why-did-the-model-use-the-server-tool-directly-find-no-tools-or-stop-for-approval)
- [What do I try when setup fails?](#what-do-i-try-when-setup-fails)
- [What was checked, and what was not?](#what-was-checked-and-what-was-not)

## What does toolscript-mcp do?

Your MCP client sees two tools. toolscript-mcp connects to your other MCP servers and hides their tools from the client.

| Tool | Use it to |
| --- | --- |
| `search_tools` | Find the tools of your servers and read their argument types. An empty query with `limit` 1 checks which servers connect. |
| `run_code` | Run one async JavaScript program. The program calls the tools with `call()`. Only its return value goes back to the model. |

Use `search_tools` when the model does not know a tool name or its arguments. Then use `run_code` for the calls.
Use `run_code` for several calls, or when a result is large and the model needs only part of it.
A program runs in a [sandbox](README.md#sandbox), and each call goes through your [policy](README.md#the-policy).

An example with the bundled demo server. The prompt:

```text
Count the open pull requests per author.
```

The model sends this program. The demo returns at most 20 pull requests a page, so the program follows `next_cursor`:

```js
const counts = {}
let cursor
do {
  const page = await call("mcp__demo__list_pull_requests", { state: "open", per_page: 20, cursor })
  for (const pr of page.pull_requests) counts[pr.author] = (counts[pr.author] ?? 0) + 1
  cursor = page.next_cursor
} while (cursor)
return counts
```

The result that the model gets:

```text
{
  "ada": 7,
  "chen": 5,
  "emil": 3,
  "bruno": 6,
  "dara": 4,
  "farah": 1
}

--- 2 MCP calls: 5k characters in, 56 out ---
```

The model reads 56 characters, not the 5,000 characters of the two pages. The order of the keys can differ. The
[correct answer](#how-can-i-try-it-without-an-account) is the same.

## How do I install and update it from npm?

You need Node 22.13 or later and npm. Run `node --version` to check.

To write a config from the servers that your clients have now, run `npx -y toolscript-mcp init`. It prints the path that it
wrote (`Wrote <file>.`). For each client that it read, it prints the command or the entry that adds toolscript-mcp
with that path. Run the printed command or add the printed entry, or use that path in the steps below. If no client has a
server, `init` writes nothing: write the config yourself, and give its absolute path.

Then add toolscript-mcp to your client with the server name `toolscript`. The [Client setup](README.md#client-setup)
section of the README has the `claude mcp add` command for Linux, macOS and Windows PowerShell. It also has the JSON
for Claude Desktop and Cursor, and the TOML for Codex. On Windows, use `cmd /c npx`. In PowerShell, keep the quotes around `--`.

- Keep `default_tools_approval_mode = "approve"` in the Codex entry. Without it, `codex exec` refuses every MCP call.
  toolscript-mcp still checks its own policy on each call.
- If you keep the config at the default path, you can leave out `--config`. See [The config file](README.md#the-config-file).

To check that the package starts, run `npx -y toolscript-mcp doctor`. If you use another config path, add `--config <path>`.
`doctor` prints one line for each check, and the exit code is 1 when a check fails.

**Check the version.** No command prints the version of a running server. `--help` prints only the usage.
These steps tell you the version:

- `npm view toolscript-mcp version` prints the newest published version.
- If your client entry names a version, such as `toolscript-mcp@1.0.0`, that version runs.
- The server sends its version in the MCP `initialize` reply, as `serverInfo.version`. A client that shows server
  details can show it. A test client read the version this way. No client was checked for a screen that shows it.

**Update.** Run `npx -y toolscript-mcp@latest --help`, then restart your client. If your client entry names a
version, change that version before you restart. A running session keeps the old server until the client restarts.

**When to restart.** Restart your client after an update and after a change to a server entry or to `sandbox`.
The `policy` loads again at each run, so a stricter rule applies at once. A looser rule waits for your approval, or for a
restart if the client cannot ask. An OAuth login needs no restart.

A folder can hold a package of the same name, such as a clone of this repo. If `npx -y toolscript-mcp` runs there, `npx`
can start that copy. In one Windows test it did, and the server reported the version of the clone. Start your client
outside the clone.

## How do I move a GitHub clone setup to npm?

The config holds your servers and your policy. The OAuth tokens are in `~/.toolscript-mcp/oauth/` for your user account.
The new entry reads the same config and the same tokens, so you change only the launch command.

1. Find the launch command and the config path of the old entry. In Claude Code, run `claude mcp get toolscript`.
   The old entry looks like `node /path/to/toolscript-mcp/dist/host/main.js --config /path/to/config.json`.
2. Write down the config path after `--config`. If the entry sets `TOOLSCRIPT_CONFIG`, write that path down.
   If the entry has neither, the config is at the default path. See [The config file](README.md#the-config-file).
3. Replace the entry with the npm command and the same config path:

   ```sh
   claude mcp remove --scope <scope> toolscript
   claude mcp add --scope <scope> toolscript -e NAME=value '--' npx -y toolscript-mcp --config "/path/to/config.json"
   ```

   Use the scope that `claude mcp get toolscript` shows for the old entry: `User config` is `user`, `Local config` is
   `local`, and `Project config` is `project`. For `local` or `project`, run both commands in the project folder. Add one `-e NAME=value` for each environment
   variable of the old entry, such as `TOOLSCRIPT_CONFIG`. Leave out `-e` if the entry has none. Put each `-e` after
   the name `toolscript`: before the name, `-e` reads the name as one more variable.
   `claude mcp get toolscript` shows the variables.
   On Windows, use the PowerShell form in [Client setup](README.md#client-setup).
4. Restart the client. Check the setup with `npx -y toolscript-mcp doctor --config "/path/to/config.json"`.
   The `servers` lines must show the same servers as before.
5. Give the model a task that uses one of your servers. Then run
   `npx -y toolscript-mcp runs --server <server> --since 30m --config "/path/to/config.json"`. The exit code 0 means that the
   newest run worked through toolscript-mcp.
6. Only after step 5 works, remove the direct copy of that server from your client. Run
   `npx -y toolscript-mcp init --list --config "/path/to/config.json"`. It prints the steps that remove each direct copy.

If the old entry uses a file inside the clone, such as a hint file, keep that file or change its path first.
A server with an OAuth login keeps its tokens only when its server key and its `url` stay the same.
The token file name holds the server key and a hash of the URL.

## How do I add servers?

toolscript-mcp starts a local server as a child process (stdio). It connects to a remote server over HTTP.

| | Local stdio | Remote HTTP |
| --- | --- | --- |
| Entry | `command`, `args`, `env`, `cwd` | `"type": "http"`, `url`, `headers`, `oauth`, `sigv4` |
| Credentials | `env` values in the entry | A `headers` value, an OAuth login, or `sigv4` for an AWS server |
| Starts | With the session, or on first use with `"lazy": true`. The Claude Code bridge starts on first use. See [Lazy start](README.md#lazy-start). | Connects at the start |
| Fails when | The command is not on `PATH`, or `cwd` is missing | The URL is wrong, the login is missing, or the AWS credentials cannot be read |

A stdio server gets only the `env` of its entry and a short list of system variables, such as `PATH` and `HOME`.
Your other variables stay out. With sharing on, do not set `"lazy"` on a shared or per-folder server: the server fails
until you remove `"lazy"` or set `"share": false`.

**Placeholders.** Write `${VAR}` in `args`, `env`, `cwd`, `url` and `headers`. toolscript-mcp reads the value from the
environment of the process that starts it. That process is your client. Set the variable where the client starts, and
restart the client. If a variable is not set, only that server fails, and the error names the variable, not a value.

The README has an [example config](README.md#configure-downstream-servers) with one stdio server, one HTTP server and a
`policy`.

**AWS servers.** For an AWS HTTP server, such as the AWS MCP Server, add `"sigv4": { "profile": "<profile>" }` to the
entry. toolscript-mcp signs each request with the credentials of that profile of the AWS CLI. It needs no `headers` and no
login. See [AWS SigV4](README.md#aws-sigv4).

**OAuth login.** For an HTTP server with no `headers` and no `sigv4`, run `npx -y toolscript-mcp login <server>` in a terminal. Add
`--config <path>` for another config. The browser opens, and you approve the access. toolscript-mcp refreshes the token
by itself. It never opens a browser while it runs as a server. See [OAuth login](README.md#oauth-login).

**Import from your clients.** `init` reads the servers that you already have:

| Client | What `init` reads | What `init --list` also reads |
| --- | --- | --- |
| Claude Code | User scope | Local and project scopes of the `--project` folder |
| Claude Desktop | The servers of its config file | Same |
| Cursor | The servers of its config file | Same |
| Codex | Nothing | Nothing |

- If two clients have a server with the same name, `init` keeps the first. The order is Claude Code, Claude Desktop, Cursor.
- `init` skips SSE servers, disabled servers and toolscript-mcp itself.
- `init --list` prints one line for each server, and a ready command for each server that is not in the config yet.
- The config from `init` has no `allow` rule, so each tool is `ask`.

See [init](README.md#init) for the full list of options.

**Codex, by hand.** `init` does not read Codex. Write the config file yourself, as in the
[example config](README.md#configure-downstream-servers) of the README, and give its path
in the Codex entry from the [install answer](#how-do-i-install-and-update-it-from-npm). Add an `allow` rule for each
tool that a program must call, because `codex exec` declines the approval prompt.
To copy a server that Codex runs, copy its `command`, `args` and `env` from `~/.codex/config.toml` into the `mcpServers` shape.

After a change, restart your client. Then ask the model to run `search_tools` with an empty query and `limit` 1. The result lists
the servers that are not connected, with the reason.

## How can a program read my project files without Claude Code?

Turn on the built-in [Workspace](README.md#workspace). It lists, searches and reads the files of one folder. It runs
inside toolscript-mcp, so it needs no Claude Code and no other process. It is off by default.

1. Add a `workspace` section to the config, with the absolute path of your project as the one root:
   `"workspace": { "roots": [{ "path": "/home/me/app" }] }`. The config also needs `"mcpServers": {}`.
2. Restart your client. Run `toolscript-mcp tools workspace` in a terminal to see the four tools.
3. Ask the model to search the project. It calls `mcp__workspace__search` and `mcp__workspace__read` from one program.

The read tools run with no `allow` rule. Each result is untrusted text. Paths such as `.git`, `.env` and `*.pem` never show.
A link out of the root is refused. The tools cannot edit a file yet. They can run your tests as a named task: see
[How can a program run my tests?](#how-can-a-program-run-my-tests).

If `search_tools` lists Workspace under "Not connected", read the reason. With several entries in `roots`, start your client
in one of the folders. Run `toolscript-mcp doctor` for the check of the root. See
[What stays possible](README.md#what-stays-possible) before you give Workspace a folder that other accounts can write.

## How can a program run my tests?

Add a named task to the root entry of the [Workspace](README.md#named-tasks). The model sends only the name, so it never
chooses the program or the arguments.

1. Add `tasks` to the entry:
   `"tasks": { "test": { "command": "node", "args": ["--test"] } }`. Restart your client.
2. The program calls `mcp__workspace__run_task` with `{ "task": "test" }`. It returns the exit code and the output.
3. The call asks you first. To skip the prompt, add an `allow` rule with the exact name `mcp__workspace__run_task`.

The rules `*`, `mcp__*` and `mcp__workspace__*` do not allow a task. A task runs project code with your rights, and nothing
contains it. A non-zero exit code is a result, not an error. On Windows, a `.cmd`, `.bat` or `.ps1` file cannot be the
command. Use `node` with the script as the first argument. Run `toolscript-mcp doctor` to see a task that cannot run.

## How can I try it without an account?

The package has a read-only demo server with 40 sample pull requests. It needs no account.

1. Install the package in a folder of your choice, and write a config with the demo server and one `allow` rule.
   The [Demo server](README.md#demo-server) section of the README has the command and the config.
   On Windows, use forward slashes in the path.
2. Add toolscript-mcp to your client with this config. See the [install answer](#how-do-i-install-and-update-it-from-npm).
3. Start a new session and give the model the task `Count the open pull requests per author`.

The correct answer is ada 7, bruno 6, chen 5, dara 4, emil 3 and farah 1. The task needs two pages of
`list_pull_requests`. `demo/data.mjs` exports the answer as `OPEN_BY_AUTHOR`.

Then check that toolscript-mcp handled the task. `runs` reads the [run log](README.md#run-log):

```sh
npx -y toolscript-mcp runs --server demo --since 2h --config "/absolute/path/to/config.json"
```

A successful check prints the run and exits with 0. The time is the time of your run:

```text
runs since 2026-11-23T05:08:34.832Z
2026-11-23T07:08:29.882Z done 297 ms
  mcp__demo__list_pull_requests allow ok
  mcp__demo__list_pull_requests allow ok
```

The two `list_pull_requests` lines are the two pages. If `runs` prints `no run yet` or `no run since`, the model did not
call `run_code`. See the [last answer](#what-do-i-try-when-setup-fails). Do not remove a direct connection to a real
server before `runs` succeeds for that server.

To see the tools and their policy decision first, run `npx -y toolscript-mcp tools demo --config "<path>"`.
It prints `demo: connected, 2 tools`, then each tool with its hint and its decision.

## Why did the model use the server tool directly, find no tools, or stop for approval?

**The model called the server tool directly.** Your client has a second registration of the same server. The model
sees those tools and picks them, and each full result goes into the context. In one real session with both paths, the
model never called `run_code`. toolscript-mcp cannot see the other registrations of your client.

- Run `npx -y toolscript-mcp init --list --config "<path>"`. A server with the status `in config` that your client also lists is a duplicate.
- In Claude Code, run `claude mcp list` to find a copy in the project or local scope.
- Remove the direct copy after a run through toolscript-mcp works. `init --list` prints the removal steps.

**The model found no tools.** Ask for `search_tools` with an empty query and `limit` 1. A server that is down is under
"Not connected", with the reason. Then run `npx -y toolscript-mcp tools <server> --config "<path>"` in a terminal. See
[the failure table](#what-do-i-try-when-setup-fails) for each reason.

**The model stopped for approval.** Each tool call of a program goes through the `policy` rules in order:

- `match` is a glob over `mcp__<server>__<tool>`. `*` matches any characters.
- `action` is `allow`, `deny` or `ask`.
- The first rule that matches decides. A tool that no rule matches is `ask`.
- A `deny` rule also stops a program before it starts, when the program names the tool in a `call("…")` string.

Put each `deny` rule before any `allow` rule that matches the same tool. To allow one tool, run `allow` and read
the new policy first:

```sh
npx -y toolscript-mcp allow --config "/absolute/path/to/config.json" "mcp__demo__get_pull_request"
```

Without `--apply`, it writes nothing. It shows the policy and the command with `--apply`.

If your client cannot show an approval prompt, a program that needs an `ask` tool does not start. In a test client, the
result was:

```text
Error: the program did not run, because some tools need approval and this MCP client cannot ask the person. No call was made.
```

Add an `allow` rule for the tools that programs need. The rule applies after you restart toolscript-mcp. `codex exec`
declines the prompt, so an `allow` rule is the only way there. Some servers mark a tool so that a person must approve
each run. An `allow` rule never replaces that approval, so a client with no prompt cannot run such a tool. See
[Tools that require a person](README.md#tools-that-require-a-person).

The policy matches tool names only, not arguments. The sandbox on Windows has no network block and no CPU limit.
Read the [Sandbox](README.md#sandbox) and [Limits](README.md#limits) sections, and [SECURITY.md](SECURITY.md), before you
allow a tool that writes or deletes data.

## What do I try when setup fails?

Run three commands in this order. Each one prints to stderr, and none of them prints a secret value. Give each the
same `--config <path>` as your client entry, if the entry has one.

1. `npx -y toolscript-mcp doctor` checks the Node version, the config, each server, the policy, the sandbox and the run log.
2. `npx -y toolscript-mcp tools <server> --config "<path>"` connects to one server and lists its tools with their policy decision.
3. `npx -y toolscript-mcp runs --server <server> --since 1h` shows the newest runs and the next step for each problem.

| What you see | Cause | What to do |
| --- | --- | --- |
| The client shows toolscript as failed, or `doctor` prints `fail config  no config at ...` | The launch command or the config path is wrong | Run the client command in a terminal. Fix the path. On Windows, use `cmd /c npx`. |
| `tools` prints `cannot connect: ... the environment variable TRACKER_TOKEN is not set` | A credential is missing | Set the variable where the client starts. Restart the client. |
| `tools` or `search_tools` prints a `login` command | The server needs an OAuth login | Run `npx -y toolscript-mcp login <server>`. No restart is needed. |
| The call fails and the error names `aws sso login` | The AWS CLI cannot read the credentials of a `sigv4` entry | Run `aws sso login --profile <profile>`. The next call works with no restart. See [AWS SigV4](README.md#aws-sigv4). |
| `runs` prints `unapproved` or `denied`, and the run ends `refused` | The policy refused a tool | Run `allow` for the tool, or change the `deny` rule. See the [policy answer](#why-did-the-model-use-the-server-tool-directly-find-no-tools-or-stop-for-approval). |
| `runs` prints `no run yet` or `no run since <time>`, with exit code 1 | The model never called `run_code` | Look for a duplicate registration. Start a new session. Give a task that needs the server. |
| `doctor` prints `ok` for every check, but the task fails | The error is in the program or the server | Read the `run_code` result. `runs` names the next step for the error code. |

A failed `runs` check has the exit code 1. The check passes only when the newest run ended `done`, called a tool of the
server, and each call worked.

For a stdio server, `tools` never shows what the server writes to stderr, because it can hold a secret. To read it, run
the command of the server in a terminal, or open the log of your client.

**What to put in a bug report.** Open an issue at [github.com/yeeyon/toolscript-mcp](https://github.com/yeeyon/toolscript-mcp/issues).
For a vulnerability, follow [SECURITY.md](SECURITY.md) and do not open a public issue. Include:

- the package version, your Node version, your operating system and the name and version of your client
- the launch command of your client entry, with each credential removed
- the output of `doctor`, `tools <server>` and `runs --last 3`
- what you asked the model and what happened

`doctor`, `tools` and `runs` print no `env` or header value, no token, no tool description and no argument. Read the
output once before you post it anyway.

Do not include these:

- your config file, because it holds your `env` and `headers` values
- the output of `init --dry-run`, because a secret in an unusual form can stay visible
- `~/.claude.json`, the `~/.toolscript-mcp/oauth/` folder, or the stderr text of a server

## What was checked, and what was not?

The checks used the npm package `toolscript-mcp` 1.0.0 on Windows 11 with Node 22. A clean install in a new folder ran
the demo and reached the answer that this FAQ shows. `doctor`, `tools demo` and `runs` printed the lines above.
An MCP SDK test client drove the server. No real client registration was changed.
`@latest` now installs a later version. The checks were not run again on it.

| Path | Status |
| --- | --- |
| `cmd /c npx -y toolscript-mcp --config <path>` on Windows | Started in a test with the SDK client |
| `claude mcp add` commands for Claude Code | Checked against the README text. The `-e` form was run once with a test entry |
| Claude Desktop and Cursor JSON | Checked against the config format only |
| Codex TOML | Checked against the config format only. The README reports a smoke test with `codex exec` in Codex CLI 0.171.0 |
| `ask` prompt in each client | Tested with the MCP SDK client only. See [Limits](README.md#limits) |
