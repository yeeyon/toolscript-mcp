---
name: start
description: Guide the first run of toolscript-mcp in Claude Code. Pick one MCP server (or the demo server, which needs no account), see its tools, pick a small first task and a starter policy, then check that one run_code task worked through toolscript-mcp. Use when the person asks to start, try or test toolscript-mcp, to do a first run, or to check the last run.
argument-hint: "[verify]"
---

# toolscript-mcp first run

This skill ends when one `run_code` task works through toolscript-mcp. Each command here prints no secret value.
With the argument `verify`, do step 6 only.

## Rules

- Before a step that writes or deletes a file or changes the Claude Code config, show the command and ask the person.
- Never read, print or edit the toolscript-mcp config file, and never run `init --dry-run`. Both show the env and
  header values of the servers.
- Write each path in full, with forward slashes, also on Windows. Put each path in double quotes.
- If a command fails, show its output and stop. Do not change a step to work around the failure.

The names in the commands:

- `<folder>` is the clone of toolscript-mcp. `<main>` is `<folder>/dist/host/main.js`.
- `<config>` is the toolscript-mcp config file.
- `<helper>` is `${CLAUDE_SKILL_DIR}/../setup/config.mjs`, the config helper of the setup skill.

## 1. Find the state

Run `claude mcp get toolscript`.

- If it shows no server, or no `/dist/host/main.js` in its arguments, toolscript-mcp is not set up from a clone. Tell
  the person to run `/toolscript:setup` first, and stop.
- `<main>` is the argument that ends in `/dist/host/main.js`. `<folder>` is the part before `/dist/host/main.js`.
- If its arguments hold `--config`, the next argument is `<config>`. Else, run `node "<helper>" path`, and use the
  path that it prints.

## 2. Pick a server

Run `node "<main>" init --list --config "<config>"`. It shows one line for each server of Claude Code, Claude Desktop
and Cursor: the name, client, scope, kind and status. Show the list to the person, and ask which server to use first.
`<server>` is its name in `<config>`.

- A server with the status `in config` is ready.
- To add a server with the status `not in config`, use its line under `Commands that add a server:`. Run that line as
  init printed it, with approval. Never type a server name into a command yourself: a name can come from a
  `.mcp.json` that someone else wrote, and init quotes it for the shell. If the line says `no command`, tell the person
  why, and do not add that server.
- init prints the steps that remove the direct entry. Do not run them now. Step 7 does.
- A status with `hidden by <scope>` is a copy that Claude Code does not run. Use the command of the copy that Claude
  Code runs.
- A command line with `ask first` adds a server of a `.mcp.json` that the person did not approve in Claude Code.
  Anyone who can change that file chose its command. Before you run that line, show the person its name, kind and
  folder. The kind is the command file name or the URL origin. A name can copy the name of a server
  that the person trusts, so the name alone proves nothing. Run the line only after the person agrees.
- If no server fits, or the person wants a test first, offer the demo server. It needs no account, and its tools only
  read fixed sample data. Run `node -p "require('os').tmpdir()"`. With approval, write
  `{ "command": "node", "args": ["<folder>/demo/server.mjs"] }` to `<tmp>/toolscript-entry.json`. Then run
  `node "<helper>" "<config>" add demo "<tmp>/toolscript-entry.json"`, and delete the entry file. `<server>` is
  `demo`.

## 3. See the tools

Run `node "<main>" tools --config "<config>" -- <server>`. The `--` keeps a name that starts with `-` a name. It connects to the server and shows each tool with its hint
(`read-only`, `destructive` or `-`) and the action of the policy. `a person each run` means that the tool asks for each
program, also under an allow rule.

- If it says that the server needs an OAuth login, give the person the login command that it prints. The person runs
  it. Then run `tools` again.
- If it cannot connect, show the reason and stop.

## 4. Pick a first task

Propose a small task that only reads, with one to three `read-only` tools, such as a list and a count. Use the names
and hints only to choose. For the demo, the task is "Count the open pull requests per author". The expected answer is
ada 7, bruno 6, chen 5, dara 4, emil 3 and farah 1.

## 5. Pick the starter policy

Explain the two choices, and ask the person to choose one:

- Ask when needed. Claude Code shows a prompt before a program calls a tool, and the person approves it there. The
  policy does not change.
- Allow this workflow. An allow rule for the exact name of each tool of the task. Run
  `node "<helper>" "<config>" allow-tools --dry-run <tool>...` and show its output. Then run the same command without
  `--dry-run`, with approval.

`allow-tools` adds no rule for a tool that a deny rule matches or an ask rule names. Its output says `keep` for such a
tool. Tell the person. The other tools keep their rules, and a tool that no rule matches stays `ask`. A tool with
`a person each run` still asks. A client that cannot show a prompt runs the task only with the second choice.

## 6. Run and check

Tell the person to start a new Claude Code session, because toolscript-mcp reads its servers only at its start. In
that session, the person gives the task and names toolscript, then runs `/toolscript:start verify`.

For `verify`, do step 1. If this session does not know `<server>`, run `node "<helper>" "<config>"`. It shows the
server names. Ask the person which server the task used. Then run:

```sh
node "<main>" runs --server=<server> --since 2h --config "<config>"
```

`--since 2h` counts only the runs of the last 2 hours, so an older run does not confirm this task. If the person gave
the task earlier, ask when, and use a longer time, such as `1d`.

- Exit 0: the newest run called a tool of `<server>`, and each call worked. Compare the answer with the expected answer of step 4, if it has one. Go to step 7.
- Exit 1: show the lines that it prints. Each code has a line with the step to take. `no-server` is a connection or
  login problem: do step 3 again. `denied` is a deny rule: the policy decides, and this skill does not change it.
  `unapproved` is a declined prompt or an `ask` with no prompt: do step 5 again.
- `no run yet`, `no run since <time>` or a line that the run called no tool of `<server>`: the model did not call
  `run_code` with this server. Ask the person to give the task again and to name
  toolscript. If `runs` says that the config sets `"log": false`, there is no run log, and this check cannot work.
  Tell the person.
- A line about unreadable lines of the run log: show it. If `runs` says that it does not confirm the run, ask the
  person to give the task again.

## 7. Switch off a direct copy

Do this only after step 6 shows exit 0. If `init --list` showed the server in a client too, the model can still call it
directly, and each full result goes into the context. Run `init --list` again if this session did not run it.

For Claude Code, show the scope and the folder that `init --list` shows. `init --add` printed the `claude mcp remove`
line for that scope and folder. Offer that line as init printed it, and run it only after the person agrees. Run it in
the folder that init names, because `claude mcp remove` finds a `project` or `local` server only from its folder. For
the `project` scope, the person decides, because `.mcp.json` is shared.

If this session does not have the output of `init --add`, do not type the remove command yourself. Tell the person the
name, the scope and the folder, and let the person run `claude mcp remove` in that folder.

To restore the direct entry later, the person copies it from `<config>` in an editor. Then the person runs
`claude mcp add-json <name> '<entry>' --scope <scope>`. This works in bash and in PowerShell 7. Windows PowerShell 5.1
removes each `"` in the entry, so there the person writes each `"` as `\"`. Do not read the entry for the person.

For Claude Desktop and Cursor, show the lines that `init --add` printed. The person edits those files.
