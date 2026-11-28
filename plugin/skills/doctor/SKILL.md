---
name: doctor
description: Check toolscript-mcp in Claude Code and name the fix for each problem. Run npm diagnostics, check the Claude Code registration and find direct copies of downstream servers. Use when the person asks to check, diagnose or troubleshoot toolscript-mcp.
argument-hint: "[<config>]"
---

# toolscript-mcp doctor

This skill checks a setup and explains each problem. It changes no setting or config. Each fix is a step
of `/toolscript:setup` or `/toolscript:start`, and the person decides when to do it. Each command here prints no secret
value.

The npm commands can fill the npm cache. doctor writes one temp file to check a folder, then removes it.
If doctor refreshes a server's OAuth tokens, it saves the new tokens in the same place as the running server.

## Rules

- Do not fix a problem in this skill. Name the step that fixes it, and let the person start that step.
- Never read, print or edit the toolscript-mcp config file, and never run `init --dry-run`. Both show the env and
  header values of the servers.
- `claude mcp get toolscript` can show environment values. Do not repeat them.
- Do not run `login`. Only the person runs it.
- Write each path in full, with forward slashes, also on Windows. Put each path in double quotes.
- If a command fails, show its output and go on with the next check.

The names in the commands:

- `<config>` is the toolscript-mcp config file.
- `<helper>` is `${CLAUDE_SKILL_DIR}/../setup/config.mjs`, the config helper of the setup skill.

## 1. Find the state

Run `claude mcp get toolscript`. Keep its output for step 3. In each path of its arguments, write each `\` as `/`.

- If there is no server or the entry uses a clone, tell the person to run `/toolscript:setup`, and stop.
- Check for `npx -y toolscript-mcp` or its Windows form `cmd /c npx -y toolscript-mcp`.
- If the scope is neither user nor local, stop. The project can share this entry.
- If its arguments hold `--config`, the next argument is the registered config.
- Otherwise, use the entry's `TOOLSCRIPT_CONFIG` if set, or the path that `node "<helper>" path` prints.
- If the person gave a config path, use it as `<config>`. Otherwise, use the registered config.
- If `<config>` holds `$`, a backtick, `"`, `%`, `!`, a curly quote or a long dash, stop. A shell can change such a path.
- If the package has a numeric version pin, keep that version in the npm commands below.
- If the entry uses a different launch command, give the steps for that command and stop.

## 2. Run doctor

Run `npx -y toolscript-mcp doctor --config "<config>"`.

doctor prints one line for each finding: the status, the check and the detail. The status is one of these:

- `ok`: the check passed.
- `info`: a fact for the person. It needs no fix.
- `warn`: a problem. toolscript-mcp still works, but a part of the setup is not as the person expects.
- `fail`: a problem that stops toolscript-mcp or a server. doctor exits 1.

Show the lines. Then explain each `warn` and `fail` line with the table in step 5.

## 3. Check the Claude Code registration

Use the output of step 1.

- It must show `Connected`. If not, the person starts a new Claude Code session. If it still fails, do `/toolscript:setup` step 5.
- If npm cannot start the package, use `/toolscript:setup` steps 2 and 3.
- The registered config must be `<config>`. On Windows, a path with `/` and the same path with `\` are the same path,
  and the case of the letters does not matter. If they differ, tell the person that the running server reads the
  registered config, not the config that doctor checked.

## 4. Check the clients

Run `npx -y toolscript-mcp init --list --config "<config>"`. It shows one line for each server of Claude Code, Claude Desktop
Cursor and Codex.

- A server with the status `in config` is in `<config>` and still in that client. The model can call it directly, and
  each full result goes into the context. Name the server, the client and the scope. `/toolscript:start` step 7
  removes the direct copy.
- A server with the status `name taken by a different entry` has the same name as a different server in `<config>`.
  Tell the person.

## 5. Explain each problem

For each `warn` and `fail`, give the cause and the step that fixes it:

| Check | Line | Fix |
| --- | --- | --- |
| `node` | `this Node` is older than 22.13 | `/toolscript:setup` step 2. |
| `node` | `sandbox.node` cannot run or is too old | The person changes `sandbox.node` in `<config>` in an editor, or removes it. |
| `config` | no config | `/toolscript:setup` step 4 writes it. |
| `config` | errors | Each error names a key. The person fixes the key in `<config>` in an editor. |
| `servers` | needs an OAuth login | `/toolscript:setup` step 10. The person runs the login command. |
| `servers` | cannot connect | Show the reason. `/toolscript:start` step 3 checks one server. `/toolscript:setup` step 9 shows the form of an entry. |
| `policy` | never decides a tool | An earlier rule matches each tool of this rule. `/toolscript:setup` step 7 writes the rules again in a new order. Put a hidden deny rule above the earlier rule, and do not remove it. A hidden allow or ask rule can move up, or the person can remove it. |
| `policy` | matches no tool | A wrong name, or a tool that the server removed. `/toolscript:setup` step 7. |
| `policy` | does not allow the tools of the Claude Code bridge | Only a rule that starts with `mcp__<bridge>__` allows them. `/toolscript:setup` step 8. |
| `sandbox` | no network block, no CPU limit | Windows has neither layer. [SECURITY.md](https://github.com/yeeyon/toolscript-mcp/blob/main/SECURITY.md) describes the sandbox. |
| `sandbox` | any `fail` line | The sandbox did not run `return 1`. Check the `node` lines first. Then `/toolscript:setup` step 3. |
| `workspace` | `unavailable` | The line names the reason. `/toolscript:workspace` adds, removes or checks a root. |
| `run-log` | off | The config sets `"log": false`. `/toolscript:start verify` needs the run log. The person removes the key in an editor. |
| `run-log` | newest run | `/toolscript:start verify` shows the calls of the run and the next step. |
| `files` | not writable | The person checks the permissions of `<home>/.toolscript-mcp`. |

An `info` line about a tool that needs a person at each run is not a problem. Its server asks for the person each time,
and no rule can replace that.

An `info` line about OAuth tokens that no server of this config uses is not a problem. All configs share the token
folder, so the tokens can belong to another config. The person deletes a named file only if no other config uses that
server.

End with a short list: each problem, and the step that fixes it. If no check shows a problem, the setup is ready. Then
offer `/toolscript:start` for a first run.
