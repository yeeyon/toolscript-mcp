# Bench target: Codex

This file is the test plan for the Codex arms of the bench. Run it on a machine with Codex and an OpenAI login. It
uses the same 6 tasks, the same fake MCP server and the same checks as `bench/run.mjs`, so the results compare with
the Claude Code arms in `bench/RESULTS.md` and `bench/RESULTS-codemode.md`.

## Arms

| Arm | Codex code mode | MCP servers that Codex sees |
| --- | --- | --- |
| `codex-direct` | off | `bench` (the fake server) |
| `codex-codemode` | on | `bench` (the fake server) |
| `codex-toolscript` | off | `toolscript` (toolscript-mcp, which runs the fake server as `bench`) |

Use one model for all three arms. Write down its exact name and the Codex version.

## Setup

1. Install Node 22.13 or later, and Codex. Log in to Codex.
2. Get the repo and build it:

   ```sh
   git clone https://github.com/yeeyon/toolscript-mcp.git
   cd toolscript-mcp
   npm ci
   npm run build
   ```

3. Find the name of the code mode feature in your Codex version. Look in `codex --help`, `codex features list` (if
   your version has it) and the Codex release notes. Code mode is experimental and opt-in. Write down the exact flag
   or config key that turns it on.
4. Check that code mode turns on with that flag. In a test run, the event stream must show the code mode tool (an
   `exec` or JavaScript tool), not only direct MCP tool calls. If it does not turn on, stop and record why.
5. List the tasks with `node bench/check.mjs --list`. Each line has the task id, the prompt and the expected answer.

## One run

Do each run in a new empty folder, with a new log file. `<repo>` is the full path of the clone.

1. Make the MCP config of the arm. For `codex-direct` and `codex-codemode`:

   ```toml
   [mcp_servers.bench]
   command = "node"
   args = ["<repo>/bench/fake-server.mjs"]
   env = { BENCH_LOG = "<run folder>/calls.jsonl" }
   default_tools_approval_mode = "approve"
   ```

   Keep `default_tools_approval_mode = "approve"` in every arm. Without it, `codex exec` refuses every MCP call.

   For `codex-toolscript`, write a toolscript-mcp config file `<run folder>/toolscript.json`:

   ```json
   {
     "mcpServers": {
       "bench": {
         "command": "node",
         "args": ["<repo>/bench/fake-server.mjs"],
         "env": { "BENCH_LOG": "<run folder>/calls.jsonl" }
       }
     },
     "policy": [{ "match": "mcp__bench__*", "action": "allow" }]
   }
   ```

   Then give Codex only this server:

   ```toml
   [mcp_servers.toolscript]
   command = "node"
   args = ["<repo>/dist/host/main.js", "--config", "<run folder>/toolscript.json"]
   default_tools_approval_mode = "approve"
   ```

   The toolscript-mcp policy still decides each nested call, so the `allow` rule above stays.

2. Give Codex no other MCP server, no web search and no shell, if your version allows that. Write down what stays on.
3. Run the task without a person, with JSON events. The run folder is not a Git repository, so add
   `--skip-git-repo-check`. Without it, `codex exec` stops before the task. For example:

   ```sh
   codex exec --skip-git-repo-check --json --model <model> "<prompt of the task>" > events.jsonl
   ```

   Add the code mode flag only for `codex-codemode`. Use the same flags in all three arms.
4. Save the final answer text of the agent as `answer.txt`.
5. Judge the answer:

   ```sh
   node <repo>/bench/check.mjs --task <task id> --answer answer.txt --log calls.jsonl
   ```

   The command prints one JSON line with `correct`, `mcpCalls`, `serverChars` and `tools`. It exits 0 when the answer
   is correct and 1 when it is wrong.

## Runs

- 6 tasks, 3 reps for each task and arm: 54 runs.
- Alternate the arms inside each rep, and change the order every rep.
- Run one at a time.
- Report the first run of each arm apart from the others, because a cold start pays for prompt caching.

## What to record for each run

Write one JSON line for each run in `results.jsonl`:

