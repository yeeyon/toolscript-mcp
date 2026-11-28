# Claude Code as a downstream server

Back to the [documentation index](../README.md#documentation).

`claude mcp serve` runs Claude Code as a stdio MCP server. With it in your config, one program can find, read and
edit the files of a project and run its tests. The program returns only the result, for example the failing test lines.

This bridge is optional, and it gives programs a shell. Read [The risks](#the-risks) before you add it.

## The entry and the policy

Add the entry to `mcpServers`, and the rules to `policy`, in your config:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "C:/Users/me/.local/bin/claude.exe",
      "args": ["mcp", "serve"],
      "cwd": "C:/work/my project"
    }
  },
  "policy": [
    { "match": "mcp__claude-code__Read", "action": "allow" },
    { "match": "mcp__claude-code__Grep", "action": "allow" },
    { "match": "mcp__claude-code__Glob", "action": "allow" },
    { "match": "mcp__claude-code__Bash", "action": "ask" },
    { "match": "mcp__claude-code__PowerShell", "action": "ask" },
    { "match": "mcp__claude-code__Edit", "action": "ask" },
    { "match": "mcp__claude-code__Write", "action": "ask" },
    { "match": "mcp__claude-code__*", "action": "deny" }
  ]
}
```

- On Windows, `command` is the full path of `claude.exe`. To find it, run `(Get-Command claude.exe).Source` in
  PowerShell.
- Do not use the `claude.ps1` or `claude.cmd` shim on Windows. In a test, the `claude.ps1` shim did not connect.
- On Linux and macOS, `command` is `claude`.
- `cwd` is the folder of the project. Bash commands start there, and Grep and Glob search there.
- Without `cwd`, Claude Code works in the folder where your client started toolscript-mcp.
- Put the rules before a broad `deny` or `ask` rule, such as `{ "match": "*", "action": "deny" }`. The first rule that
  matches decides.
- The last rule denies the other tools of Claude Code, for example `Agent`, `WebFetch` and `CronCreate`.
- `ask` needs a client with MCP elicitation. If your client cannot ask, toolscript-mcp refuses each `ask` tool.

toolscript-mcp treats a server as the bridge in these cases:

- Its key is `claude-code`.
- It is a stdio server, and its command and arguments have the Claude Code word, then `mcp`, then `serve`. Any
  words can come between these words, such as `--model opus` or `--settings C:/s.json`.

The Claude Code word is one of these:

- `claude`, `claude.exe`, `claude.cmd` or `claude.ps1`, alone or at the end of a path.
- The npm package `@anthropic-ai/claude-code`, also with a version, such as `@anthropic-ai/claude-code@latest`.
- A path that ends in `claude-code/cli.js` or `claude-code/cli.mjs`, with either slash.

A launcher can come first, such as `cmd /c`, `bash -lc`, `pwsh -Command`, `npx -y`, `pnpm dlx` or `bunx`.
toolscript-mcp splits each argument at its spaces, at the shell operators `; & | ( ) < > $` and the backtick, and at
commas, which PowerShell uses in argument lists. It
skips quotes and the `^` of cmd. So `"claude mcp serve"` in one argument, `cmd /c "cd /d C:\work&&claude mcp serve"`
and `bash -c "(claude mcp serve)"` also count. A launch that is no bridge but has these words in this order counts as
a bridge too: toolscript-mcp then asks for its tools. At start,
toolscript-mcp writes the keys of the bridges to stderr, such as `Claude Code bridges: claude-code`.

Use the key `claude-code` for any other launch (an HTTP proxy, a wrapper script). toolscript-mcp cannot find Claude
Code behind such a launch.

A tool of the bridge skips the permission rules and hooks of Claude Code. So an `allow` rule
allows it only when the `match` starts with `mcp__<key>__`, with the key of the bridge. A broad `allow` rule, such as
`*`, does not allow it. For example, with this policy:

```json
"policy": [
  { "match": "mcp__claude-code__Read", "action": "allow" },
  { "match": "*", "action": "allow" }
]
```

- `mcp__claude-code__Read` runs with no prompt.
- Each other tool of Claude Code is `ask`, also a tool that a later version of Claude Code adds.
- The tools of the other servers run with no prompt.

To allow every tool of the bridge, add `{ "match": "mcp__claude-code__*", "action": "allow" }`. Read
[The risks](#the-risks) first.

## The risks

Keep `Bash`, `PowerShell`, `Edit` and `Write` on `ask`. On this path, the toolscript-mcp policy is the only check
on what a program does.

- The permission rules and hooks of Claude Code do not apply. In a test, a project `deny` rule did not stop a Bash
  command, and no hook ran.
- The policy matches tool names only. If you approve `Bash` for a run, each Bash command of that program runs, with
  any command text.
- Bash and PowerShell run as your user. They can reach the network and any folder, also outside `cwd`.
- Write and Edit take any absolute path, also outside `cwd`. In a test, a Write outside the project folder succeeded.

If a hook or a permission rule guards a tool of Claude Code, use the native tool for that work, not a program. A
program that calls Bash skips each `PreToolUse` hook on Bash, for example a guard on `git push`.

## In a program

- A command that exits with an error throws. The error message starts with `Exit code N` and holds the output. Use
  `try` and `catch` to read the output of a failing test.
- Grep and Glob return paths relative to `cwd`, with `\` on Windows. Read and Edit take an absolute `file_path`, so
  join each path to `cwd` first.
- A call that takes longer than `sandbox.callTimeoutSeconds` (default 60 s) throws, and toolscript-mcp cancels it.
- For a longer test run, raise `sandbox.callTimeoutSeconds` and `sandbox.timeoutSeconds`, and give Bash a
  `timeout` in milliseconds.

This program finds a line, reads its file and runs the tests. If you approve `Bash`, it returns the pass and fail
counts, also when a test fails:

```js
const cwd = 'C:/work/my project'
const hits = await call('mcp__claude-code__Grep', { pattern: 'DEFAULT_RETRIES =', output_mode: 'content', '-n': true })
const [path, line] = hits.content.split('\n')[0].split(':')
const file = await call('mcp__claude-code__Read', { file_path: `${cwd}/${path.replaceAll('\\', '/')}` })
let test
try {
  test = (await call('mcp__claude-code__Bash', { command: 'npm test' })).stdout
} catch (err) {
  test = err.message
}
return { path, line, lines: file.file.numLines, test: test.split('\n').filter(l => /^# (pass|fail)/.test(l)) }
```

## Tested with Claude Code 2.1.332

An agent ran these tests on 2026-11-28 with no person at the keyboard. The platform is Windows 11 (10.0.26300) with Node 22.
Nothing was run on Linux or macOS. A fact that no run checked again keeps its version in
[Measured with Claude Code 2.1.325](#measured-with-claude-code-21325).

The launch command was `claude.exe mcp serve`, with `cwd` set to a test project. The entry used the full path of
`claude.exe`, found by a search of `PATH`. The `claude.ps1` shim was never started.

### The tools

On Windows, `claude mcp serve` listed 24 tools: Agent, CronCreate, CronDelete, CronList, DesignSync, Edit,
EnterWorktree, ExitWorktree, Glob, Grep, ListAgents, NotebookEdit, PowerShell, Read, ReportFindings, ScheduleWakeup,
SendMessage, Skill, TaskStop, ToolSearch, WebFetch, WebSearch, Workflow and Write. There was no `Bash` tool. Use
`PowerShell` on Windows. The test file `tests/bridge.e2e.mjs` runs this case and needs `claude` on `PATH`.

### One program through the bridge

The allow rules were `mcp__claude-code__Grep`, `Read`, `Edit` and `PowerShell`, and no broader rule. One program found
`function add` with Grep, read the file, changed `return a - b` to `return a + b` with Edit, and ran `node --test`
with PowerShell. It threw if the output lacked `pass 1` and `fail 0`. It passed in 4 of 4 runs and returned this:

```json
{ "grep": true, "pass": true, "fail0": true }
```

The file on disk held the new text. The run log listed Grep, Read, Edit and PowerShell in order, each with `ok: true`.

### A missing command

If the command of the bridge does not exist, toolscript-mcp still starts and `search_tools` answers. It lists the
server under `Not connected`:

```text
- claude-code: MCP error -32000: Connection closed. Its stderr is not shown here. ...
```

A program that calls a bridge tool then gets this error. The text names the key, and it does not name the command:

```text
the MCP server "claude-code" is not connected: MCP error -32000: Connection closed. ...
```

### What prompts in each permission mode

Each run used only toolscript-mcp as the MCP server in Claude Code. The model was asked for one `run_code` call. The
policy was `Read` allow, `Edit` ask and the rest of the bridge deny. Two prompts can show:

- The host prompt of Claude Code: `Do you want to proceed?` for the tool of toolscript-mcp, with the choices Yes, Yes and
  do not ask again, and No.
- The form of toolscript-mcp, which Claude Code shows as `MCP server "toolscript" requests your input`. It names the
  tool that no rule allows, and has Accept and Decline.

In a W cell the program read the file and edited it. In the first run the script accepted each prompt. In a second run
in the same session it declined the form, and the run log showed `unapproved` for Edit.

| Mode | Program | `run_code` in `--allowedTools` | Host prompt | Form of toolscript-mcp |
| --- | --- | --- | --- | --- |
| default | R (Read) | no | yes | no |
| default | R (Read) | yes | no | no |
| default | W (Edit) | no | yes | yes |
| default | W (Edit) | yes | no | yes |
| auto | R (Read) | no | no | no |
| auto | R (Read) | yes | no | no |
| auto | W (Edit) | no | no | yes |
| auto | W (Edit) | yes | no | yes |
| plan | R (Read) | no | yes | no |
| plan | R (Read) | yes | yes | no |
| plan | W (Edit) | no | not observed | not observed |
| plan | W (Edit) | yes | yes (second try only) | yes (second try only) |
| dontAsk | R (Read) | no | no, denied | no |
| dontAsk | R (Read) | yes | no | no |
| dontAsk | W (Edit) | no | no, denied | no |
| dontAsk | W (Edit) | yes | no | yes |

- Accept ran the call, and Edit changed the file. Decline refused the call, and the file did not change again.
- In dontAsk mode with `run_code` not allowed, Claude Code denied the tool with this text, and the run log stayed empty:
  `Permission to use mcp__toolscript__run_code has been denied because Claude Code is running in don't ask mode.`
- In plan mode, the host prompt showed also when `run_code` was in `--allowedTools`.
- In auto mode, no host prompt showed for `run_code`, with or without `--allowedTools`.

With `claude -p` there is no screen, so no prompt can show. The W program ran with these results:

| Mode | `run_code` in `--allowedTools` | Result |
| --- | --- | --- |
| default | no | Claude Code refused: `Claude requested permissions to use mcp__toolscript__run_code, but you haven't granted it yet.` |
| default | yes | The program did not run. toolscript-mcp refused Edit as not approved. |
| auto | no or yes | The program did not run. toolscript-mcp refused Edit as not approved. |
| dontAsk | no | Claude Code denied the tool, as in the table above. |
| dontAsk | yes | The program did not run. toolscript-mcp refused Edit as not approved. |
| plan | no or yes | Not observed. |

So in `claude -p`, an `ask` tool of the bridge never runs. Put an `allow` rule for it in the config if you need it
there. Read [The risks](#the-risks) first.

### Not observed

- Plan mode with an Edit program: the model made no `run_code` call in 2 tries on Haiku and 2 on Sonnet. It said that plan
  mode forbids the edit. The accept path of this cell was not shown. The `claude -p` plan cells also made no call.
- Which model plan mode runs in the TUI. The `claude -p` result named Sonnet 5.5, although Haiku was set.
- Linux and macOS.
- The answer "Yes, and do not ask again" of the host prompt.

## Measured with Claude Code 2.1.325

These numbers are from Claude Code 2.1.325 on Windows 11, with Node 22.

- `tools/list` answered about 1.5 s after the start of `claude mcp serve`.
- The first Bash call of each server took about 9 to 10 s. Later Bash calls took 1 to 5 s.
- Glob, Grep, Read and Edit calls took less than 0.6 s.
- Each `claude mcp serve` process used about 205 MB of memory when idle. After Bash and Edit calls, its private
  memory was about 390 MB.
- `claude mcp serve` lists 30 built-in tools. It does not start the MCP servers of your Claude Code config, so it
  does not start toolscript-mcp again.
