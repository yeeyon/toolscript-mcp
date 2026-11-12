# Bench results: direct MCP tools against toolscript-mcp

## Setup

- Date: 2026-11-12. Windows 11, Node v22.23.3, Claude Code 2.1.322.
- Model: `--model haiku`, which ran as `claude-haiku-5-5` in every run.
- toolscript-mcp at `cce6ea0` (M4), built with `npm run build`.
- 6 tasks from `bench/data.mjs`, 5 reps per task and arm: 60 runs. Arms alternate inside each rep, and the order flips
  every rep. At most 3 runs at a time.
- Arm `direct`: the MCP config lists only `bench/fake-server.mjs` as `bench`. The model calls `mcp__bench__*`.
- Arm `toolscript`: the MCP config lists only toolscript-mcp. Its config lists the same fake server as `bench`, with
  the policy `[{ "match": "mcp__bench__*", "action": "allow" }]`.
- Each run: `claude -p <task> --restricted --strict-mcp-config --mcp-config <file> --allowedTools <the arm's MCP tools>
  --no-session-persistence --output-format stream-json --verbose --include-hook-events --max-budget-usd 0.5`, in its own
  temp cwd, with its own `BENCH_LOG`.
- Rerun: `npm run build`, then `node bench/run.mjs --model haiku --reps 5 --parallel 3`. Print the tables again with
  `node bench/run.mjs --report <out dir>`.

What `--restricted` does here: it ignores the user, project and local settings files, so no user hooks and no user
plugins load. It removes Bash. The read-only file tools (Read, Grep, Glob) stay, confined to the cwd. Every run listed
only Claude Code's built-in plugins (`cc-plugin-*@builtin`) and had 0 hook events. A control run with a hook passed in
`--settings` did show hook events, so the stream reports hooks when they run.

## Result

All 60 answers were correct (30/30 per arm). The toolscript arm cost less on the 4 tasks with large tool results and
more on the 2 tasks with small ones.

- Mean cost per task: $0.0060 direct, $0.0033 toolscript (45% lower). The sums are $0.1791 and $0.0993.
- Median cost per run: $0.0065 direct, $0.0032 toolscript.
- Total input tokens were about the same: median 94,324 direct, 92,063 toolscript.
- Wall time was the same: mean 14.4 s direct, 14.7 s toolscript.

### Per arm

| metric | direct mean | direct median | direct min to max | toolscript mean | toolscript median | toolscript min to max |
|---|---:|---:|---:|---:|---:|---:|
| cost USD | 0.0060 | 0.0065 | 0.0014 to 0.0124 | 0.0033 | 0.0032 | 0.0019 to 0.0055 |
| input tokens (all) | 105,695 | 94,324 | 47,900 to 232,235 | 96,400 | 92,063 | 66,969 to 138,165 |
| of which cache read | 84,276 | 61,073 | 43,915 to 185,821 | 87,609 | 83,473 | 61,850 to 122,425 |
| of which cache creation | 21,410 | 22,515 | 3,979 to 46,796 | 8,781 | 7,702 | 5,111 to 15,935 |
| of which fresh input | 9 | 8 | 6 to 18 | 11 | 10 | 8 to 14 |
| first-call input | 15,727 | 15,727 | 15,712 to 15,738 | 15,788 | 15,788 | 15,773 to 15,799 |
| fixed input (first call x API calls) | 69,191 | 62,887 | 47,160 to 141,408 | 84,196 | 78,995 | 63,144 to 110,467 |
| added input (all minus fixed) | 36,504 | 23,880 | 725 to 137,819 | 12,204 | 9,275 | 3,825 to 35,040 |
| output tokens | 1,688 | 1,799 | 280 to 4,226 | 1,351 | 1,437 | 425 to 2,288 |
| of which thinking | 1,039 | 1,160 | 0 to 3,142 | 363 | 356 | 61 to 1,013 |
| turns | 4.7 | 4 | 3 to 11 | 5.8 | 5.5 | 4 to 8 |
| API calls | 4.4 | 4 | 3 to 9 | 5.3 | 5 | 4 to 7 |
| seconds | 14.4 | 14.0 | 6.0 to 27.7 | 14.7 | 14.9 | 7.2 to 20.6 |
| MCP calls (BENCH_LOG) | 1.8 | 1 | 1 to 4 | 3.2 | 2 | 1 to 9 |
| server result chars | 42,111 | 44,861 | 123 to 89,722 | 84,497 | 89,722 | 123 to 228,751 |
| tool result chars in context | 41,595 | 48,033 | 237 to 105,677 | 8,133 | 4,464 | 686 to 27,924 |
| run_code calls | 0 | 0 | 0 | 1.8 | 2 | 1 to 3 |
| failed run_code calls | 0 | 0 | 0 | 0 | 0 | 0 |
| search_tools calls | 0 | 0 | 0 | 1.2 | 1 | 1 to 2 |
| direct mcp__bench__ calls | 1.8 | 1 | 1 to 4 | 0 | 0 | 0 |
| ToolSearch calls | 1 | 1 | 1 | 1.1 | 1 | 1 to 3 |

