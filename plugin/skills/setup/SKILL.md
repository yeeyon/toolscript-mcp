---
name: setup
description: Install, update or uninstall toolscript-mcp from its GitHub beta branch and connect it to Claude Code. Use when the person asks to set up, install, update or remove toolscript-mcp. Also use it to add an MCP server to toolscript-mcp, let programs use the tools of Claude Code, log in to an OAuth server through it, or change its policy.
argument-hint: "[install|update|add|login|policy|native|uninstall]"
---

# toolscript-mcp setup

toolscript-mcp is an MCP server for code mode. The model writes one JavaScript program that calls the tools of other
MCP servers in a sandbox. This skill installs it from the `beta` branch of
[github.com/yeeyon/toolscript-mcp](https://github.com/yeeyon/toolscript-mcp) and connects it to Claude Code.

## Rules

- Before a step that writes or deletes a file, installs packages or changes the Claude Code config, show the command
  and ask the person.
- Never read, print or edit the toolscript-mcp config file, and never run `init --dry-run`. Both show the env and
  header values of the servers. Use `config.mjs` to show and change the config.
- Never edit the config file of a client. Show the lines to change. Change Claude Code only with `claude mcp`
  commands that the person approves.
- Write each path in full, with forward slashes, also on Windows. Put each path in double quotes. Some shells and
  `claude mcp add` do not expand `~`.
- If a command fails, show its output and stop. Do not change a step to work around the failure.

The names in the commands:

- `<folder>` is the clone of toolscript-mcp.
- `<main>` is `<folder>/dist/host/main.js`.
- `<config>` is the toolscript-mcp config file.

## 1. Find the state

Run `claude mcp get toolscript`.

- If its arguments hold `/dist/host/main.js`, that path is `<main>`. `<folder>` is the part of `<main>` before
  `/dist/host/main.js`.
- If its arguments hold `--config`, the next argument is `<config>`. Else, run
  `node "${CLAUDE_SKILL_DIR}/config.mjs" path`, and use the path that it prints.
- If it shows `npx` and no `<main>`, toolscript-mcp runs from npm. To move to a clone, do step 3, then step 5.
- If it shows no server, toolscript-mcp is not in Claude Code.

Go to the step for the request of the person. For `native`, do step 7. With no request, do steps 2 to 6, then offer step 7.

## 2. Check Node and git

Run `node --version` and `git --version`.

- If Node is older than 22.13 or missing, stop. Tell the person to install Node 22.13 or later.
- If git is missing, stop. Tell the person to install git.

## 3. Install or update

If step 1 found no `<folder>`, run `node -p "require('os').homedir()"`. Propose `<home>/toolscript-mcp` as
`<folder>`. The person can choose a different folder.

Run `git -C "<folder>" remote get-url origin`.

- If the URL ends in `/toolscript-mcp` or `/toolscript-mcp.git`, update the clone.
- If git cannot change to the folder, the folder does not exist. Install toolscript-mcp.
- In other cases, the folder holds something else. Stop, and ask for a different folder.

To update:

1. Run `git -C "<folder>" pull --ff-only`.
2. Run `npm ci --prefix "<folder>"`. It also builds `dist/`.
3. Tell the person to start a new Claude Code session. The running session keeps the old server.

To install:

1. Run `git clone --branch beta https://github.com/yeeyon/toolscript-mcp.git "<folder>"`.
2. Run `npm ci --prefix "<folder>"`. It also builds `dist/`.

## 4. Write the config

If step 1 found no `<config>`, run `node "${CLAUDE_SKILL_DIR}/config.mjs" path`. The path that it prints is `<config>`.

Run `node "${CLAUDE_SKILL_DIR}/config.mjs" "<config>"`.

- If it lists servers, the config exists. Keep it, and go to step 5.
- If it cannot read the file, there is no config yet. Continue with this step.

Tell the person that init reads the user-scope MCP servers of Claude Code, Claude Desktop and Cursor. It writes
`<config>` and does not change the files of the clients. With approval, run:

```sh
node "<main>" init --config "<config>"
```

init prints the servers that it imported and the servers that it left out, with no secret values. Show this list to
the person. If init found no server, it writes nothing. Then add servers with step 8.

init also prints the steps for each client. They start toolscript-mcp with `npx -y toolscript-mcp`, or
`cmd /c npx -y toolscript-mcp` on Windows. A clone uses `node "<main>"` in place of each of these.

Show the person the servers to remove from each client. For Claude Code, offer to run each
`claude mcp remove <name> --scope user` line. Run a line only after the person agrees. The person edits the files of
the other clients.

Recommend one path to each server. If a client also lists a server directly, the model calls the direct tools, and
each full result goes into the context. MCP gives a server no list of the servers of its client. So toolscript-mcp does
not check for a duplicate while it runs. init imports only the user-scope servers, so run `claude mcp list` to find the
other copies.

If the person wants a new import over a config that exists, run init with `--force` after approval. init keeps the old
file as `<config>.bak`, and it lists the servers that the new config leaves out.

## 5. Add toolscript-mcp to Claude Code

If step 1 showed a server with the same `<main>` and `<config>`, skip this step. If it showed a different
command, ask to run `claude mcp remove toolscript --scope user` first.

With approval, run:

```sh
claude mcp add --scope user toolscript '--' node "<main>" --config "<config>"
```

Keep the quotes around `--`. PowerShell drops a bare `--` before it starts `claude`. `node` is an executable on
each system, so Windows needs no `cmd /c` here.

Run `claude mcp get toolscript`. It must show `Connected`.

For Claude Desktop and Cursor, show the entry for `mcpServers`. The person adds it:

```json
"toolscript": { "command": "node", "args": ["<main>", "--config", "<config>"] }
```

Tell the person to start a new Claude Code session, so the session gets `search_tools` and `run_code`.

## 6. Choose the policy

Run `node "${CLAUDE_SKILL_DIR}/config.mjs" "<config>"`. It shows the servers and the policy, and no secret.

Each tool call of a program goes through the policy. A tool name is `mcp__<server>__<tool>`. The first rule whose
`match` glob fits the name decides. A tool that no rule matches is `ask`.

Explain these choices, and ask the person to choose one:

1. Ask for each tool. This is the empty policy that init writes. toolscript-mcp asks the person before a program
   calls a tool. If the client cannot ask, the run does not start, and the result names the `allow` rule to add.
2. Allow all tools, with `deny` rules first. Use it when the client checks each `run_code` call itself, such as
   Claude Code in auto mode. Add a `deny` rule for each tool that must never run. Tell the person that the permission
   rules and hooks of Claude Code do not apply to the nested calls. The policy matches tool names only, not arguments.
3. Allow specific tools. Allow the tools that programs use often, such as read tools. Other tools stay `ask`.

The `policy` command replaces the policy with the rules in order. Each rule is an action and a match that starts with
`mcp__` or `*`:

```sh
node "${CLAUDE_SKILL_DIR}/config.mjs" "<config>" policy
node "${CLAUDE_SKILL_DIR}/config.mjs" "<config>" policy deny "mcp__<server>__*delete*" allow "*"
node "${CLAUDE_SKILL_DIR}/config.mjs" "<config>" policy allow "mcp__<server>__get_*" allow "mcp__<server>__search_*"
```

Ask the person for the rules, and run the command with approval. Show the policy that it prints.

The command gives no tool of `claude-code` a looser decision than the old policy, unless a new rule that starts with
`mcp__claude-code__` decides that tool. Without this check, `allow "*"` allows every tool of Claude Code with no
prompt. For each other tool that a new rule loosens, the command adds a rule with the old decision. It does this also
when the config has no `claude-code` server. It prints the added rules under "added these rules for the tools of
claude-code". Show them to the person.

To open a tool of Claude Code, the person names it in a rule, such as `allow "mcp__claude-code__Read"`. To open all
of them, the person gives `allow "mcp__claude-code__*"`. Put these rules before a `*` rule.

Never allow a tool that can write the config file, such as a file server with access to its folder. A program can call
that tool to change its own policy.

If toolscript-mcp runs, it reads the policy again at each run. A new `deny` rule applies at once. A looser policy
applies after the person approves it in a prompt, or after a restart of toolscript-mcp.

## 7. Use the tools of Claude Code in programs

With this step, programs call the Read, Grep, Glob, Edit and Bash or PowerShell tools of Claude Code. toolscript-mcp starts
`claude mcp serve` as the server `claude-code`.

1. Find the `claude` executable. Its path is `<claude>`.
   - On Windows, run `where.exe claude`. Use the first line that ends in `claude.exe`. Never use `claude.ps1` or
     `claude.cmd`. If no line ends in `claude.exe`, stop, and tell the person that this step needs `claude.exe`.
   - On Linux and macOS, run `command -v claude`, and use the path that it prints.
2. Ask for the project folder `<project>`. Propose the folder of the current project. Bash commands start there, and
   Grep and Glob search there.
3. Tell the person these risks, and ask whether to continue:
   - The permission rules and hooks of Claude Code do not apply on this path. The toolscript-mcp policy is the only
     check.
   - The policy matches tool names only. If the person approves `Bash` for a run, each Bash command of that program
     runs.
   - Bash, PowerShell, Edit and Write run as the person. They reach files outside `<project>`, also `<config>`.
   - If a hook or a permission rule guards a tool, use the native tool of Claude Code for that work.
   - The section "Claude Code as a downstream server" of `<folder>/README.md` gives the full risks.
4. With approval, put these rules first in the policy. They allow Read, Grep and Glob, ask for the tools that change
   something, and deny the other tools of Claude Code:

   ```sh
   node "${CLAUDE_SKILL_DIR}/config.mjs" "<config>" prepend allow "mcp__claude-code__Read" allow "mcp__claude-code__Grep" allow "mcp__claude-code__Glob" ask "mcp__claude-code__Bash" ask "mcp__claude-code__PowerShell" ask "mcp__claude-code__Edit" ask "mcp__claude-code__Write" deny "mcp__claude-code__*"
   ```

   If the person does not approve, stop, and do not add the server. Without these rules, an old rule such as
   `allow "*"` can allow every tool of Claude Code.

   `prepend` keeps the other rules of the person after these rules. It replaces an old rule with the same match. It
   gives no tool of `claude-code` a looser decision than an old rule gives it. For such a tool, it adds a rule with the
   old decision. Show the policy that it prints. If it prints rules under "added these rules for the tools of
   claude-code", tell the person. To open such a tool, the person gives all the rules in the `policy` command, with a
   rule that names the tool. Never allow Bash, PowerShell, Edit or Write. They can change `<config>`, and so the
   policy.
5. Run `node "${CLAUDE_SKILL_DIR}/config.mjs" "<config>"`. If it lists `claude-code`, the server exists. Go to item 7.
6. Run `node -p "require('os').tmpdir()"`. With approval, write this entry to `<tmp>/toolscript-entry.json`:

   ```json
   { "command": "<claude>", "args": ["mcp", "serve"], "cwd": "<project>" }
   ```

   Then run `node "${CLAUDE_SKILL_DIR}/config.mjs" "<config>" add claude-code "<tmp>/toolscript-entry.json"`, and
   delete the entry file.
7. Tell the person to start a new Claude Code session. toolscript-mcp starts its servers only at its own start.

## 8. Add a server

1. Ask for the server name. A name has letters, digits and hyphens, with single underscores between them.
2. Ask for the command and arguments of a stdio server, or the URL of an HTTP server.
3. Never ask for a secret value. Write `${NAME}` in its place. toolscript-mcp reads `NAME` from its environment.
4. Run `node -p "require('os').tmpdir()"`. With approval, write the entry to `<tmp>/toolscript-entry.json`:
   - stdio: `{ "command": "npx", "args": ["-y", "<package>"], "env": { "API_KEY": "${API_KEY}" } }`
   - stdio that works in one project folder: also add `"cwd": "<folder>"`, with the full path of the folder.
   - HTTP: `{ "type": "http", "url": "https://mcp.example.com/mcp" }`
5. Run `node "${CLAUDE_SKILL_DIR}/config.mjs" "<config>" add <name> "<tmp>/toolscript-entry.json"`. It makes `<config>` if it does not exist.
   Then delete the entry file.
   If `claude mcp list` shows the same server, run `claude mcp get <name>` to find its scope. Step 4 tells why.
   - For the user or local scope, offer to run `claude mcp remove <name> --scope <scope>`.
   - For the project scope, tell the person that `.mcp.json` of the project holds the server. Other people can share
     that file, so the person decides.
6. Tell the person to set each variable in the environment of the client, or to put the value in `<config>` in an
   editor.
7. Tell the person to start a new Claude Code session. toolscript-mcp reads the servers only at its start.

An HTTP server without `headers` logs in with OAuth. Go to step 9 for it.

## 9. Log in to an OAuth server

init lists the HTTP servers without headers, and `config.mjs` marks them `oauth`. For each one, give the person
this command:

```sh
node "<main>" login <server> --config "<config>"
```

The person runs it. Do not run it yourself. A browser opens, and login waits 5 minutes for the approval. In Claude
Code, the person can type the command after the `!` prefix.

If `search_tools` later says that a server needs a login, its command starts with `npx -y toolscript-mcp`. Give the
person the command above in its place.

## 10. Uninstall

Ask before each step:

1. Run `node "${CLAUDE_SKILL_DIR}/config.mjs" "<config>"`. It shows the server names. The full entries stay in `<config>`. Tell the person to
   copy the entries that they want back to their clients from `<config>` in an editor.
2. Run `claude mcp remove toolscript --scope user`.
3. Delete `<folder>`, then `<config>` and `<config>.bak`. Delete each path with
   `node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true })" "<path>"`.
4. `<home>/.toolscript-mcp` holds the OAuth tokens, the run log and the files of programs. Delete it only on request.
5. To remove this plugin, the person runs `/plugin uninstall toolscript@toolscript-mcp`, then
   `/plugin marketplace remove toolscript-mcp`.

## What stays on this computer

Tell the person these facts at the end of an install:

- The config, with the env and header values of the servers, stays in `<config>`. This skill never reads it.
- OAuth tokens stay in `<home>/.toolscript-mcp/oauth/`. The run log in `<home>/.toolscript-mcp/runs.jsonl` has
  no arguments and no results.
- toolscript-mcp sends tool calls only to the servers in the config. The model gets the search results and the return
  value of each program.
- `<folder>/SECURITY.md` describes the sandbox and its limits. On Windows, the sandbox has no network block.