| Field | Source |
| --- | --- |
| `task`, `arm`, `rep` | The run |
| `correct`, `mcpCalls`, `serverChars` | The output of `bench/check.mjs` |
| `inputTokens`, `cachedInputTokens`, `outputTokens` | The token usage events in `events.jsonl` |
| `costUsd` | The tokens times the price of the model. Write down the prices that you used. |
| `turns` | The number of model calls in `events.jsonl` |
| `toolCalls` | The tool calls in `events.jsonl`, by tool name |
| `toolResultChars` | The characters of the tool results that went back to the model |
| `seconds` | The wall time of the run |
| `codexVersion`, `model` | `codex --version` and the model name |

Keep each `events.jsonl`. Send the folder of `results.jsonl` and the events with the results. Do not include your
login, API keys or any file outside the run folders.

## Limits

- The fake server data is fixed and fake. No real account or service is used.
- Codex and Claude Code use different models, so compare the arms inside one agent first. Compare across agents only
  for the relative change from the direct arm.

## Smoke test result

A manual smoke test passed. It is not a bench run and has no numbers.

- Codex version: Codex CLI 0.171.0.
- Command form: `codex exec`.
- toolscript-mcp: the built `dist/host/main.js` of commit `4b275c8` (`4117acb` plus #84).
- Setup: the bundled `demo` server, added with `-c mcp_servers.<name>...` overrides. No Codex config file changed.

| Item | Result |
| --- | --- |
| Tools and instructions | Codex lists `run_code` and `search_tools`. It follows the server instructions and calls `search_tools` first, then `run_code`. |
| Task | The prompt was "Count the open pull requests per author". Codex wrote one program that paged with `next_cursor` until null and returned only the counts. |
| Answer | `ada 7, bruno 6, chen 5, dara 4, emil 3, farah 1`. It equals `OPEN_BY_AUTHOR` of `demo/data.mjs`. |
| Codex approval gate | By default, `codex exec` refuses every MCP call with "MCP tool call requires approval, but approval policy is never". The key `default_tools_approval_mode = "approve"` in the server entry fixes it. The key takes the values `auto`, `prompt`, `writes` and `approve`. Only `approve` was tested. |
| Approval prompt (`ask` rule) | `codex exec` declines the prompt. The run stops before any call with "the person did not approve the tools that need approval". The model reports the missing `allow` rule. |
| Working directory | Codex started in `<run folder>`, a new empty folder. A downstream stdio server with no `cwd` reported the same folder. See "Working directory run". |

### Working directory run

Tested on Windows 11 with Codex CLI 0.171.0 and model `gpt-6-luna`. The toolscript config had the `demo` server
and a small probe server with one tool, `where`, that returns `process.cwd()`. The probe had no `cwd`. Run from
`<run folder>`, a new empty folder:

```sh
codex exec --skip-git-repo-check \
  -c 'mcp_servers.toolscript.command="node"' \
  -c 'mcp_servers.toolscript.args=["<repo>/dist/host/main.js","--config","<folder>/toolscript.json"]' \
  -c 'mcp_servers.toolscript.default_tools_approval_mode="approve"' \
  "<prompt>"
```

The prompt asked Codex to find `where` with `search_tools`, call it from one program and return the result. The
result was `{"cwd":"<run folder>"}`, and Codex printed `workdir: <run folder>`. A server with no `cwd` starts in the
folder where Codex started. A server with its own `cwd` was not tested.

### Runs of the demo task

Same setup, without the probe prompt. The prompt was "Count the open pull requests per author with the toolscript
tools. Reply with only the counts."

1. Without `default_tools_approval_mode`: `search_tools` and `run_code` both failed with "MCP tool call requires
   approval, but approval policy is never". Codex answered "Unable to retrieve counts: toolscript access was
   blocked."
2. With `default_tools_approval_mode = "approve"`: `search_tools` found the demo tools. `run_code` called them and
   Codex answered `ada: 7, bruno: 6, chen: 5, dara: 4, emil: 3, farah: 1`. It equals `OPEN_BY_AUTHOR`.

### Not tested

- The interactive Codex TUI, and its answer to the approval prompt.
- A project `.codex/config.toml`.
- A server entry with its own `cwd`, and other systems than Windows.
- The bench arms of this plan. A follow-up issue will run them.