### Per task, cost and tokens

Median (min to max) of 5 runs per arm. "Change" is the toolscript median against the direct median.

| task | correct direct | correct toolscript | cost direct | cost toolscript | change | input direct | input toolscript | output direct | output toolscript |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| issues | 5/5 | 5/5 | 0.0066 (0.0065 to 0.0067) | 0.0025 (0.0024 to 0.0039) | -62% | 71,094 (70,996 to 71,094) | 85,936 (69,309 to 99,778) | 1,508 (1,199 to 1,712) | 792 (768 to 1,001) |
| messages | 5/5 | 5/5 | 0.0066 (0.0064 to 0.0072) | 0.0031 (0.0030 to 0.0035) | -52% | 120,887 (120,162 to 121,362) | 88,065 (70,597 to 88,954) | 2,048 (1,970 to 3,647) | 1,728 (1,470 to 1,839) |
| logs | 5/5 | 5/5 | 0.0017 (0.0017 to 0.0018) | 0.0033 (0.0030 to 0.0038) | +91% | 49,055 (49,045 to 49,069) | 103,270 (102,782 to 123,951) | 529 (483 to 624) | 1,575 (1,146 to 2,014) |
| ticket | 5/5 | 5/5 | 0.0014 (0.0014 to 0.0014) | 0.0019 (0.0019 to 0.0019) | +38% | 47,903 (47,900 to 47,907) | 67,372 (66,969 to 67,401) | 286 (280 to 293) | 440 (425 to 464) |
| deploys | 5/5 | 5/5 | 0.0068 (0.0047 to 0.0104) | 0.0050 (0.0032 to 0.0052) | -27% | 146,745 (117,553 to 164,658) | 121,054 (119,421 to 138,165) | 2,983 (1,886 to 4,226) | 1,343 (1,159 to 1,975) |
| cross | 5/5 | 5/5 | 0.0121 (0.0119 to 0.0124) | 0.0038 (0.0033 to 0.0055) | -69% | 192,697 (192,172 to 232,235) | 107,968 (88,290 to 129,822) | 2,401 (2,073 to 3,110) | 2,160 (1,911 to 2,288) |
| all | 30/30 | 30/30 | 0.0065 (0.0014 to 0.0124) | 0.0032 (0.0019 to 0.0055) | -51% | 94,324 (47,900 to 232,235) | 92,063 (66,969 to 138,165) | 1,799 (280 to 4,226) | 1,437 (425 to 2,288) |

For issues, messages, cross, logs and ticket, the 5 costs of one arm do not overlap the 5 costs of the other. For
deploys the ranges overlap (rank-sum U = 21.5 of 25, two-sided p about 0.08), so 5 reps do not settle that task.

### Per task, behavior

Median per run, direct / toolscript. "Server chars" is what the fake server returned (BENCH_LOG). "Chars in context"
is the text of all tool results the model received.

| task | turns | MCP calls | search_tools | run_code | failed run_code | ToolSearch | server chars | chars in context |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| issues | 3 / 5 | 1 / 2 | 0 / 1 | 0 / 2 | 0 / 0 | 1 / 1 | 49,307 / 98,614 | 57,645 / 2,272 |
| messages | 5 / 5 | 3 / 6 | 0 / 1 | 0 / 2 | 0 / 0 | 1 / 1 | 40,415 / 80,830 | 48,033 / 5,005 |
| logs | 3 / 7 | 1 / 1 | 0 / 1 | 0 / 1 | 0 / 0 | 1 / 1 | 2,227 / 2,227 | 2,616 / 4,187 |
| ticket | 3 / 4 | 1 / 1 | 0 / 1 | 0 / 1 | 0 / 0 | 1 / 1 | 123 / 123 | 237 / 1,291 |
| deploys | 8 / 7 | 1 / 2 | 0 / 1 | 0 / 2 | 0 / 0 | 1 / 1 | 70,872 / 141,744 | 20,410 / 25,808 |
| cross | 6 / 7 | 4 / 8 | 0 / 2 | 0 / 3 | 0 / 0 | 1 / 1 | 89,722 / 179,444 | 105,677 / 4,903 |
| all | 4 / 6 | 1 / 2 | 0 / 1 | 0 / 2 | 0 / 0 | 1 / 1 | 44,861 / 89,722 | 48,033 / 4,464 |

## What the number is made of

The prices in `total_cost_usd` fit these rates exactly over all 60 runs (least squares, largest error below
$1e-16): $0.10 per million fresh input tokens, $0.01 per million cache reads, $0.20 per million cache writes (1-hour
cache), $0.50 per million output tokens.

