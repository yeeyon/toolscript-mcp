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
   ```

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
   ```

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
