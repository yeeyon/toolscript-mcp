# Bench results: direct MCP tools, Claude Code Code Mode and toolscript-mcp

## 1.1.0 regression bench

The release run of 1.1.0 fills this section (PR 14). It compares toolscript 1.0.5, the head build on `legacy` and the head
build on its default, beside Code Mode, on the 6 tasks of `bench/data.mjs`. No Skills arm and no trap tasks (issue #229).

- Command of the release run:
  `node bench/interactive.mjs --model haiku --reps 3 --max-spend 7 --base <1.0.5 dir> [--head <candidate dir>] --arms codemode,toolscript-1.0.5,toolscript-legacy,toolscript`.
  6 tasks, 3 reps, 4 arms: 72 runs, one at a time. A build is a folder with `dist/host/main.js` and `package.json`.
- The arms: `toolscript-1.0.5` runs the build of `--base`, `toolscript-legacy` the head build with `TOOLSCRIPT_PROTOCOL=legacy`
  in the `env` of its MCP entry, and `toolscript` the head build with no variable. Config, policy and allowed tools are the same.
  Each saved row names what ran: the `version` of the build, the SHA-256 of its `main.js`, the variables on its entry and the
  first method that the fake server saw (`initialize` or `server/discover`). The report prints them once for each arm.
- The rule that the code applies (`passRule` in `bench/arms.mjs`; the report prints the verdict):
  - Correctness: every toolscript arm is correct in every run that finished, cold runs included.
  - Limits, on warm runs only: `toolscript-legacy` against `toolscript-1.0.5`, and `toolscript` against `toolscript-legacy`. For
    total input tokens and for first-call input tokens, the ratio of the two medians is taken task by task (only tasks where both
    arms have warm runs), and the median over the tasks of those ratios must be within +2 %. Failed `run_code` calls (all finished
    runs) must be no more than the arm before it.
  - A verdict needs warm runs in all three arms (and a task that both arms of each pair have). Otherwise the report prints
    `NO VERDICT` with a line that names the missing arm, and there is no pass. A failed limit is `FAIL`.
  - `codemode` is reported, not judged. No task and no prompt is tuned after a run.
- Fairness: arms alternate inside a task, one run at a time. The three toolscript arms rotate the start place each rep (a Latin
  square over them), and `codemode` keeps its place. The pty has no `CLAUDE*` and no `TOOLSCRIPT_*` variable, every arm has a cwd
  path of one length, and each toolscript run has its own fresh HOME (`HOME`, `USERPROFILE`, `APPDATA` on its MCP entry), so
  learned shapes and tool lists never pass from one arm to another.
- The base is checked against the published `toolscript-mcp@1.0.5` (`PINNED_105`: SHA-256 of `dist/host/main.js` and
  `runtime/runner.mjs`): a different build prints one WARN line, and a base whose `main.js` equals the head's ends the command.
  Rows name both hashes.
- Date, system, Node, Claude Code version, model, each arm's version, hash and variables, the spend and the tables go here
  after the run.

### Smoke of the arms (2026-11-29, before the release run)

- Windows 11, Node v22.23.3, Claude Code 2.1.332 (interactive TUI). `--model haiku`, which ran as `claude-haiku-5-5`.
- Command: `node bench/interactive.mjs --model haiku --reps 1 --tasks ticket --max-spend 0.50 --base <1.0.5 build> --arms toolscript-1.0.5,toolscript-legacy,toolscript`.
  3 runs, 3 correct, spend $0.0162. The head was main at `179c0db` plus this change, built with `npm run build`.
- `toolscript-1.0.5`: version 1.0.5, `main.js` SHA-256 `bafac269650da58154a48d7ff9c147331784749cbf90a83212e460439b72c348`
  (the build of tag `v1.0.5`), no variable, first method `initialize`. This run was cold and is left out of the tables.
- `toolscript-legacy`: version 1.0.5, SHA-256 `34f6a05b1950ebde1c6b16acc814a2debd7de1513e156ef33b63130e4e96ccf2`,
  `TOOLSCRIPT_PROTOCOL=legacy`, first method `initialize`.
- `toolscript`: the same build and hash, no variable, first method `initialize`. The head is still version 1.0.5, and its default
  is still `legacy`, so the two head arms are the same here. They differ only after the default changes.
- The smoke is a check of the arms, not a result: one task, one rep.

## Rerun for issue #89 (2026-11-28)

The numbers in this section replace the ones in the earlier run below. The earlier run is kept as it was, with its commit.

- Date: 2026-11-28. Windows 11, Node v22.23.3, Claude Code 2.1.332 (interactive TUI).
- Model: `--model sonnet`, which ran as `claude-sonnet-5-5` in every API call. Effort was the TUI default (medium).
- toolscript-mcp at `29790a0` (main, before PR #207), built with `npm run build`.
- Command: `node bench/interactive.mjs --model sonnet --reps 3 --max-spend 7 --arms direct,codemode,toolscript,direct-lean,toolscript-lean`.
  6 tasks, 3 reps, 5 arms: 90 runs, one at a time. Spend: $6.2517. Raw rows and the printed tables:
  `bench/rerun-2026-11-27/interactive/results.jsonl` and `interactive-report.txt`. The per-run transcripts, screens and
  call logs (29 MB) are not committed.
- The arms `direct-lean` and `toolscript-lean` did not exist in the earlier run. `-lean` starts Claude Code with
  `--tools ""`, so it lists none of its built-in tools.
- Claude Code 2.1.332 ignores keys until the terminal answers its queries (cursor position, device attributes). The
  harness now sends the answers of the `@xterm/headless` terminal back to the pty (`bench/interactive.mjs`). Before
  that change, the first run timed out at "the typed prompt".
- The first run of 4 arms (`messages` in direct, codemode, direct-lean and toolscript-lean) was cold. The table below
  uses the 86 warm runs. The script did not exit after the last run; this change makes the harness end the pty, so it exits by itself.

86 of 90 answers were correct. The 4 wrong answers are all `direct-lean`: 3 on `deploys` (it has no tool to read the
saved 70,000-character result) and 1 miscount on `messages`. The other 4 arms were correct in every run.

### Warm runs per arm, mean

| metric | direct | codemode | toolscript | direct-lean | toolscript-lean |
|---|---:|---:|---:|---:|---:|
| runs | 17 | 17 | 18 | 17 | 17 |
| correct | 17/17 | 17/17 | 18/18 | 13/17 | 17/17 |
| cost USD | 0.1244 | 0.0613 | 0.0513 | 0.0719 | 0.0186 |
| tool result chars in context | 34,636 | 13,916 | 1,812 | 30,145 | 1,711 |
| API calls | 4.6 | 4.2 | 3.4 | 3.0 | 3.2 |
| first-call input tokens | 39,630 | 21,687 | 40,747 | 17,150 | 17,764 |
| seconds | 11.6 | 8.1 | 7.0 | 7.1 | 7.1 |

Median cost per task, USD (direct / codemode / toolscript): messages 0.1349 / 0.0672 / 0.0491, issues 0.1389 /
0.0629 / 0.0514, logs 0.0482 / 0.0396 / 0.0500, ticket 0.0426 / 0.0507 / 0.0430, deploys 0.1486 / 0.0554 / 0.0550,
cross 0.2325 / 0.0914 / 0.0614. toolscript costs less than Code Mode on messages, issues, ticket and cross, about
the same on deploys (0.0550 against 0.0554), and 26% more on logs.

Before against after (warm means, direct / codemode / toolscript): at `49d871f` (Claude Code 2.1.325) cost was $0.1247 /
$0.0604 / $0.0616 and chars in context 39,041 / 15,728 / 5,669. At `bb01025` (Claude Code 2.1.331) cost was $0.1257 /
$0.0654 / $0.0503. Now it is $0.1244 / $0.0613 / $0.0513 and 34,636 / 13,916 / 1,812.

## Earlier run (2026-11-24, `bb01025`, Claude Code 2.1.331)

### Setup

- Date: 2026-11-24. Windows 11, Node v22.23.3, Claude Code 2.1.331 (interactive TUI).
- Model: `--model sonnet`, which ran as `claude-sonnet-5-5` in every API call. Effort was the TUI default
  (medium).
- toolscript-mcp 1.0.2 at `bb01025`, built with `npm run build`.
- The 6 tasks and the fake server of `bench/data.mjs` and `bench/fake-server.mjs`, 3 reps per task and arm: 54
  runs. One run at a time. Arms alternate inside each task, and their order flips every rep.
- Arm `direct`: the MCP config lists only the fake server as `bench`. Code Mode is off.
- Arm `codemode`: the same MCP config, with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`. The model gets the `REPL` tool.
- Arm `toolscript`: the MCP config lists only `dist/host/main.js`. Its config lists the same fake server as `bench`,
  with the policy `[{ "match": "mcp__bench__*", "action": "allow" }]`. Code Mode is off. Sharing is off: each run
  is one session.
- Each run: `claude --model sonnet --setting-sources project --disallowedTools Bash,PowerShell --permission-mode
  dontAsk --strict-mcp-config --mcp-config <arm file> --allowedTools <arm tools>`. The allowed tools are the arm's
  MCP tools, `REPL` in the codemode arm, and `Read`, `Grep` and `Glob` in every arm.
- Rerun: `npm run build`, then `node bench/interactive.mjs --reps 3 --max-spend 6 --out <dir>`. Print the tables
  again with `node bench/interactive.mjs --report <out dir>`. Before the 2026-11-28 rerun the script did not
  exit after the last run on Windows (node-pty kept the event loop alive): end it once `results.jsonl` has 54 rows.

#### How the harness works

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
  codemode arm. Any other prompt stops the bench. In this run no prompt showed: both were accepted in earlier runs.
- Before and after each run it removes the Claude Code project folder of the cwd (`forget.mjs`). It copies the
  transcript to the run folder first. So no run sees another run's transcript or memory.
- Cost comes from the `usage` of each API call in the transcript. Prices per million tokens for Sonnet 5.5: $2
  input, $10 output, $0.10 cache read, $2.50 cache write (5 minutes), $4.00 cache write (1 hour). Source: the
  `claude-api` skill of Claude Code 2.1.325. Claude Code wrote every cache entry with the 1-hour TTL.
- A run is cold when its first API call read less than half of its input from the cache. Cold runs are reported
  apart. A smoke run of the ticket task just before the bench filled the cache, so all 54 runs were warm.
- "Tool result chars in context" is the text of the tool results that the model got. Code Mode's calls inside a
  program show in the transcript as `<synthetic>` entries with no usage. They are counted apart.

#### Code Mode

All 18 codemode transcripts have `replMode: true`. The other 36 have `replMode: false`. The TUI showed "Code Mode
(experimental) is on". Code Mode reaches the MCP tools from inside the program with `await searchTools(query, n)`
and `await tools.mcp__bench__<tool>(args)`, and the REPL keeps variables between calls.

### Result

All 54 answers were correct. toolscript-mcp adds the fewest tokens to the context, makes the fewest API calls and
is the fastest. Code Mode reads the fewest input tokens in all, because its fixed context is half the size. Most of
that difference is Claude Code's `Artifact` tool: with it off, toolscript reads the fewest input tokens in all too
(see "Rerun with Artifact off").

- Tokens added to the context (cache writes), median per warm run: 25,518 direct, 11,819 codemode, 8,148
  toolscript.
- Input tokens read in all (cache reads, cache writes and fresh input), median: 188,304 direct, 108,699 codemode,
  123,769 toolscript.
- Tool result chars in context, median: 40,482 direct, 15,225 codemode, 1,724 toolscript.
- Mean cost per warm run: $0.1257 direct, $0.0654 codemode, $0.0503 toolscript.
- Median seconds: 8.4 direct, 8.2 codemode, 7.4 toolscript.
- toolscript costs less than Code Mode on messages, issues, ticket, deploys and cross. It costs 5% more on logs.

#### Warm runs per arm

Mean / median / min-max. 18 runs per arm.

| metric | direct | codemode | toolscript |
|---|---:|---:|---:|
| correct | 18/18 | 18/18 | 18/18 |
| cost USD | 0.1257 / 0.1345 / 0.0424-0.2352 | 0.0654 / 0.0612 / 0.0447-0.1023 | 0.0503 / 0.0505 / 0.0427-0.0575 |
| of which cache reads | 0.0195 / 0.0152 / 0.0112-0.0496 | 0.0096 / 0.0095 / 0.0060-0.0138 | 0.0127 / 0.0115 / 0.0115-0.0157 |
| of which cache writes and fresh input | 0.0962 / 0.1021 / 0.0287-0.1971 | 0.0506 / 0.0473 / 0.0360-0.0787 | 0.0329 / 0.0326 / 0.0289-0.0373 |
| of which output | 0.0100 / 0.0079 / 0.0026-0.0369 | 0.0052 / 0.0050 / 0.0023-0.0099 | 0.0048 / 0.0047 / 0.0022-0.0081 |
| API calls | 5 / 4 / 3-12 | 4 / 4 / 3-5 | 3 / 3 / 3-4 |
| first-call input tokens | 39,462 | 21,459 | 40,580 |
| cache read tokens | 195,271 / 152,210 | 95,720 / 94,790 | 126,647 / 115,258 |
| cache write tokens | 24,034 / 25,518 | 12,649 / 11,819 | 8,218 / 8,148 |
| output tokens | 1,004 / 794 | 523 / 500 | 478 / 467 |
| tool calls by the model | 4 / 3 / 2-12 | 3 / 3 / 2-4 | 2 / 2 / 2-3 |
| calls inside a program | 0 | 3 / 2 / 2-6 | not in the transcript |
| failed tool calls | 0 / 0 / 0-2 | 0 | 0 |
| repeated MCP calls (same tool and arguments) | 0 | 1 run with 1 | 0 |
| "still connecting" replies | 0 | 0 | 0 |
| tool result chars in context | 35,383 / 40,482 | 16,497 / 15,225 | 1,956 / 1,724 |
| seconds | 11.6 / 8.4 / 4.1-35.3 | 8.5 / 8.2 / 3.8-14.9 | 7.8 / 7.4 / 4.1-10.9 |

#### Warm runs per task

Median cost USD (min-max), then correct answers.

| task | direct | codemode | toolscript |
|---|---:|---:|---:|
| messages | 0.1345 (0.1326-0.1345) 3/3 | 0.0677 (0.0669-0.0740) 3/3 | 0.0492 (0.0480-0.0500) 3/3 |
| issues | 0.1385 (0.1383-0.1387) 3/3 | 0.0656 (0.0642-0.0675) 3/3 | 0.0513 (0.0460-0.0535) 3/3 |
| logs | 0.0482 (0.0472-0.0486) 3/3 | 0.0479 (0.0447-0.0575) 3/3 | 0.0505 (0.0504-0.0505) 3/3 |
| ticket | 0.0425 (0.0424-0.0425) 3/3 | 0.0553 (0.0552-0.0554) 3/3 | 0.0427 (0.0427-0.0428) 3/3 |
| deploys | 0.1575 (0.1162-0.2004) 3/3 | 0.0556 (0.0523-0.0581) 3/3 | 0.0528 (0.0517-0.0575) 3/3 |
| cross | 0.2341 (0.2311-0.2352) 3/3 | 0.0962 (0.0912-0.1023) 3/3 | 0.0554 (0.0545-0.0564) 3/3 |

Median tokens added to the context / input tokens read in all / tool result chars in context.

| task | direct | codemode | toolscript |
|---|---:|---:|---:|
| messages | 25,543 / 238,676 / 40,482 | 13,251 / 107,498 / 18,668 | 8,118 / 123,212 / 1,914 |
| issues | 30,219 / 142,044 / 49,370 | 12,243 / 129,862 / 15,480 | 7,815 / 164,440 / 1,353 |
| logs | 8,201 / 120,002 / 2,289 | 9,514 / 69,859 / 7,398 | 8,722 / 123,767 / 2,905 |
| ticket | 7,175 / 118,956 / 188 | 11,626 / 76,175 / 15,225 | 7,234 / 122,281 / 498 |
| deploys | 17,772 / 414,010 / 12,786 | 9,863 / 120,007 / 8,876 | 7,804 / 164,026 / 933 |
| cross | 48,867 / 308,958 / 89,852 | 18,247 / 151,504 / 29,584 | 8,970 / 124,580 / 3,561 |
| sum | 137,777 / 1,342,646 | 74,744 / 654,905 | 48,663 / 822,306 |

Median API calls / output tokens.

| task | direct | codemode | toolscript |
|---|---:|---:|---:|
| messages | 5 / 990 | 4 / 611 | 3 / 495 |
| issues | 3 / 623 | 5 / 485 | 4 / 442 |
| logs | 3 / 348 | 3 / 367 | 3 / 405 |
| ticket | 3 / 261 | 3 / 231 | 3 / 229 |
| deploys | 10 / 2,857 | 5 / 514 | 4 / 532 |
| cross | 5 / 1,213 | 5 / 978 | 3 / 798 |

toolscript against codemode: on messages, issues, ticket and cross the 3 costs of one arm do not overlap the 3
costs of the other. On deploys and logs they overlap.

### Rerun with Artifact off

The account of this bench has Claude Code's `Artifact` tool. Its schema is about 38,000 characters, and normal
mode lists it in full on every API call. Code Mode hides it behind `searchTools`. A user who sets
`"enableArtifact": false` in `~/.claude/settings.json` does not pay it. The bench uses `--setting-sources project`,
so the user setting does not reach it, and the run above had `Artifact` on in every arm.

This rerun turns it off in every arm, with no change to toolscript-mcp or to `bench/interactive.mjs`:

- Each arm's cwd holds `.claude/settings.json` with `{ "enableArtifact": false }`. `--setting-sources project`
  loads it. Project settings can turn `Artifact` off, not on.
- toolscript-mcp at `4cee29c`, built with `npm run build`. The same 6 tasks, 3 reps, 54 runs, Sonnet 5.5, Claude
  Code 2.1.331.
- Rerun: create the 3 files under a new root, then `node bench/interactive.mjs --root C:/tsbench-noart --reps 3
  --max-spend 6 --out <dir>`.

All 54 answers were correct. 0 failed tool calls and 0 repeated MCP calls in every arm.

| metric | direct | codemode | toolscript |
|---|---:|---:|---:|
| first-call input tokens | 25,937 | 18,467 | 27,057 |
| first-call input tokens with `Artifact` on (run above) | 39,462 | 21,459 | 40,580 |
| input tokens read in all, median per run | 132,251 | 94,431 | 83,204 |
| input tokens read in all, sum of the 6 task medians | 893,899 | 543,455 | 524,241 |
| mean cost of rep 1 (6 runs) | 0.1002 | 0.0575 | 0.0399 |
| mean cost of all 18 runs | 0.0714 | 0.0405 | 0.0246 |
| tool result chars in context, median | 40,482 | 11,377 | 1,767 |
| API calls, median | 4 | 4 | 3 |
| seconds, median | 12.7 | 9.0 | 7.9 |

- The fixed-context gap of toolscript against Code Mode falls from 19,121 to 8,590 tokens. `Artifact` was 13,523
  tokens of toolscript's first call, and 2,992 of Code Mode's.
- toolscript now reads the fewest input tokens in all: 12% fewer than Code Mode per run (median), and 4% fewer over
  the 6 tasks. In the run above, Code Mode read 12% fewer than toolscript.
- toolscript still adds the fewest tokens to the context, and has the lowest mean cost per arm. Per task, direct
  costs less on ticket ($0.0105 against $0.0116, median).
- Code Mode's `searchTools` result no longer holds the `Artifact` schema: its tool result chars fell from 15,225 to
  11,377 (median).

**Cache between reps.** In this rerun, reps 2 and 3 of a task found most of rep 1's cache entries: toolscript
wrote 0 to 1,992 tokens in reps 2 and 3, against 7,382 to 8,746 in rep 1. The run above wrote about the same in
every rep. The cause was not checked. So the mean of all 18 runs is not comparable with the run above. The mean of
rep 1 is, and the input tokens read in all do not depend on the cache.

### What the numbers are made of

**Two kinds of tokens.** The tokens a task adds to the context are written to the cache once and read again on
each later call. The fixed context (the system prompt, the tool list) is read on every API call. toolscript adds
the fewest tokens, and Code Mode has the smallest fixed context.

**The fixed context.** The first call of a run has 39,462 tokens direct, 21,459 codemode and 40,580 toolscript.
Code Mode hides Claude Code's built-in tool schemas behind `searchTools`, so its fixed context is about 18,000
tokens smaller. toolscript-mcp itself adds about 1,100 tokens to the direct arm: its 2 tool definitions with
`anthropic/alwaysLoad`, and its instructions. The rest is Claude Code's built-in tools, which normal mode lists.

**Direct.** It ties on logs and ticket, which have small results. It loses on the 4 tasks with results of 40,000 to
90,000 characters. On deploys the result was over Claude Code's limit, so Claude Code saved it to a file. The model
tried Bash (refused), and read the file with Grep and Read: 5 to 12 API calls and up to $0.20.

**Code Mode.** `searchTools` returns Claude Code's built-in tools with their full input schemas next to the MCP
tools. The ticket task, with a 123-character result, put 15,225 characters in the context, almost all of it the
search result. That is why Code Mode costs $0.0553 on ticket against $0.0425 direct. Code Mode wins on input tokens
read in all, because each of its API calls reads about half as much.

**toolscript.** 1,724 tool result chars in the median run, 3 API calls, and the same tokens added (7,200 to 9,400)
on every task, whatever the size of the server's result.

**Break-even.** In one session, toolscript reads about 19,000 more fixed tokens per API call and adds about 3,600
fewer tokens per task than Code Mode (median, these 6 tasks). The difference in tokens read in all depends on how
many API calls a session makes. In this bench, with 3 to 5 calls per task, Code Mode read 20% fewer tokens in all.

### Memory

Measured after the bench with the same flags and MCP configs: one interactive session per arm on the deploys task
(the largest result), 2 sessions per arm, in the order direct, codemode, toolscript, then toolscript, codemode,
direct. Private bytes of the whole process tree of `claude.exe`, 15 s after the input box showed (idle), and 5 s
after the turn ended.

| arm | idle (MB) | after the task (MB) | processes | `claude.exe` after the task (MB) |
|---|---:|---:|---:|---:|
| direct | 303-337 | 351-366 | 3 | 335-350 |
| codemode | 310-314 | 349-358 | 3 | 333-342 |
| toolscript | 404-405 | 416-426 | 5 | 338-349 |

- Code Mode's REPL runs inside `claude.exe`, which is the same size in every arm. It costs no process.
- toolscript-mcp is one more `node.exe` and its `conhost.exe` per session: about 60 MB private. The fake server is
  about 15 MB in every arm.
- Sharing (`"share": true`, issue #63) shares the downstream servers, not the host. See `RESULTS-memory.md`: on the
  owner's config, an added session cost 358 MB with sharing off and 69 MB with it on. A Claude Code session that
  reaches its servers through a shared HTTP bridge adds no process, so toolscript-mcp stays about 60 MB per session
  behind it.

### Against the run of 2026-11-14

That run used Claude Code 2.1.325 and toolscript-mcp at `49d871f` (PR #9). Mean cost per warm run then: $0.1247
direct, $0.0604 codemode, $0.0616 toolscript. Now: $0.1257, $0.0654, $0.0503. It listed 4 gaps of toolscript-mcp
against Code Mode:

1. Slow start, "still connecting" replies (1 run of 17, $0.188). Now 0 of 18.
2. The fixed context per API call is twice as large. Still open: 40,580 against 21,459 tokens. toolscript-mcp's own
   part grew from about 760 to about 1,100 tokens.
3. The first program returned the raw result to learn its shape (deploys: 20,780 chars in context, $0.0808). Now
   933 chars median and $0.0528.
4. The second program fetched the data again (repeated calls in 5 of 18 runs). Now 0 of 18.

Code Mode in 2.1.331 had 0 failed tool calls. In 2.1.325, 12 of 18 runs started with `return await searchTools(...)`,
which the REPL refused.

### Gaps of toolscript-mcp against Code Mode

1. **The fixed context.** About 19,000 more tokens read on every API call with `Artifact` on, and 8,590 with it off
   (see "Rerun with Artifact off"). It is Claude Code's built-in tool list, not toolscript-mcp's code: toolscript-mcp's
   own part is about 1,100 tokens. With `Artifact` off, toolscript reads fewer input tokens in all than Code Mode.
   Next to try: deny the other built-in tools a session does not use, and trim toolscript-mcp's own text.
2. **Memory.** About 60 MB per session for the host, which sharing does not remove.

### Fairness and limits

- **Permission mode.** The runs used `--permission-mode dontAsk`, not `default`. A tool that is not allowed is
  refused without a prompt, as in `claude -p`. Code Mode stayed on in this mode.
- **File tools.** `Read`, `Grep` and `Glob` were allowed in every arm. Only the direct arm used them, for the
  deploys result that Claude Code saved to a file.
- **Start wait.** The harness waited 3 s after the input box showed. A shorter wait can give toolscript-mcp
  "still connecting" replies.
- **Prices.** The cost is the list price applied to the usage in the transcript. The account is a Claude Team
  plan, so the real bill is different. Claude Code's own small calls (the session title) have no usage in the
  transcript and are not counted, in any arm.
- **Code Mode is experimental.** Its prompt says it can change or be removed in any release.
- **3 reps, one model, one machine.** Sonnet 5.5 at medium effort, Windows 11, Claude Code 2.1.331.
- **5 tools only.** A real setup has more MCP tools. More tools add names to Claude Code's deferred list in every
  arm, and to Code Mode's search results.
- **One session.** The memory numbers are one session per arm. Each added session pays them again, less what
  sharing removes.
- **Loose answer checks.** The checks in `bench/data.mjs` look for key words and numbers.

### Spend

$4.8066 in all, under the cap of $6.00:

- A smoke run of the ticket task in the 3 arms, all cold: $0.4602.
- The 54 runs: $4.3466.
- The 6 memory sessions are not counted: their transcripts were removed with their project folders.

Rerun with Artifact off: $2.7810 in all, under its cap of $6.00. A smoke run of the ticket task in the 3 arms,
all cold: $0.3249. The 54 runs: $2.4561.

### Every run

| run | cold | USD | API | cache write | cache read | output | chars in context | tools called by the model | calls inside a program | failed | s |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|
| messages-direct-1 |  | 0.1345 | 5 | 25,826 | 212,854 | 990 | 40,482 | ToolSearch 1, search_messages 3 |  |  | 14 |
| messages-codemode-1 |  | 0.0740 | 4 | 14,558 | 95,333 | 626 | 20,642 | REPL 3 | searchTools 1, search_messages 3 |  | 7 |
| messages-toolscript-1 |  | 0.0500 | 3 | 8,386 | 114,820 | 495 | 1,981 | search_tools 1, run_code 1 |  |  | 8 |
| issues-direct-1 |  | 0.1385 | 3 | 30,526 | 111,510 | 520 | 49,370 | ToolSearch 1, list_issues 1 |  |  | 6 |
| issues-codemode-1 |  | 0.0675 | 5 | 12,761 | 117,099 | 475 | 15,492 | REPL 4 | searchTools 1, list_issues 1 |  | 11 |
| issues-toolscript-1 |  | 0.0535 | 4 | 8,184 | 156,292 | 516 | 1,353 | search_tools 1, run_code 2 |  |  | 10 |
| logs-direct-1 |  | 0.0486 | 3 | 8,489 | 111,505 | 348 | 2,289 | ToolSearch 1, query_logs 1 |  |  | 4 |
| logs-codemode-1 |  | 0.0479 | 3 | 9,508 | 60,345 | 380 | 7,398 | REPL 2 | searchTools 1, query_logs 1 |  | 5 |
| logs-toolscript-1 |  | 0.0505 | 3 | 9,006 | 114,745 | 297 | 2,882 | search_tools 1, run_code 1 |  |  | 5 |
| ticket-direct-1 |  | 0.0425 | 3 | 7,168 | 111,783 | 261 | 188 | ToolSearch 1, create_ticket 1 |  |  | 6 |
| ticket-codemode-1 |  | 0.0553 | 3 | 11,620 | 64,549 | 231 | 15,225 | REPL 2 | searchTools 1, create_ticket 1 |  | 5 |
| ticket-toolscript-1 |  | 0.0428 | 3 | 7,228 | 115,047 | 236 | 498 | search_tools 1, run_code 1 |  |  | 6 |
| deploys-direct-1 |  | 0.1162 | 10 | 11,842 | 402,146 | 2,857 | 5,047 | ToolSearch 1, get_deploys 1, Bash 1, Grep 7 |  | Bash 1, Grep 1 | 28 |
| deploys-codemode-1 |  | 0.0581 | 5 | 10,340 | 109,657 | 572 | 8,876 | REPL 4 | searchTools 1, get_deploys 1 |  | 10 |
| deploys-toolscript-1 |  | 0.0575 | 4 | 9,324 | 157,112 | 452 | 3,885 | search_tools 1, run_code 2 |  |  | 8 |
| cross-direct-1 |  | 0.2352 | 5 | 49,257 | 259,869 | 1,213 | 89,852 | ToolSearch 1, list_issues 1, search_messages 3 |  |  | 15 |
| cross-codemode-1 |  | 0.0962 | 5 | 18,237 | 133,257 | 986 | 29,584 | REPL 4 | searchTools 2, list_issues 1, search_messages 3 |  | 15 |
| cross-toolscript-1 |  | 0.0564 | 3 | 9,238 | 115,336 | 786 | 3,561 | search_tools 2, run_code 1 |  |  | 10 |
| messages-toolscript-2 |  | 0.0480 | 3 | 7,919 | 115,190 | 481 | 1,533 | search_tools 1, run_code 1 |  |  | 7 |
| messages-codemode-2 |  | 0.0677 | 4 | 13,243 | 94,247 | 531 | 18,668 | REPL 3 | searchTools 1, search_messages 3 |  | 10 |
| messages-direct-2 |  | 0.1345 | 5 | 25,531 | 212,951 | 1,105 | 40,482 | ToolSearch 1, search_messages 3 |  |  | 15 |
| issues-toolscript-2 |  | 0.0460 | 3 | 7,673 | 115,306 | 373 | 1,273 | search_tools 1, run_code 1 |  |  | 7 |
| issues-codemode-2 |  | 0.0656 | 5 | 12,233 | 117,619 | 485 | 15,480 | REPL 4 | searchTools 1, list_issues 1 |  | 7 |
| issues-direct-2 |  | 0.1387 | 3 | 30,211 | 111,825 | 668 | 49,370 | ToolSearch 1, list_issues 1 |  |  | 7 |
| logs-toolscript-2 |  | 0.0504 | 3 | 8,715 | 115,046 | 405 | 2,905 | search_tools 1, run_code 1 |  |  | 6 |
| logs-codemode-2 |  | 0.0575 | 3 | 11,854 | 63,708 | 367 | 15,092 | REPL 2 | searchTools 1, query_logs 1 |  | 7 |
| logs-direct-2 |  | 0.0472 | 3 | 8,193 | 111,804 | 328 | 2,289 | ToolSearch 1, query_logs 1 |  |  | 5 |
| ticket-toolscript-2 |  | 0.0427 | 3 | 7,232 | 115,055 | 229 | 498 | search_tools 1, run_code 1 |  |  | 4 |
| ticket-codemode-2 |  | 0.0552 | 3 | 11,614 | 64,537 | 231 | 15,225 | REPL 2 | searchTools 1, create_ticket 1 |  | 5 |
| ticket-direct-2 |  | 0.0425 | 3 | 7,167 | 111,781 | 268 | 188 | ToolSearch 1, create_ticket 1 |  |  | 6 |
| deploys-toolscript-2 |  | 0.0528 | 4 | 7,796 | 156,222 | 600 | 933 | search_tools 1, run_code 2 |  |  | 9 |
| deploys-codemode-2 |  | 0.0556 | 5 | 9,853 | 110,165 | 514 | 8,913 | REPL 4 | searchTools 1, get_deploys 1 |  | 8 |
| deploys-direct-2 |  | 0.2004 | 5 | 41,956 | 192,595 | 1,331 | 72,510 | ToolSearch 1, get_deploys 1, Bash 1, Read 1 |  | Bash 1 | 13 |
| cross-toolscript-2 |  | 0.0554 | 3 | 8,964 | 115,658 | 798 | 3,575 | search_tools 2, run_code 1 |  |  | 10 |
| cross-codemode-2 |  | 0.1023 | 5 | 19,674 | 137,657 | 978 | 34,619 | REPL 4 | searchTools 2, list_issues 1, search_messages 3 |  | 11 |
| cross-direct-2 |  | 0.2341 | 5 | 48,855 | 260,091 | 1,268 | 89,852 | ToolSearch 1, list_issues 1, search_messages 3 |  |  | 16 |
| messages-direct-3 |  | 0.1326 | 5 | 25,505 | 213,159 | 920 | 40,482 | ToolSearch 1, search_messages 3 |  |  | 10 |
| messages-codemode-3 |  | 0.0669 | 4 | 12,857 | 93,482 | 611 | 17,688 | REPL 3 | searchTools 1, search_messages 3 |  | 12 |
| messages-toolscript-3 |  | 0.0492 | 3 | 8,112 | 115,210 | 517 | 1,914 | search_tools 1, run_code 1 |  |  | 7 |
| issues-direct-3 |  | 0.1383 | 3 | 30,210 | 111,823 | 623 | 49,370 | ToolSearch 1, list_issues 1 |  |  | 7 |
| issues-codemode-3 |  | 0.0642 | 5 | 11,784 | 117,177 | 537 | 14,482 | REPL 4 | searchTools 1, list_issues 2 |  | 11 |
| issues-toolscript-3 |  | 0.0513 | 4 | 7,807 | 156,625 | 442 | 1,354 | search_tools 1, run_code 2 |  |  | 9 |
| logs-direct-3 |  | 0.0482 | 3 | 8,192 | 111,802 | 424 | 2,289 | ToolSearch 1, query_logs 1 |  |  | 7 |
| logs-codemode-3 |  | 0.0447 | 3 | 8,994 | 60,849 | 266 | 7,398 | REPL 2 | searchTools 1, query_logs 1 |  | 4 |
| logs-toolscript-3 |  | 0.0505 | 3 | 8,716 | 115,048 | 416 | 2,905 | search_tools 1, run_code 1 |  |  | 7 |
| ticket-direct-3 |  | 0.0424 | 3 | 7,164 | 111,775 | 258 | 188 | ToolSearch 1, create_ticket 1 |  |  | 6 |
| ticket-codemode-3 |  | 0.0554 | 3 | 11,624 | 64,547 | 241 | 15,225 | REPL 2 | searchTools 1, create_ticket 1 |  | 5 |
| ticket-toolscript-3 |  | 0.0427 | 3 | 7,227 | 115,045 | 225 | 498 | search_tools 1, run_code 1 |  |  | 7 |
| deploys-direct-3 |  | 0.1575 | 12 | 17,746 | 495,595 | 3,690 | 12,786 | ToolSearch 1, get_deploys 1, Bash 1, Grep 9 |  | Bash 1, Grep 1 | 35 |
| deploys-codemode-3 |  | 0.0523 | 4 | 9,751 | 85,312 | 477 | 8,345 | REPL 3 | searchTools 1, get_deploys 1 |  | 8 |
| deploys-toolscript-3 |  | 0.0517 | 4 | 7,691 | 156,230 | 532 | 802 | search_tools 1, run_code 2 |  |  | 9 |
| cross-direct-3 |  | 0.2311 | 5 | 48,773 | 260,006 | 1,000 | 89,852 | ToolSearch 1, list_issues 1, search_messages 3 |  |  | 11 |
| cross-codemode-3 |  | 0.0912 | 5 | 17,174 | 133,422 | 914 | 28,591 | REPL 4 | searchTools 2, list_issues 1, search_messages 3 |  | 13 |
| cross-toolscript-3 |  | 0.0545 | 3 | 8,711 | 115,656 | 808 | 2,856 | search_tools 2, run_code 1 |  |  | 11 |
