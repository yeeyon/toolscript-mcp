# Command line

Back to the [documentation index](../README.md#documentation).

## init

- `npx -y toolscript-mcp init` imports the user-scope servers of Claude Code, Claude Desktop, Cursor and Codex.
  To add servers from a project, use `--list` and `--add` below.
- If two clients have a server with the same name, init keeps the first one. The order is Claude Code, Claude
  Desktop, Cursor, Codex.
- Codex: init runs `codex mcp list --json`, then `codex mcp get <name> --json` for each server, at most 64 servers.
  It starts `codex` with no shell, in your home folder, with a 10 s limit and a 1 MB output cap for each call.
  If `codex` is not on `PATH`, or a call fails, init reads `config.toml` in `CODEX_HOME` (default `~/.codex`)
  with its own strict reader. The reader skips a server that it cannot read, and prints the reason.
- init reads the user scope of Codex only. It does not read the `.codex/config.toml` of a project, because Codex
  loads that file only for a project that it trusts. init says so when the file exists.
- init maps `command`, `args`, `env`, `cwd` and `url` of a Codex server. `env_vars = ["X"]` becomes `"X": "${X}"`
  in `env`. `bearer_token_env_var = "T"` becomes the header `Authorization: Bearer ${T}`. `http_headers` become
  `headers`. `env_http_headers = { H = "V" }` becomes the header `H: ${V}`.
- `disabled_tools` of a Codex server gives one `deny` rule for each tool. `enabled_tools` gives one `ask` rule for
  each tool, then one `deny` rule for the other tools of the server. init writes the rules in this order: the `deny` rules of tools,
  the `ask` rules, the `deny` rule of the other tools, and then the old rules, which keep their order. If the old
  policy denies a tool of an `enabled_tools` list, that tool gets a `deny` rule and no `ask` rule. An old `allow` rule
  never loosens a Codex list. No old rule changes. init prints the rules that it
  wrote. If two clients define the same server, init keeps the rules of Codex.
- init leaves out `http_headers_helper`, `startup_timeout_sec`, `tool_timeout_sec`, the per-tool `tools` tables and each
  key that it does not know. It prints each name with its reason. When it reads the CLI, it also reads `config.toml` for
  the names of the keys that `codex mcp get` does not show. It skips a server with `enabled = false`, and a server with a
  tool name that a rule cannot name. It also skips a server with a control character in its name, command, arguments,
  values or URL.
- For a Codex server with an OAuth login, init prints the `toolscript-mcp login` command. When init reads
  `config.toml`, it cannot see the login state.
- For Codex, init prints the TOML entry of toolscript, and `codex mcp remove <name>` for each imported server.
- init does not import an SSE server, a disabled server, or toolscript-mcp itself.
- init keeps the `cwd` of a stdio server. If that `cwd` is not an absolute path, only that server fails until you fix it.
- init sets `"untrusted": true` on each server that names Azure DevOps. The name, the command, an argument or the
  URL of such a server holds `azure-devops`, `azuredevops` or `mcp.dev.azure.com`, in any case. `azure_devops` and
  `azure devops` count too. See [Untrusted text](configuration.md#untrusted-text).
- On Linux and macOS, only your user account can read the config that init writes.
- `--dry-run` shows the config and the steps, and writes nothing. These values show as `***`:
  - the values of `env` and `headers`
  - the user, the password, each query value, each query part without `=`, each `;name=value` path value, and the
    fragment of a URL
  - a URL path segment or a word of 20 or more letters, digits, `_` and `-`, with letters and digits
  - the same long word with mixed case letters and also `. / + = : ~ %`, such as a JWT or a base64 key. A word
    that starts with `/`, `.`, `~` or a drive letter stays as it is.
  - the value of an argument whose name holds `key`, `token`, `secret`, `pass`, `pwd`, `auth`, `bearer`, `header`,
    `credential`, `cookie`, `session` or `dsn`
  - the value of an argument with the name part `pat`, `sig`, `sas` or `pw`, such as `GITHUB_PAT`
  - in a JSON argument, each value under a key with such a name, also nested, except a label such as `name` or `user`.
    Also the secrets in the other strings. The JSON shows on one line. A JSON argument nested too deep shows as `***`.
  - the value after `-t` or `-p`, unless the value is a number, a port such as `8080:80`, a path or a scoped package
  - the password of `user:password` after `-u`, `--user` or `--proxy-user`. A docker user and group such as `1000:1000` or
    `node:node` stays.
  - after `-H`, the value of a header with such a name, and the secrets in the value of a different header
  - the word after `Bearer` or `Basic`

  The forms are `--name value`, `--name=value`, `--name= value`, `NAME=value`, `Name: value` and the parts of
  `Server=db;Password=value`. An argument of several words, such as a `sh -c` script, gets the same rules word by
  word. Other arguments show as they are. If an argument holds a secret in a different form, do not share the output.
- `--force` replaces a config that exists. Before it does, init keeps the old config as `<config>.bak`. On Linux and
  macOS, the `.bak` file has mode 0600. It replaces an older `.bak` file. init lists the top-level keys and the
  servers of the old config that the new config leaves out or changes. Copy the parts that you need from the `.bak`
  file. Without `--force`, init does not change an existing config. With `--force`, `--dry-run` says what init
  replaces.
- `--config <path>` writes the config to a different path.
- The config from init has an empty `policy`, so each tool is `ask`.

To pick servers one at a time, use `--list` and `--add`. They also read the Claude Code servers of a project:

- `init --list` shows one line for each server of the client files: its name, client, scope, kind, status, key and folder. It writes nothing.
- The key is the name of the server in the config, which it has now or gets from `--add`. A key has only letters, digits, hyphens and single underscores. Give the key to `tools`, `login` and `runs`.
- The Claude Code scopes are `local`, `project` and `user`. Claude Code keeps the local servers in `~/.claude.json`, under the path of the project.
- Claude Code reads the project servers from the `.mcp.json` of the project folder and of each folder above it.
- If more than one scope has a server with the same name, Claude Code runs only one of them. The order is local,
  then the closest `.mcp.json`, then user. The status of each other server ends with `hidden by` and the scope that
  hides it.
- Claude Code skips a project server that you did not approve. If another scope has the name, the status of the
  project server ends with `Claude Code runs the`, then that scope.
- The folder is the project folder of a local server, or the folder of the `.mcp.json` file of a project server.
- `--project <dir>` names the project folder. The default is the current folder. Use the folder where you start Claude Code.
  In a git checkout, init reads the local servers of the main checkout, as Claude Code does. This also applies in a subfolder or a git worktree.
- The kind is `stdio` with the file name of the command, or `http` with the origin of the URL. The list shows no argument, env
  value, header value, URL path or query.
- A name with a blank or a character outside printable ASCII shows in double quotes. Such a character shows as a `\u`
  escape in each column and in the output of `--add`.
- The status is `in config`, `not in config`, `name taken by a different entry`, `toolscript itself`, or `skipped` with the reason.
- Claude Code runs a server of a `.mcp.json` file only after you approve it. The status of a project server that Claude
  Code has not approved ends with `not approved in Claude Code`. If you disabled it, the status ends with `disabled in Claude Code`.
- init reads these choices from `~/.claude/settings.json`, from `.claude/settings.json` and `.claude/settings.local.json`
  of the `--project` folder, and from `~/.claude.json`. The project files count only in a folder that you trust in
  Claude Code. init does not read managed settings, so a server that they approve shows as not approved.
- A server in `disabledMcpjsonServers` of any of these files is disabled.
- For `enableAllProjectMcpServers`, the first file that sets it counts, in this order: `.claude/settings.local.json`,
  `.claude/settings.json`, `~/.claude/settings.json`. A `true` in `~/.claude.json` counts only when
  `.claude/settings.local.json` does not set it. Claude Code decides the same way.
- `init --add <name>[,<name>...]` copies these servers into the config, with the same rules as the import. If there is no config, it makes one.
  If a name starts with `-`, write `--add=<name>`.
- Claude Code starts a stdio server of the local or project scope in the folder where the session starts. It does not
  read the `cwd` of the entry. So `--add` sets the `cwd` of such a server to the `--project` folder, and leaves out
  the `cwd` of the entry.
- `--add` keeps the other servers, the policy and the other keys of the config. It keeps the old file as `<config>.bak`.
- For a name in more than one Claude Code scope, `--add` takes the server that Claude Code runs. It names that scope and
  the scopes that it hides.
- `--add` changes nothing when a name is in the config already, in no client file, or in two clients with different
  entries. It also changes nothing for a project server that is not approved or disabled in Claude Code. This applies
  when no other scope has the name, or when `--from` picks the project server.
- `--unapproved` adds such a server. Use it only for a server that you trust: toolscript-mcp starts it without a question.
- `--from <client>[:<scope>]` picks the file of a name, for example `--from claude-code:user` or `--from cursor`.
- `--add` does not change the client files. It prints the steps that remove each server from its client. Do them after a run
  through toolscript-mcp works.

After the list, `init --list` prints a command for each server with the status `not in config`. It also prints the
steps that remove each direct copy of a server with the status `in config`:

```
Commands that add a server:
  - notes (claude-code:local)
    npx -y toolscript-mcp init --add=notes --project "/home/me/app" --config "/home/me/.config/toolscript-mcp/config.json"
  - alpha (claude-code:project, ask first: not approved in Claude Code)
    npx -y toolscript-mcp init --add=alpha --unapproved --project "/home/me/app" --config "/home/me/.config/toolscript-mcp/config.json"

Steps that remove a direct copy. Run the command lines of a step in order, in one shell.
  - gh (claude-code:local)
    pushd "/home/me/app"
    claude mcp remove --scope local "gh"
```

- Each command is alone on its line, under the line that names its server. That line starts with `- `.
- The command has the options that pick the server: `--from`, `--unapproved`, `--project` and `--config`.
- A server with `ask first` has `--unapproved` in its command. Run it only after you check the entry of the server in its file.
- In a step of Claude Code, a name that starts with `-` comes after `"--"`, as in `claude mcp remove --scope user "--" "-dash"`.
- `claude mcp remove` finds a local or project server only from its folder. So the step goes to that folder with `pushd` first.
  Run such a step in bash, zsh, fish, tcsh, cmd.exe or PowerShell. dash, the `sh` of Debian and Ubuntu, has no `pushd`.
- A name in a `.mcp.json` file comes from anyone who can change the project. So a command holds a name only when the
  name has only letters, digits and `. _ -`.
- A command holds a path only when the path has only ASCII letters, digits, spaces, a drive letter and `. _ - ( ) ~ / ' @ +`.
  Each path is in double quotes, with forward slashes on Windows.
- These characters pass unchanged in sh, bash, zsh, fish, tcsh, cmd.exe and PowerShell, also in an interactive shell.
- For any other name, init prints no command. It names the file, and you change the entry in an editor.
- If the path of toolscript-mcp or of the config has any other character, init prints no command and names the path.
  Run init again with a plainer `--config` path.
- If the project folder has any other character, init prints no command that needs `--project` or `pushd`.
  Run init again from a plainer folder, or give a plainer folder with `--project`.
- On Windows, Git Bash changes the `/c` of `cmd /c` in the step that adds toolscript to Claude Code. Run that step in PowerShell or cmd.exe.

## Doctor

`toolscript-mcp doctor [--config <path>]` checks the whole setup in one pass. Start it as you start `init`. It prints
to stderr.

Each line has a status, the name of the check and the detail. The status is `ok`, `info`, `warn` or `fail`. The
checks come in this order:

1. `node`: the version of this Node and of `sandbox.node`. Both must be 22.13 or later.
2. `config`: the config exists and has no errors. If it does not exist, doctor prints the `init` command.
3. `servers`: doctor connects to each server in parallel. Each line shows the tool count, the login command or the
   reason of the failure. It marks each server with `"untrusted": true`.
4. `share`: the share switch, and the class of each stdio server and the rule that decided. All lines are `info`.
5. `broker`: only when sharing is on and a server is `shared` or `folder`. Doctor finds the build of the broker and connects to it. It starts the broker when none runs. It checks the proof of the key in both directions. One line: `ok`, or `fail` with the reason and the ways out. For a peer that is not the broker, the line also names the way out for a taken name. On Windows, a second line shows the access rules of the broker folder. It is `warn` when a principal other than you, SYSTEM and Administrators has access. It starts no server.
6. `policy`: hidden rules, allow rules that match no tool, allow rules that skip a
   [Claude Code bridge](claude-code-bridge.md#claude-code-as-a-downstream-server), and the tools that require a person.
7. `sandbox`: the layers of this system, and a run of `return 1` in the real sandbox.
8. `run-log`: on or off, the path of the [run log](configuration.md#run-log), and the ending of the newest run. As in `runs`, it
   skips a run with a time more than 5 minutes after now, and counts these runs.
9. `files`: doctor can write to `~/.toolscript-mcp`. If that path or a folder above it is a file, the check fails. An
   `info` line names the OAuth tokens that no server of the config uses. They can belong to another config.

doctor skips the check for allow rules that match no tool when a server does not connect. The output never shows
tool descriptions, arguments, `env` or header values, or tokens. The exit code is 1 when a check fails, and 2 on a
usage error.

doctor changes no setting. It writes one temp file to check a folder, then removes it. If the server check refreshes
the OAuth tokens of a server, it writes the new tokens to the token store, as the running server does.

## Check a server and a run

Two commands check a setup, and `allow` adds the rules of a first task. Start them as you start `init`. They print to
stderr.

`toolscript-mcp tools <server> [--config <path>]` connects to one server of the config and lists its tools. The first
line is `<server>: connected, <n> tools`. Each next line shows one tool:

- the full name, such as `mcp__demo__list_pull_requests`
- the hint of the server: `read-only`, `destructive` or `-`
- the decision of the policy now: `allow`, `ask` or `deny`. The text `, a person each run` marks a tool that needs
  your approval at each run. See [Tools that require a person](configuration.md#tools-that-require-a-person).

If the server needs an OAuth login, `tools` prints the login command. If the server cannot connect, `tools` prints
the reason, with each control and format character as a `\u` escape. For a server with `"untrusted": true`, the reason does not show the error text of the server. The output
never shows tool descriptions, arguments, `env` or header values, or tokens. The exit code is 1 on a failure and 2 on a
usage error.

After the tools, `tools` prints an `allow` command for each tool that the policy asks for. The command follows the
rules of `init --list` for names and paths. A tool whose name has another character gets no command. The block names
the rule that refuses a tool that a deny rule matches or an ask rule names. The last command allows all such
`read-only` tools:

```
Commands that allow tools:
  - mcp__demo__get_pull_request
    npx -y toolscript-mcp allow --config "/home/me/.config/toolscript-mcp/config.json" "mcp__demo__get_pull_request"
```

`toolscript-mcp allow [--apply] [--config <path>] <tool>...` puts an allow rule for the exact name of each tool first
in the policy:

- Each tool is `mcp__<server>__<tool>`, with a server key of the config. The tool part has only letters, digits and
  `. _ -`. For any other name, `allow` exits 2 and changes nothing.
- `allow` never loosens a deny rule or an ask rule. It refuses a tool that the policy does not allow now if a deny
  rule matches it or an ask rule names it. It prints `refused:` with the rule and the edit to make by hand, writes
  nothing and exits 2.
  If the run names other tools too, it writes nothing for them. It prints the command with `--apply` for the tools
  that it can add.
- A tool that the policy allows now gets no new rule. An allow rule with the exact name below an earlier rule moves
  to the top.
- Without `--apply`, `allow` writes nothing. It shows the new policy and the command with `--apply` that writes it.
- With `--apply`, it writes the config with mode 0600 and keeps the other keys of the config.
- A running toolscript-mcp reads the policy again at each run. It asks you to approve a new allow rule before it
  applies. If your client cannot ask, restart toolscript-mcp.

`tools` and `search_tools` never show what a stdio server writes to stderr. That text can hold a secret that is not
in the config. If the server wrote to stderr, the reason says so. To read that text, run the command of the server in a terminal. When
your client starts toolscript-mcp, the log of the client also holds that text.

`toolscript-mcp runs [--server <key>] [--last <n>] [--since <time>] [--config <path>]` reads the
[run log](configuration.md#run-log). It shows the newest `n` runs that call a tool of the server, newest first. The default of `n`
is 1. Without `--server`, it shows the newest runs of all servers.

- For each run, it shows the time, the ending and the duration.
- For each call, it shows the tool, the policy decision, and `ok` or the error code. A `tool-error` or `failed` call
  that reached its server also shows its error class after the code. A call that `runs` cannot read
  shows as `unreadable`. A call with `ok` is also `unreadable` when it has an error code, or the decision `denied`, `unapproved` or `invalid`.
- After the runs, one line counts the classes of the failed calls shown, such as
  `classes of failed calls: validation 2, not-found 1, no class 3`. `no class` counts the `tool-error` and `failed`
  calls that have none, such as the calls that an older version logged.
- Then it gives one next step for each problem.
- It counts the lines of the log that are not runs, and skips them.
- It skips a run with a time more than 5 minutes after now, and counts these runs.

With `--since`, `runs` counts only the runs at or after that time. The time is an ISO 8601 time with a zone, such as
`2026-11-18T09:30:00Z`, or a duration back from now: `30m`, `2h` or `1d`. The first line shows the time in UTC. To
check a new attempt, give a time before its task. Then an older run does not confirm the attempt.

A name or time with a character outside printable ASCII shows in double quotes, with that character as a `\u` escape.
If your server uses a config at another path, give the same `--config`. Then the `tools` command in a next step names
that config.

The exit code is 0 only when the newest run ended `done`, called a tool of the server, and each call of the server
worked. Without `--server`, the run must call a tool of any server. These cases also give the exit code 1:

- The log has no run. `runs` prints `no run yet`.
- No run is at or after the time of `--since`. `runs` prints `no run since <time>`.
- An unreadable line or a skipped run is newer than the newest run shown. That line can be a newer run.
- The log does not hold all calls of the newest run. The log holds at most 200 calls of a run.
- The config sets `"log": false`. `runs` says so in its first line.
- `runs` cannot read the config of `--config`.
