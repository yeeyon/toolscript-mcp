# Benchmarks

Back to the [documentation index](../README.md#documentation).

## Measured

On 2026-11-27 we ran 6 bench tasks in headless Claude Code 2.1.332 with Haiku 5.5, 5 runs per task. One arm called the MCP tools
directly. The other arm used toolscript-mcp.

| | Direct tool calls | toolscript-mcp |
| --- | --- | --- |
| Correct answers | 30/30 | 30/30 |
| Mean cost per task | $0.0058 | $0.0024 |
| Tool result characters in the context, mean | 39,213 | 3,022 |
| Turns, mean | 4.6 | 3.8 |

The saving comes from tasks with large tool results: 63% to 68% lower cost. On the 2 tasks with small results,
toolscript-mcp cost more (10% and 4%), because it adds a search step. Only one model, one operating system and 5
tools were measured. The bench ran at main `ed604f6` plus the bench-only lean arms of the same change. Read [bench/RESULTS.md](../bench/RESULTS.md) for the method and the limits.

### Comparison with native Code Mode

On 2026-11-28 a second bench compared direct calls, Claude Code Code Mode and toolscript-mcp in Claude Code 2.1.332.
It uses Sonnet 5.5 on Windows 11, with 6 tasks and 3 runs per task and arm. All 54 answers were correct.

| Warm runs only | Direct tool calls | Claude Code Code Mode | toolscript-mcp |
| --- | ---: | ---: | ---: |
| Runs | 17 | 17 | 18 |
| Mean cost per task, USD | 0.1244 | 0.0613 | 0.0513 |
| Mean tool result characters in context | 34,636 | 13,916 | 1,812 |
| Mean seconds per task | 11.6 | 8.1 | 7.0 |

The table excludes two cold runs.
These results use commit `29790a0`, fixed fake data and one model. They cover that commit in Claude Code.
Read [bench/RESULTS-codemode.md](../bench/RESULTS-codemode.md) for the method, cold runs and limits.

## toolscript-mcp and Claude Code Code Mode

Claude Code 2.1.323 added Code Mode, an experimental option. With it, Claude writes JavaScript that calls its tools.
It solves a similar problem inside Claude Code. The repo bench uses Claude Code 2.1.332.

| Area | Claude Code Code Mode | toolscript-mcp |
| --- | --- | --- |
| Client | Interactive Claude Code terminal | MCP clients that can start a stdio server |
| Tools | Built-in tools, the shell and configured MCP tools | Configured MCP tools, plus optional Claude Code tools through the bridge |
| Between runs | Persistent JavaScript REPL | New program each run, with kept results through `await recall(n)` and session files |
| Permissions | Claude Code rules and hooks check nested tool calls | ToolScript policy checks nested calls by tool name. Claude Code rules and hooks do not apply to them. |
| Display | Native tool calls and edit diffs | The outer `run_code` call and its returned result |
| Source | Feature inside Claude Code | Independent MIT project |

Code Mode is off by default. It needs an interactive terminal and the native Claude Code installation.
It supports Claude subscriptions and Console accounts.
Check the [official Code Mode requirements](https://code.claude.com/docs/en/code-mode#requirements) for current model and account limits.

The bridge does not reproduce Code Mode's permission checks, persistent REPL or native diff display.
See [Claude Code as a downstream server](claude-code-bridge.md#claude-code-as-a-downstream-server) for its setup and risks.

If you use only Claude Code, try Code Mode or the [claude-code-mode](https://github.com/gabe4coding/claude-code-mode)
plugin first. The first bench in [Measured](#measured) ran on Claude Code 2.1.332 with Code Mode off.
[bench/RESULTS-codemode.md](../bench/RESULTS-codemode.md) compares direct calls, Code Mode and toolscript-mcp in Claude
Code 2.1.332.