- **Fixed context.** Every API call starts with about 15,700 tokens of Claude Code context: the system prompt, the
  built-in tools, the names of the deferred MCP tools, and the task. About 12,200 of them were a cache read in every
  run, in both arms. The other 3,500 were a cache write once per run. This fixed part is 65% of the direct arm's
  input tokens and 87% of the toolscript arm's. It costs about $0.0013 to $0.0015 per run, so no tool setup can bring
  a task below that.
- **Tool results.** A tool result enters the context once as a cache write ($0.20 per million), then is a cache read
  on each later call ($0.01 per million). Cache writes were 642,299 tokens in the direct arm and 263,430 in the
  toolscript arm. The difference, 378,869 tokens at $0.20 per million, is $0.076 of the $0.080 total difference.
- **Output.** The direct arm thought more over the large results: 31,169 thinking tokens against 10,884. Output
  tokens were 50,650 against 40,533, a $0.005 difference.
- **Why total input tokens hide the saving.** The toolscript arm made about 1 more API call per task (the
  `search_tools` step, and often a first `run_code` that looks at the data). Each extra call re-reads the fixed
  context, so its cache reads are higher. Those reads are cheap. The direct arm's extra tokens are cache writes of tool
  results, which cost 20 times more per token.

Which tasks drive the difference (sum over 5 runs, toolscript minus direct): cross -$0.0404, issues -$0.0191, messages
-$0.0175, deploys -$0.0136, ticket +$0.0026, logs +$0.0082. The 4 tasks that save have results of 40,000 to 90,000
characters per run. The 2 tasks that lose have results of 123 and 2,227 characters: there is nothing to keep out of
the context, and toolscript adds turns.

Why the saving is not larger: the fixed context is about 45% of the toolscript arm's mean cost. The toolscript arm also
fetched twice as much from the server (89,722 against 44,861 characters per run, median). On issues, deploys and
cross, the model ran a first program that returned the raw result or guessed at its shape, then a second program that
called the same tool again and computed the answer. It did not use `recall(n)`, which returns a kept result with no
new call. On deploys, the first program returned the whole result in 4 of 5 runs, and toolscript cut it to about
23,000 characters.

## Tool definitions

The bench server lists 5 tools: 1,390 characters of tool JSON and no instructions. toolscript-mcp lists `run_code` and
`search_tools`: 2,095 characters of tool JSON and 177 characters of server instructions. The toolscript definitions are
larger.

Claude Code 2.1.322 defers MCP tools behind ToolSearch, so the fixed context holds only their names. The full
definition enters the context when the model loads the tool with ToolSearch, which both arms did once per run. The
measured first-call difference is 61 tokens more for the toolscript arm (15,788 against 15,727). At about 5 API calls
per run that is about 300 cache-read tokens, under $0.00001 per run.

## Fairness and limits

- **Large results in the direct arm.** Claude Code saves an MCP result that is over its token limit to a file and
  gives the model the path. This happened on all 5 direct deploys runs (70,872 characters). The model then read the
  file with Grep or Read, which `--restricted` allows, and all 5 answers were correct. The direct issues result
  (57,645 characters in context) and the messages pages stayed under the limit and reached the model in full. There
  were 0 permission denials in the direct arm. 3 Read calls failed on malformed input from the model, and a later Read
  of the same file worked.
- **Hidden server names.** The prompts say "bench server". In the direct arm, the tool names `mcp__bench__*` are in the
  fixed context. In the toolscript arm, the model sees only `mcp__toolscript__*` until it calls `search_tools`. On logs
  and deploys, the toolscript model looked for local files first in all 10 runs: 16 Glob calls, 3 Grep calls, 4 calls
  to the absent Bash tool and 9 permission denials for paths outside the cwd. This is part of how toolscript-mcp works today, and it is
  counted in its cost.
- **5 tools only.** A real setup can have tens or hundreds of MCP tools. More tools add names to the direct arm's fixed
  context, and toolscript keeps 2. This bench does not measure that.
- **Warm cache.** The shared 12,200-token prefix was already in the cache for every run of both arms. A first session
  after the cache expires pays one more write of it, in either arm.
- **One model, one machine.** Haiku 5.5 only, Windows 11 only, one Claude Code version. Larger models think and write
  differently, so the ratio can differ.
- **Loose answer checks.** The checks in `bench/data.mjs` look for key words and numbers in the answer. They caught the
  wrong answers below, and samples of the transcripts were read by hand.
- **A discarded run.** The first full run used a temp cwd with a Windows short name (`USERNA~1`). Claude Code's file
  tools refuse such a path, and 3 toolscript runs gave up after a refused Glob. The harness now uses the long path, and
  that run was stopped after 32 runs and discarded as a whole. It also had 2 real wrong answers in the direct arm: one
  counted 29 rollback messages instead of 30, and one reported a tie on deploys after it counted per environment
  without a sum. No real wrong answer came from the toolscript arm in that run.
- **Spend.** The 60 runs cost $0.2784. Smoke tests, the hook control and the 32 recorded runs of the discarded run
  added $0.1615. Up to 3 runs that were in flight when that run was stopped are not in this sum.
