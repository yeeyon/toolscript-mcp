# Bench results: direct MCP tools, Claude Code Code Mode and toolscript-mcp

## Setup

- Date: 2026-11-14. Windows 11, Node v22.23.3, Claude Code 2.1.325 (interactive TUI).
- Model: `--model sonnet`, which ran as `claude-sonnet-5-5` in every API call. Effort was the TUI default
  (medium).
- toolscript-mcp at `49d871f` (PR #9), built with `npm run build`.
- The 6 tasks and the fake server of `bench/data.mjs` and `bench/fake-server.mjs`, 3 reps per task and arm: 54
  runs. One run at a time. Arms alternate inside each task, and their order flips every rep.
- Arm `direct`: the MCP config lists only the fake server as `bench`. Code Mode is off.
- Arm `codemode`: the same MCP config, with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`. The model gets the `REPL` tool.
- Arm `toolscript`: the MCP config lists only `dist/host/main.js`. Its config lists the same fake server as `bench`,
  with the policy `[{ "match": "mcp__bench__*", "action": "allow" }]`. Code Mode is off.
- Each run: `claude --model sonnet --setting-sources project --disallowedTools Bash,PowerShell --permission-mode
  dontAsk --strict-mcp-config --mcp-config <arm file> --allowedTools <arm tools>`. The allowed tools are the arm's
  MCP tools, `REPL` in the codemode arm, and `Read`, `Grep` and `Glob` in every arm.
- Rerun: `npm run build`, then `node bench/interactive.mjs --reps 3 --max-spend 5`. Print the tables again with
  `node bench/interactive.mjs --report <out dir>`.

### How the harness works

Code Mode exists only in the interactive TUI. `bench/interactive.mjs` drives `claude` in a pseudo-terminal
(node-pty) and reads the screen with `@xterm/headless`. Neither is a dependency of this repo. The script loads them
from a folder outside the repo (`--pty-dir`, default `%TEMP%\ptytry`).

- Each arm has one fixed cwd, `C:\tsbench\<arm>\cwd`. It is outside the home folder, so the user `CLAUDE.md` does
  not load as ancestor memory. `--setting-sources project` keeps out user settings, hooks and plugins.
- The child process gets no `CLAUDE*` variable of the parent session. It gets `CLAUDE_CODE_GIT_BASH_PATH`, because
  Code Mode on Windows needs Git Bash.
- The script waits for the input box, waits 3 s more (a person takes that long to type), types the task and
  presses Enter. It waits for the `turn_duration` entry in the transcript, then sends `/exit`.
- It accepts only two prompts: the folder trust prompt of the arm's cwd, and the Code Mode opt-in prompt in the
  codemode arm. Any other prompt stops the bench.
- Before and after each run it removes the Claude Code project folder of the cwd (`forget.mjs`). It copies the
  transcript to the run folder first. So no run sees another run's transcript or memory.
- Cost comes from the `usage` of each API call in the transcript. Prices per million tokens for Sonnet 5.5: $2
  input, $10 output, $0.10 cache read, $2.50 cache write (5 minutes), $4.00 cache write (1 hour). Source: the
  `claude-api` skill of Claude Code 2.1.325 (model table, and `shared/prompt-caching.md`: a 5-minute write is 1.25x
  the input price, a 1-hour write 2x). Claude Code wrote every cache entry with the 1-hour TTL.
- A run is cold when its first API call read less than half of its input from the cache. Cold runs are reported
  apart.
- "Tool result chars in context" is the text of the tool results that the model got. Code Mode's calls inside a
  program show in the transcript as `<synthetic>` entries with no usage. They are counted apart.

### Code Mode activation

The first codemode session showed the prompt "Code Mode (experimental)". The answer "Yes, turn on Code Mode"
wrote `codeModeCaveatsAcceptedV1` and `codeModeAutoModeCaveatAcceptedV1` to `~/.claude.json`. Then the TUI showed
"Code Mode (experimental) is on". All 18 codemode transcripts have `replMode: true`. The other 36 have
`replMode: false`.

Code Mode reaches the MCP tools from inside the program:

- `await searchTools("create incident ticket", 10)` returns matching tools with their input types. It searches the
  built-in tools too.
- `await tools.mcp__bench__create_ticket({ title, description })` calls the MCP tool.
- The REPL keeps variables between calls (`self.all = all`, or a `const` of an earlier cell).
- A `preview(value, n)` helper cuts a value to `n` characters.

The check run of the ticket task (step 1) was correct: INC-101 with 1 `create_ticket` call. It cost $0.1127,
because its first call wrote the whole 19,727-token prefix to the cache.

## Result

All 54 answers were correct. On warm runs, toolscript-mcp and Code Mode cost about the same, and both cost about
half of direct calls.

- Mean cost per warm run: $0.1247 direct, $0.0604 codemode, $0.0616 toolscript.
- Median cost per warm run: $0.1283 direct, $0.0597 codemode, $0.0484 toolscript.
- One toolscript run (issues, rep 3) cost $0.1880, because toolscript-mcp was still starting. Without it the
  toolscript mean is $0.0537 (16 runs).
- Sum of the 6 task medians: $0.7776 direct, $0.3627 codemode, $0.3187 toolscript.
- toolscript costs less than Code Mode on messages, issues, ticket and cross. It ties on logs. It costs more on
  deploys.

### Warm runs per arm

Mean / median / min-max. Direct 18 runs, codemode 17, toolscript 17.

| metric | direct | codemode | toolscript |
|---|---:|---:|---:|
| correct | 18/18 | 17/17 | 17/17 |
| cost USD | 0.1247 / 0.1283 / 0.0373-0.2294 | 0.0604 / 0.0597 / 0.0452-0.0789 | 0.0616 / 0.0484 / 0.0375-0.1880 |
| of which cache reads | 0.0178 / 0.0158 / 0.0108-0.0307 | 0.0098 / 0.0101 / 0.0057-0.0130 | 0.0147 / 0.0151 / 0.0111-0.0385 |
| of which cache writes | 0.0977 / 0.0973 / 0.0239-0.1919 | 0.0448 / 0.0423 / 0.0317-0.0610 | 0.0413 / 0.0302 / 0.0240-0.1402 |
| of which output | 0.0092 / 0.0085 / 0.0026-0.0222 | 0.0058 / 0.0053 / 0.0028-0.0089 | 0.0056 / 0.0047 / 0.0024-0.0107 |
| API calls | 4 / 4 / 3-8 | 5 / 5 / 3-6 | 4 / 4 / 3-8 |
| first-call input tokens | 37,990 | 19,730 | 38,750 / 38,792 / 38,075-38,807 |
| cache read tokens | 177,529 / 157,682 | 97,949 / 100,681 | 147,345 / 150,968 |
| cache write tokens | 24,412 / 24,315 | 11,202 / 10,577 | 10,309 / 7,556 |
| output tokens | 925 / 851 | 576 / 530 | 562 / 468 |
| tool calls by the model | 4 / 3 / 2-8 | 4 / 4 / 2-5 | 3 / 3 / 2-8 |
| calls inside a program | 0 | 3 / 2 / 2-6 | not in the transcript |
| failed tool calls | 0 / 0 / 0-1 | 1 / 1 / 0-1 | 0 |
| MCP calls (server log) | 2 / 1 / 1-4 | 2 / 1 / 1-4 | 2 / 1 / 1-8 |
| repeated MCP calls (same tool and arguments) | 0 | 0 | 1 / 0 / 0-4 |
| tool result chars in context | 39,041 / 40,482 | 15,728 / 15,216 | 5,669 / 2,845 |
| seconds | 12.7 / 11.8 / 6.2-27.5 | 9.9 / 10.7 / 5.1-14.3 | 10.6 / 9.3 / 5.3-30.0 |

"Cache writes" includes fresh input, which was at most 14 tokens per run.

### Warm runs per task

Median cost USD (min-max), then correct answers.

| task | direct | codemode | toolscript |
|---|---:|---:|---:|
| messages | 0.1272 (0.1269-0.1295) 3/3 | 0.0673 (0.0649-0.0716) 3/3 | 0.0483 (0.0430-0.0535) 2/2 |
| issues | 0.1339 (0.1331-0.1351) 3/3 | 0.0614 (0.0578-0.0663) 3/3 | 0.0484 (0.0423-0.1880) 3/3 |
| logs | 0.0431 (0.0430-0.0442) 3/3 | 0.0547 (0.0452-0.0642) 2/2 | 0.0455 (0.0444-0.0461) 3/3 |
| ticket | 0.0374 (0.0373-0.0374) 3/3 | 0.0528 (0.0527-0.0565) 3/3 | 0.0375 (0.0375-0.0386) 3/3 |
| deploys | 0.2091 (0.1030-0.2210) 3/3 | 0.0535 (0.0469-0.0539) 3/3 | 0.0808 (0.0804-0.0828) 3/3 |
| cross | 0.2269 (0.2265-0.2294) 3/3 | 0.0730 (0.0597-0.0789) 3/3 | 0.0582 (0.0572-0.0630) 3/3 |

Median API calls / tool result chars in context / output tokens.

| task | direct | codemode | toolscript |
|---|---:|---:|---:|
| messages | 5 / 40,482 / 1,044 | 5 / 18,871 / 747 | 4 / 2,214 / 643 |
| issues | 3 / 49,370 / 692 | 5 / 14,588 / 530 | 4 / 2,424 / 480 |
| logs | 3 / 2,289 / 419 | 4 / 14,781 / 415 | 3 / 2,845 / 364 |
| ticket | 3 / 188 / 260 | 4 / 15,216 / 294 | 3 / 458 / 241 |
| deploys | 7 / 72,556 / 2,120 | 5 / 9,111 / 513 | 4 / 20,780 / 499 |
| cross | 5 / 89,852 / 1,116 | 4 / 22,876 / 858 | 4 / 3,586 / 1,041 |

toolscript against codemode: on messages, ticket and deploys the 3 costs of one arm do not overlap the 3 costs of
the other. On issues they overlap only through the one slow-start run. On logs and cross they overlap. 3 reps per
arm are enough to see the direction on 4 tasks. They are not enough to settle logs and cross.

### Cold runs

| run | cost USD | first call |
|---|---:|---|
| ticket, codemode, step 1 | 0.1127 | wrote 19,727 tokens: the first Code Mode session |
| messages, toolscript, rep 1 | 0.1721 | the first toolscript run: its prefix was not in the cache |
| logs, codemode, rep 3 | 0.1268 | wrote 19,683 tokens: the cache entry was gone 90 s after the previous codemode run |

A cold start writes the fixed context once at $4.00 per million. That is about $0.079 for Code Mode (19.7k tokens)
and about $0.155 for direct or toolscript (38.7k tokens), if nothing of the prefix is shared.

## What the numbers are made of

Cache writes are most of the cost: 78% of the direct mean, 74% of codemode and 67% of toolscript. Every new block
in the conversation (a tool result, the model's own turn) is written once at $4.00 per million tokens, then read
on each later call at $0.10. So the cost of a run is mostly the size of what entered the context, plus the fixed
context read once per API call.

**The floor.** The ticket task has a 123-character result. Direct and toolscript both cost $0.0375 there, with 3
API calls. About $0.023 of that is the first call's write of about 5,700 tokens of session context (the task,
system reminders and the list of deferred tools). About $0.011 is the cache reads of 3 calls, 32k to 39k tokens
each. No arm can go below this floor on these settings.

**Direct.** It wins on logs and ticket, which have small results: 3 API calls and nothing to keep out. It loses on
the 4 tasks with results of 40,000 to 90,000 characters, which enter the context and are written to the cache. On
deploys, the 70,872-character result was over Claude Code's limit, so Claude Code saved it to a file. The model
then tried Bash (refused), and read the file with 2 to 4 Grep calls and 1 Read. That is 7 or 8 API calls and up
to $0.22.

**Code Mode.** Its fixed context is 19,730 tokens per API call, against 38,000 for the other arms. Code Mode
hides the built-in tool schemas behind `searchTools`, so each call reads half as much. It loses money in two ways:

- `searchTools` returns the built-in tools with their full input schemas next to the MCP tools. A search for
  "create incident ticket" returned `mcp__bench__create_ticket`, then `CronCreate`, `WebSearch` and others. The 18
  searches returned 246,122 characters in all, 13,673 per run. toolscript's `search_tools` returned 265 characters
  per call.
- 12 of 18 runs started with `return await searchTools(...)`. The REPL refused it: "Top-level return cannot be used
  inside an ECMAScript module". Each of these runs paid 1 more API call.

These two explain the ticket task: Code Mode $0.0528 against $0.0375. The search result is about 4,000 tokens
written once ($0.016).

Code Mode wins on deploys. The model wrote `const r = await tools.mcp__bench__get_deploys(...)`, looked at
`preview(r, 3000)`, and counted from `r` in the next cell. The 71k-character result never entered the context, and
the REPL kept it.

**toolscript.** It wins on messages, issues, ticket and cross with 3 or 4 API calls and 458 to 3,586 characters
in context. It loses on deploys, and it lost one issues run to a slow start (see the gaps below).

## Gaps of toolscript-mcp against Code Mode

Ranked by the cost they add per run, averaged over the 6 tasks.

### 1. Slow start: the model looks for the tools before the server is up (about $0.008 per run)

- Evidence: in issues, rep 3, Claude Code's first `ToolSearch` replied "Some MCP servers are still connecting:
  toolscript". The model made 5 `ToolSearch` calls before `search_tools`. That run cost $0.1880 against a median of
  $0.0484, with 8 API calls. The smoke run of the ticket task hit the same reply (3 `ToolSearch` calls before
  `search_tools`, $0.1317).
- Measured start time, from spawn to the `tools/list` reply: 1.45 to 1.96 s over 12 starts, and 7.9 s on the first
  start after a build. The fake server takes 0.06 s. Importing `@modelcontextprotocol/sdk/server/mcp.js` alone
  takes 0.63 s, and `dist/host/server.js` 1.0 s.
- `main.ts` already serves before the downstream servers connect. The time is module load.
- Fix: answer `initialize` and `tools/list` before the heavy modules load. The two tool definitions are static. Load
  the sandbox, catalog and downstream code on the first call. Or bundle `dist` into one file. Measure the start
  time and the rate of "still connecting" replies.

### 2. The fixed context per API call is twice as large (about $0.005 per run)

- Evidence: the first call of a toolscript run has 38,750 tokens, Code Mode 19,730. The cache-read cost per run is
  $0.0147 against $0.0098, with fewer API calls.
- toolscript-mcp itself adds about 760 tokens (its 2 tool definitions with `anthropic/alwaysLoad`, and its
  instructions). The rest is Claude Code's built-in tools, which Code Mode hides and normal mode lists.
- This is not in toolscript-mcp's code. Fix to try: document a lean Claude Code setup for toolscript users (deny
  the built-in tools that a session does not use), and measure it as a fourth arm.

### 3. The first program returns the raw result to learn its shape (about $0.0046 per run, $0.027 per deploys run)

- Evidence: in all 3 deploys runs, the first program was `const r = await call("mcp__bench__get_deploys", ...);
  return r`. toolscript returned 23,665 characters: 23k of pretty-printed JSON, the cut note, then the shape line
  `{date, count, deploys: [400 × {id, app, version, env, status, ...}]}`. The second program counted, from
  `recall(n)` in 2 runs and from a new call in 1. Code Mode looked at 3,000 characters with `preview`.
- Deploys cost $0.0808 against Code Mode's $0.0535. About 6,700 tokens written at $4.00 per million is $0.027, the
  whole difference.
- Fix: when a return value is cut, show the shape line first and only a short head (2,000 to 4,000 characters). The
  shape is what the model needs to write the next program. Show JSON without indentation, which fits more data per
  character.

### 4. No state between programs: the second program fetches the data again (about $0.002 per run)

- Evidence: 9 of 18 toolscript runs ran 2 programs. The first looked at the data, the second computed. In 5 of them
  (cross 3, deploys 1, issues 2 and 3, messages 2) the second program called the same tools with the same arguments
  again: 1 to 4 repeated MCP calls per run. In the other 4 it used `recall(n)`. Code Mode had 0 repeated calls,
  because the REPL keeps variables. The footer "the same call as #1" shows only after the repeated call.
- The tokens of a repeated call stay out of the context, so its cost is the extra API call: about $0.006 to $0.010
  (issues: $0.0423 with 1 program, $0.0484 with 2).
- Fix: keep the top-level variables of a program for the next `run_code` call of the session, as the REPL does. Or
  show `recall(n)` in the first result where the model reads it, before the shape line.

### What toolscript-mcp does better than Code Mode

- `search_tools` returns only the MCP tools: 265 characters per call against 13,673 per Code Mode search.
- The program is the body of an async function, so `return` works. Code Mode's REPL refused a top-level `return`
  in 12 of 18 runs.

The current `origin/main` (`29c63b9`) has 14 commits after the measured `49d871f`. They add typed `call()`
declarations to `search_tools` and a "returned earlier" shape learned within a session. A learned shape does not
help the first call of a fresh session, which is every run here. This bench did not measure that build.

## Fairness and limits

- **Permission mode.** The runs used `--permission-mode dontAsk`, not `default`. A tool that is not allowed is
  refused without a prompt, as in `claude -p`. Code Mode stayed on in this mode (the banner, and `replMode: true` in
  the transcripts).
- **File tools.** `Read`, `Grep` and `Glob` were allowed in every arm. Only the direct arm used them, for the
  deploys result that Claude Code saved to a file.
- **Start wait.** The harness waited 3 s after the input box showed. A shorter wait gives toolscript-mcp more
  "still connecting" replies. A longer wait gives fewer.
- **Prices.** The cost is the list price applied to the usage in the transcript. The account is a Claude Team
  plan, so the real bill is different. Claude Code's own small calls (the session title) have no usage in the
  transcript and are not counted, in any arm.
- **Code Mode is experimental.** Its prompt says it can change or be removed in any release.
- **3 reps, one model, one machine.** Sonnet 5.5 at medium effort, Windows 11, Claude Code 2.1.325. The spread of
  one task and arm (largest cost over smallest) was 7% to 42% for codemode, and 3% to 24% for toolscript without
  the slow-start run. Direct was within 4%, except deploys (115%). Logs and cross need more reps to separate
  codemode and toolscript.
- **5 tools only.** A real setup has more MCP tools. More tools add names to Claude Code's deferred list in every
  arm, and to Code Mode's search results.
- **Loose answer checks.** The checks in `bench/data.mjs` look for key words and numbers. Every run was also read in
  a per-call trace.

## Spend

$4.9597 in all, under the cap of $5.00:

- Step 1, the Code Mode check run: $0.1127.
- A smoke run of the ticket task in the 3 arms: $0.2302. Its first attempt stopped at the trust prompt, before any
  API call.
- The 54 runs: $4.6168.

## Every run

| run | cold | USD | API | cache write | cache read | output | chars in context | tools called by the model | calls inside a program | s |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---:|
| messages-direct-1 |  | 0.1295 | 5 | 24,675 | 206,757 | 1,007 | 40,482 | ToolSearch 1, search_messages 3 |  | 14 |
| messages-codemode-1 |  | 0.0716 | 5 | 13,261 | 108,782 | 765 | 19,979 | REPL 4 (1 failed) | searchTools 1, search_messages 3 | 11 |
| messages-toolscript-1 | cold | 0.1721 | 3 | 39,982 | 77,751 | 438 | 1,857 | search_tools 1, run_code 1 |  | 9 |
| issues-direct-1 |  | 0.1351 | 3 | 29,332 | 108,285 | 695 | 49,370 | ToolSearch 1, list_issues 1 |  | 9 |
| issues-codemode-1 |  | 0.0663 | 5 | 12,557 | 107,106 | 530 | 18,241 | REPL 4 (1 failed) | searchTools 1, list_issues 1 | 10 |
| issues-toolscript-1 |  | 0.0423 | 3 | 6,808 | 110,695 | 399 | 1,260 | search_tools 1, run_code 1 |  | 7 |
| logs-direct-1 |  | 0.0442 | 3 | 7,295 | 108,280 | 419 | 2,289 | ToolSearch 1, query_logs 1 |  | 7 |
| logs-codemode-1 |  | 0.0452 | 3 | 8,903 | 57,048 | 383 | 8,938 | REPL 2 | searchTools 1, query_logs 1 | 6 |
| logs-toolscript-1 |  | 0.0461 | 3 | 7,836 | 110,570 | 364 | 2,845 | search_tools 1, run_code 1 |  | 5 |
| ticket-direct-1 |  | 0.0374 | 3 | 5,973 | 108,556 | 262 | 188 | ToolSearch 1, create_ticket 1 |  | 6 |
| ticket-codemode-1 |  | 0.0527 | 4 | 10,459 | 80,561 | 280 | 15,216 | REPL 3 (1 failed) | searchTools 1, create_ticket 1 | 7 |
| ticket-toolscript-1 |  | 0.0386 | 3 | 6,281 | 110,579 | 236 | 458 | search_tools 1, run_code 1 |  | 7 |
| deploys-direct-1 |  | 0.1030 | 7 | 13,809 | 265,463 | 2,120 | 10,796 | ToolSearch 1, get_deploys 1, Bash 1 (refused), Grep 4 |  | 23 |
| deploys-codemode-1 |  | 0.0535 | 5 | 9,637 | 99,786 | 492 | 9,577 | REPL 4 (1 failed) | searchTools 1, get_deploys 1 | 10 |
| deploys-toolscript-1 |  | 0.0828 | 4 | 15,356 | 158,288 | 549 | 20,953 | search_tools 1, run_code 2 |  | 8 |
| cross-direct-1 |  | 0.2294 | 5 | 47,973 | 253,621 | 1,217 | 89,852 | ToolSearch 1, list_issues 1, search_messages 3 |  | 15 |
| cross-codemode-1 |  | 0.0597 | 5 | 10,029 | 106,966 | 888 | 11,484 | REPL 4 | searchTools 2, list_issues 1, search_messages 3 | 12 |
| cross-toolscript-1 |  | 0.0572 | 4 | 8,092 | 151,310 | 971 | 2,956 | search_tools 2, run_code 2 |  | 12 |
| messages-toolscript-2 |  | 0.0535 | 4 | 7,556 | 151,001 | 817 | 2,571 | search_tools 1, run_code 2 |  | 13 |
| messages-codemode-2 |  | 0.0649 | 5 | 11,722 | 108,087 | 720 | 17,762 | REPL 4 (1 failed) | searchTools 1, search_messages 3 | 11 |
| messages-direct-2 |  | 0.1272 | 5 | 23,955 | 206,784 | 1,063 | 40,482 | ToolSearch 1, search_messages 3 |  | 14 |
| issues-toolscript-2 |  | 0.0484 | 4 | 7,127 | 150,968 | 480 | 2,424 | search_tools 1, run_code 2 |  | 9 |
| issues-codemode-2 |  | 0.0614 | 6 | 10,577 | 130,108 | 602 | 14,485 | REPL 5 (1 failed) | searchTools 1, list_issues 1 | 12 |
| issues-direct-2 |  | 0.1331 | 3 | 29,018 | 108,602 | 619 | 49,370 | ToolSearch 1, list_issues 1 |  | 10 |
| logs-toolscript-2 |  | 0.0455 | 3 | 7,498 | 110,877 | 444 | 2,845 | search_tools 1, run_code 1 |  | 7 |
| logs-codemode-2 |  | 0.0642 | 4 | 12,889 | 81,932 | 446 | 20,623 | REPL 3 (1 failed) | searchTools 1, query_logs 1 | 6 |
| logs-direct-2 |  | 0.0430 | 3 | 7,000 | 108,581 | 415 | 2,289 | ToolSearch 1, query_logs 1 |  | 6 |
| ticket-toolscript-2 |  | 0.0375 | 3 | 5,986 | 110,880 | 241 | 458 | search_tools 1, run_code 1 |  | 7 |
| ticket-codemode-2 |  | 0.0528 | 4 | 10,459 | 80,561 | 294 | 15,216 | REPL 3 (1 failed) | searchTools 1, create_ticket 1 | 8 |
| ticket-direct-2 |  | 0.0374 | 3 | 5,973 | 108,556 | 260 | 188 | ToolSearch 1, create_ticket 1 |  | 7 |
| deploys-toolscript-2 |  | 0.0808 | 4 | 14,987 | 158,570 | 499 | 20,780 | search_tools 1, run_code 2 |  | 9 |
| deploys-codemode-2 |  | 0.0469 | 5 | 7,926 | 100,681 | 513 | 7,205 | REPL 4 | searchTools 1, get_deploys 1 | 11 |
| deploys-direct-2 |  | 0.2210 | 8 | 42,021 | 306,537 | 2,220 | 72,851 | ToolSearch 1, get_deploys 1, Bash 1 (refused), Grep 4, Read 1 |  | 27 |
| cross-toolscript-2 |  | 0.0630 | 4 | 9,246 | 153,101 | 1,072 | 5,860 | search_tools 2, run_code 2 |  | 13 |
| cross-codemode-2 |  | 0.0789 | 4 | 15,255 | 92,991 | 858 | 25,771 | REPL 3 | searchTools 1, list_issues 1, search_messages 3 | 11 |
| cross-direct-2 |  | 0.2265 | 5 | 47,571 | 253,842 | 1,079 | 89,852 | ToolSearch 1, list_issues 1, search_messages 3 |  | 14 |
| messages-direct-3 |  | 0.1269 | 5 | 23,951 | 206,758 | 1,044 | 40,482 | ToolSearch 1, search_messages 3 |  | 14 |
| messages-codemode-3 |  | 0.0673 | 5 | 12,223 | 108,900 | 747 | 18,871 | REPL 4 (1 failed) | searchTools 1, search_messages 3 | 11 |
| messages-toolscript-3 |  | 0.0430 | 3 | 6,815 | 110,948 | 468 | 1,856 | search_tools 1, run_code 1 |  | 9 |
| issues-direct-3 |  | 0.1339 | 3 | 29,020 | 108,606 | 692 | 49,370 | ToolSearch 1, list_issues 1 |  | 10 |
| issues-codemode-3 |  | 0.0578 | 5 | 10,537 | 105,423 | 512 | 14,588 | REPL 4 (1 failed) | searchTools 1, list_issues 1 | 11 |
| issues-toolscript-3 |  | 0.1880 | 8 | 35,049 | 385,117 | 928 | 3,455 | ToolSearch 5, search_tools 1, run_code 2 |  | 30 |
| logs-direct-3 |  | 0.0431 | 3 | 7,000 | 108,581 | 423 | 2,289 | ToolSearch 1, query_logs 1 |  | 8 |
| logs-codemode-3 | cold | 0.1268 | 4 | 28,657 | 66,913 | 549 | 21,780 | REPL 3 | searchTools 1, query_logs 1 | 11 |
| logs-toolscript-3 |  | 0.0444 | 3 | 7,497 | 110,875 | 332 | 2,845 | search_tools 1, run_code 1 |  | 9 |
| ticket-direct-3 |  | 0.0373 | 3 | 5,971 | 108,552 | 259 | 188 | ToolSearch 1, create_ticket 1 |  | 7 |
| ticket-codemode-3 |  | 0.0565 | 4 | 11,338 | 81,450 | 294 | 17,438 | REPL 3 (1 failed) | searchTools 1, create_ticket 1 | 5 |
| ticket-toolscript-3 |  | 0.0375 | 3 | 5,987 | 110,880 | 250 | 458 | search_tools 1, run_code 1 |  | 8 |
| deploys-direct-3 |  | 0.2091 | 7 | 41,299 | 265,318 | 1,733 | 72,556 | ToolSearch 1, get_deploys 1, Bash 1 (refused), Grep 2, Read 1 |  | 20 |
| deploys-codemode-3 |  | 0.0539 | 6 | 8,760 | 123,099 | 652 | 9,111 | REPL 5 (1 failed) | searchTools 1, get_deploys 1 | 14 |
| deploys-toolscript-3 |  | 0.0804 | 4 | 14,970 | 158,582 | 467 | 20,768 | search_tools 1, run_code 2 |  | 12 |
| cross-direct-3 |  | 0.2269 | 5 | 47,579 | 253,844 | 1,116 | 89,852 | ToolSearch 1, list_issues 1, search_messages 3 |  | 17 |
| cross-codemode-3 |  | 0.0730 | 4 | 13,910 | 91,657 | 819 | 22,876 | REPL 3 | searchTools 1, list_issues 1, search_messages 3 | 12 |
| cross-toolscript-3 |  | 0.0582 | 4 | 8,159 | 151,618 | 1,041 | 3,586 | search_tools 2, run_code 2 |  | 14 |
