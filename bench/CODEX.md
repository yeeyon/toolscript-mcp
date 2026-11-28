# Bench target: Codex

Run this bench on a machine with Codex and a paid ChatGPT login. It
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

3. Check the model in `codex debug models`. Choose a model in the picker for which the CLI can switch tool modes.
   The model's `tool_mode` takes precedence over the feature flags on CLI 0.172.0. A model with `code_mode_only`
   cannot run the direct or ToolScript arms of this comparison. See the [Codex issue](https://github.com/openai/codex/issues/63611).
4. Print the schedule with `node bench/codex.mjs --dry-run`. It starts no Codex process.
5. List the tasks with `node bench/check.mjs --list`. Each line has the task ID, the prompt and the expected answer.

## Run with the CLI runner

The runner uses `codex exec` with `--ignore-user-config` and an empty work folder for each run. It uses your existing
Codex login and loads one fixture MCP server per arm. It disables apps, plugins, hooks, web search and shell tools.
The direct and ToolScript arms omit their fixture tools from native Code Mode. The native arm omits them from direct
and deferred calls. A successful fixture call in that arm is evidence that Codex used native Code Mode.

Run one task on each arm first. Check that each row has `correct: true` and at least one fixture call.

```sh
node bench/codex.mjs --model <model> --reps 1 --tasks ticket
```

Run the full 54-run comparison when that check passes:

```sh
node bench/codex.mjs --model <model> --reps 3
```

If the login has a model that supports direct tools but cannot use native Code Mode, document the reason. Pass
`--arms codex-direct,codex-toolscript` for a 36-run comparison on that same model.

The runner prints its result directory. Pass `--out <new-folder>` to choose the location. Every run keeps
`events.jsonl`, `stderr.txt`, `answer.txt` and the fixture's `calls.jsonl` when the fixture receives calls. A CLI
failure stops the series and preserves the earlier rows and the failed run's logs. Keep raw logs local and review
them before sharing. The runner does not calculate API charges for subscription usage.

## One manual run

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

   Set `omit_tools_from = ["code_mode"]` for `codex-direct`. Set `omit_tools_from = ["direct", "deferred"]` for
   `codex-codemode` and enable `code_mode` for that arm.

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
   omit_tools_from = ["code_mode"]
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
| `costUsd` | Optional API-equivalent estimate. Write down the pricing and distinguish it from subscription charges. |
| `turns` | Provider requests, if present in a separate trace. One `turn.completed` event covers the whole CLI turn. |
| `toolCalls` | MCP calls visible in `events.jsonl`. The CLI can omit the native Code Mode wrapper. |
| `toolResultChars` | Text characters visible in completed MCP events. The runner leaves this blank for native Code Mode. |
| `seconds` | The wall time of the run |
| `codexVersion`, `model` | `codex --version` and the model name |

Keep each `events.jsonl`. Send the folder of `results.jsonl` and the events with the results. Do not include your
login, API keys or any file outside the run folders.

## Limits

- The fake server data is fixed and fake. No real account or service is used.
- Codex and Claude Code use different models, so compare the arms inside one agent first. Compare across agents only
  for the relative change from the direct arm.

## Paid run status

The 2026-11-29 Work workspace built commit `4920f67` on Node 24.22.3 and passed all 37 server end-to-end checks.
Codex CLI `0.172.0-alpha.2` could not start a nested turn. The workspace's Bubblewrap helper failed with
`Failed to create NETLINK_ROUTE socket: Operation not permitted`. The CLI's Codex Cloud endpoint also rejected the
workspace login with HTTP 401. Separately, the CLI reported `code_mode_only` for all 10 models it listed in the picker.
These checks produced zero paid benchmark runs. See [issue #87](https://github.com/yeeyon/toolscript-mcp/issues/87).

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
