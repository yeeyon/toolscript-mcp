# SDK v2 and the 2026-07-28 protocol (issue #154)

Status: Accepted: the decisions of section 13, the rollout of section 8, the budgets of section 9, the cut of section 12.
As read, not verified: every SDK and spec name in sections 2, 3 and 4, until the PR of section 12 that uses it.

REF is the main commit that this ADR was measured at: `ae8027bc68f17786a101585f16def6ecad6f0b06` (2026-11-28). At REF the package
is `1.0.4`, the SDK pin is `@modelcontextprotocol/sdk` `1.32.2`, Node is `>= 22.13`, `WORKSPACE_VERSION` is `1.1.0`
(`src/core/workspace.ts:12`), and 12 files of `src/host/` import the SDK (none of `src/core/`):
`brokerlink.ts`, `childtransport.ts`, `downstream.ts`, `login.ts`, `main.ts`, `oauth.ts`, `run.ts`, `server.ts`, `sigv4.ts`,
`workspace/bind.ts`, `workspace/provider.ts`, `workspace/roots.ts`. The release line that this ADR sets is in section 8.
Decision 043 of the maintainer decision log replaces decision 031 (patch versions only) for the 1.1 line.

Sources: issue #154 and the issues #90 to #93 and #147, PR #198, the code of main at REF, and the published packages
`@modelcontextprotocol/client`, `@modelcontextprotocol/server` and `@modelcontextprotocol/core` at 2.4.0, read from the files of
`npm pack <package>@2.4.0` into a new empty folder (no script was run), on 2026-11-28. A name in this ADR is "found" when it is
in a file of that package, "not found" when it is in none of the three, and "not checked" when PR 1 did not look. The public pages
that were read, on 2026-11-28: the Claude Code MCP page, the Codex MCP page, the MCP specification changelog of 2026-07-28 and
the MCP clients page (URLs in section 7).

## 1. Pinned versions

- `@modelcontextprotocol/client` 2.4.0 and `@modelcontextprotocol/server` 2.4.0, exact pins as today. Source: `npm view <package>@2.4.0
  dependencies engines`, 2026-11-28.
  - client: `@modelcontextprotocol/core` 2.4.0, `zod ^4.2.0`, `jose ^6.1.3`, `cross-spawn ^7.0.5`, `eventsource ^3.0.2`,
    `pkce-challenge ^5.0.0`, `eventsource-parser ^3.0.8`.
  - server: `@modelcontextprotocol/core` 2.4.0 and `zod ^4.2.0`. core: `zod ^4.2.0`.
  - Each has `engines.node >= 20`. The first draft named only `jose` and `eventsource` for the client: the list above is the
    real one, and the lockfile and pack review of PR 5 must name all of it.
- Node floor stays 22.13. `@modelcontextprotocol/ext-tasks` exists (versions 0.1.0, 0.2.2, 0.2.3; its dependency is `zod ^4.5.4`, a
  higher floor than the SDK packages). It is pinned in Phase 4, Skills in Phase 2. The server package has an export
  `@modelcontextprotocol/server/ext/skills` (package.json of server 2.4.0).
- SDK 1.32.2 leaves at the end of Phase 1. Until then v1 and v2 coexist, and no object crosses (`instanceof`).

## 2. Protocol revisions

- Legacy era: 2025-11-25 and what the SDK negotiates below it. Modern era: 2026-07-28 (no `initialize`, no session, per-request
  `_meta`, `server/discover` optional).
- Upstream: modern needs `serveStdio(factory)` of `@modelcontextprotocol/server/stdio`. A server on `StdioServerTransport` (main.ts
  today) stays 2025.
- Downstream: `ClientOptions.versionNegotiation` is an object `{ mode, probe? }` with `mode` `'legacy'` (default), `'auto'` (probes
  `server/discover`, falls back) or `{ pin }`. `client.getProtocolEra()` returns `ProtocolEra | undefined`. The first draft wrote
  the option as the bare string: that is corrected here.
- 1.1.0 is SDK v2 always. Modern is opt-in behind one flag, in both directions and through the broker (section 8). Nothing is
  advertised that the host cannot do: on a modern link roots, push elicitation and sampling do not exist.

## 3. Adapter boundary

- At REF 12 files of `src/host` import the SDK, and `src/core` imports none. New rule: SDK imports only in `src/host/sdk/` (client,
  server, transport, auth, errors). The rest of `src/host` uses that folder, and `tests/code.check.mjs` enforces it.
- The adapter is thin: re-exports, our error classes, the era of a link. The SDK does the protocol work.
- `ReadBuffer`, `serializeMessage` and `deserializeMessage` (childtransport.ts, brokerlink.ts) become a small line codec of our own in
  `src/core`: the broker already splits lines itself. Finding of PR 1: these three names, and `OAuthError`, are found in the export list
  of `@modelcontextprotocol/client@2.4.0` (`dist/index.d.mts`, line 2530), so v2 does not make them private. PR 3 keeps its cut and
  decides whether the own codec is still worth it.
- Known breaks to absorb, with their source:

| Name or behaviour | Status | Source |
|---|---|---|
| `ProtocolError`, `ProtocolErrorCode` | found | client 2.4.0 `dist/index.d.mts:2530` |
| `McpError`, `ErrorCode` (v1 names) | not found | no `.d.mts` of the three packages |
| `setRequestHandler(method, (request, ctx) => ...)` | found | server 2.4.0 `dist/mcp-BCJHyo7l.d.mts:2540` |
| `ctx.mcpReq.id`, `ctx.mcpReq.signal` | found | same file, `mcpReq` at 2119 to 2183 |
| `ProtocolErrorCode.InvalidParams = -32602` | found | same file:1553 |
| an unknown tool rejects with -32602 where v1 gave `isError: true` | not checked | PR 5 |
| `callTool` takes no result schema | not checked | PR 5 |
| `listMaxPages`, default 64 (we keep `MAX_PAGES`) | found | client `dist/client-BTIWJvaF.d.mts:390` and 814 |
| a list with no capability is empty | not checked | PR 5 |

  The model-facing text of the wrong-name hint and of the call errors stays as it is.

## 4. Broker and mux, both eras in 1.1.0

Today `src/core/mux.ts` swaps ids and progress tokens, sends one `initialize` with `capabilities: {}`, caches its result for later links,
answers `ping`, and fans out `tools/list_changed`. That stays, byte for byte, as the legacy path.
- One era for each child. The protocol setting (`legacy` or `auto`) goes into the entry frame and the share key, so a pinned-legacy
  link and an `auto` link never share a child. Every `auto` link probes the same child and gets the same answer. The router fixes its
  era at the first settled probe: a `server/discover` result makes it modern, an `initialize` makes it legacy. After that an
  `initialize` on a modern child gets -32601 from the router and reaches no child. Source for "one era for each child": a stdio
  connection is pinned to the era of its opening exchange (section 11, answer 2).
- Modern routing, per request: the id and the progress token are swapped as today. The envelope keys of `_meta` pass through
  unchanged and size capped: they describe the link that sent this request, and the result goes only to that link. The keys that
  the SDK reserves are `io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities`, `logLevel` (and `serverInfo`,
  `subscriptionId`, `related-task` elsewhere), plus the plain keys `traceparent`, `tracestate` and `baggage` (all found in `@modelcontextprotocol/core@2.4.0`
  `dist/internal.d.mts`, lines 13 to 91). The three trace keys were not in the first draft: the router passes them as the other keys.
  There is no initialize cache, no `notifications/initialized` and no router-made `ping` answer. `server/discover` is forwarded for each
  link and not cached in 1.1.0, so no cache crosses links.
- List changes: each link forwards its own `subscriptions/listen` as an open request with its own router id. A notification of a
  stream goes to the link of that stream. A detach cancels the stream as any open request. At most one stream for each link,
  inside `LINKS_MAX`. Finding of PR 1: the child stamps each stream notification, the first `notifications/subscriptions/acknowledged`
  too, with `_meta["io.modelcontextprotocol/subscriptionId"]`, the JSON-RPC id of the listen request, verbatim. The child sees the
  router id, so PR 11 must map the stamp back to the id that the link sent before it forwards the notification.
- MRTR: an `input_required` result goes back by id to the link that asked. The router records a hash of its `requestState` for that
  link (bounded: 64 for each link, 10 minutes). A retry with `inputResponses` whose `requestState` belongs to another link gets
  -32602 and reaches no child. The router never changes `requestState` or `inputResponses`. Phase 4 adds the same rule for a `taskId`.
  Finding of PR 1: `requestState` is a string at the top of the `input_required` result (`{ resultType, inputRequests?, requestState? }`), and
  a retry is a new request that carries `inputResponses` and `requestState` in its params. The progress token stays in
  `params._meta.progressToken`, as in the legacy era (section 11).
- Unchanged in both eras: `notifications/cancelled` on stdio, a refused request of the child, death and detach, the caps and line
  limits, the key proof, decision 024 (no direct-child fallback).
- A shared child on the modern era needs a stdio server that serves 2026-07-28, and a broker `ready` rule that does not wait for
  `initialize` (the first answered `server/discover`, inside `CHILD_INIT_MS`). It holds no state for a connection, which is what
  sharing wants. The share class rules (decisions 025 to 027) do not change.
- Proof: the legacy tests of `tests/mux.test.ts` pass unchanged. The property test gets a modern mode (no message crosses a link,
  no `requestState` crosses, streams end with their link). `tests/share.e2e.mjs` runs with a modern fake child. `bench/memory.mjs`
  shows the same saving for a modern child as for a legacy one.

## 5. State ownership

| State | Owner | Lifetime |
|---|---|---|
| Era and capabilities of the upstream client | host, per request on modern, per connection on legacy | request / connection |
| Era of a downstream link; era of a shared child | `downstream.ts` link state; the router of that child | link; child |
| Policy decision and approvals of a run | `run.ts`, read again at each run | run; never in `requestState` as authority |
| `requestState` of our own server (Phase 3) | host; signed with a key made at process start, no secret in it | bound to run, program hash, approved tools, expiry |
| `requestState` owner table of a shared child | the router | 10 minutes, 64 for each link |
| Recall results (#90); Tasks (Phase 4) | host process, handles and `taskId` qualified by a process nonce and the link | process; `ttlMs` |
| Tool lists | downstream link; the display cache `tools.json` stays display-only | `ttlMs` when the server gives one |

The server package has an opt-in HMAC codec for `requestState` (`createRequestStateCodec`, server 2.4.0 `dist/index.d.mts:357` to 446).
Phase 3 decides whether to use it or to keep our own signing: not decided here.

## 6. Threat model deltas

1. Per-request `_meta` is asserted by the client each time and can change: it never widens trust, it is size capped, and a malformed
   one is -32602.
2. `requestState` is replayable and readable: signed, expiring, bound to the original inputs, and on a shared child bound to its link
   (section 4). A continuation never reruns a finished side effect and revalidates the policy. The SDK states the same risk: "MUST
   be treated by the server as attacker-controlled input on re-entry" (server 2.4.0 `dist/mcp-BCJHyo7l.d.mts:696` to 701).
3. Input that a downstream server asks for (Phase 3) is shown with the server's name, and its answer is a value, never an approval.
   Decline, cancel, timeout and a bad answer grant nothing (decision 011 stays).
4. A shared modern child sees each link's own capabilities. If it mixes them up, its results still go only to the asker.
5. Unknown-tool and other protocol errors carry downstream text in an exception: same redaction and untrusted wrapper.
6. Auth: `iss` validation (RFC 9207) in Phase 1. Claude Code states the same check on its v2 runtime (section 7). CIMD after 1.1.0,
   dynamic registration keeps working. SigV4 signs host, `x-amz-*` and content type only, so the new `Mcp-Method`, `Mcp-Name` and
   `MCP-Protocol-Version` headers need a test (the client package names all three: found in client 2.4.0 `dist/index.d.mts` and
   `dist/src-CeKsbNLO.mjs:4655`).
7. Supply chain: 3 SDK packages plus the dependencies of section 1 enter the bundle. Lockfile and `npm pack` reviewed.

## 7. Client and transport support

Cell values are only these three. "verified": a test of this repo or a run with its evidence. "stated": the vendor page says so
(URL, read date and the quoted words); it does not count as verified. "not verified": everything else. No cell is filled from memory.

Upstream, clients of toolscript-mcp:

| Client | Era 2026-07-28 | MRTR | List changes by `subscriptions/listen` | Skills | Tasks |
|---|---|---|---|---|---|
| Claude Code (tested: 2.1.332) | stated (a) | not verified (b) | stated (c) | stated (d) | stated (e) |
| Codex CLI (smoke test: 0.171.0 and 0.172.0) | not verified (f) | not verified | not verified | not verified | not verified |
| SDK v1 client 1.32.2 of our tests | not verified (g) | not verified | not verified | not verified | not verified |

Notes. All five Claude Code sources are `https://code.claude.com/docs/en/mcp`, read 2026-11-28.
- (a) "The v2 runtime is the same code on MCP TypeScript SDK 2.0, which adds MCP protocol revision 2026-07-28." and "Asks HTTP, stdio,
  and claude.ai connector servers whether they support the newer revision and uses it with those that do." Runtime choice: v2 from
  Claude Code v2.1.232 or later when it fetches feature flags, and by default from v2.1.274 in the sessions that do not.
- (b) The page names `inputRequests` and `inputResponses` only inside its Tasks section (`tasks/update`). It does not name MRTR for
  `tools/call`.
- (c) "Receives list_changed notifications from servers on the newer revision over a stream it holds open."
- (d) "MCP skills are in public beta and require Claude Code v2.1.331 or later."
- (e) "The server is an HTTP, stdio, or claude.ai connector server connected on protocol revision 2026-07-28." and "Terminal CLI sessions,
  Agent SDK sessions, and GitHub Actions runs have them on v2.1.304 or later".
- (f) `https://developers.openai.com/codex/mcp` (it redirects to `learn.chatgpt.com`), read 2026-11-28: the page does not mention the revision 2026-07-28, `list_changed`,
  Tasks or MCP skills. The Codex rows of this repo are `bench/CODEX.md` (0.171.0, manual smoke test) and `docs/workspace.md` (0.172.0): neither
  records the era.
- (g) `tests/*.test.ts` and `tests/*.e2e.mjs` use the SDK 1.32.2 client against our server. None of them tests the modern era.

Legacy era with our current server: verified for Claude Code 2.1.332 (`bench/RESULTS.md`, the rerun of 2026-11-27: 150 runs, all answers
of the toolscript arms correct; the runtime of Claude Code and the era were not recorded) and for the SDK 1.32.2 client. Finding for
PR 13 and the release: Claude Code states that on its v2 runtime it asks stdio servers for the newer revision by default ("Claude Code
asks stdio servers for that revision by default", and "A channel server that doesn't support that revision connects on the earlier
handshake"). So today a probe may already reach our v1 stdio server. Observed in use on 2026-11-28 (Claude Code 2.1.332, Windows, SDK 1.32.2 server, one working day of `run_code` calls), no test in this repo: the session worked. Which runtime that session used is not recorded. The gap stays: its answer to `server/discover` is not verified in a test, and PR 13 adds a test that sends `server/discover` to the built server and checks the answer that the stdio fallback of the spec expects.
The setting that keeps a client on the earlier handshake is `MCP_PROTOCOL_NEGOTIATION=legacy` (same page). The same page also says "Claude Code connects to every other server as v1 does."

The extension matrix of the MCP site (`https://modelcontextprotocol.io/extensions/client-matrix`, read 2026-11-28) marks ChatGPT Skills "Partial" and leaves the cells of the other clients blank. It does not say what blank means, and no row names the protocol era, MRTR or `listen`: it changes no cell above. The announcement (`https://blog.modelcontextprotocol.io/posts/2026-07-28/`, read 2026-11-28) says "All four Tier 1 SDKs speak 2026-07-28 as of today" (stated).

Downstream, servers of our tests and the demo:

| Server | Legacy era | Era 2026-07-28 | List changes by `subscriptions/listen` |
|---|---|---|---|
| `demo/server.mjs` (hand-written, answers `initialize`) | verified (`tests/server.e2e.mjs`, `bench/CODEX.md`) | not verified | not verified |
| `bench/fake-server.mjs` (hand-written, answers `initialize`) | verified (bench rerun 2026-11-27) | not verified | not verified |
| SDK 1.32.2 servers of the tests (`McpServer`) | verified (`tests/downstream.test.ts`, `tests/run.test.ts`) | not verified | not verified |
| `claude mcp serve` (Claude Code 2.1.332) | verified (`tests/bridge.e2e.mjs`, `bench/RESULTS-memory.md`) | not verified | not verified |

No server of our tests serves the modern era today. PR 10 and PR 12 add a modern fake server.

## 8. Rollout and rollback

- Release line (decision 043 replaces decision 031). 1.1.0 is a minor release with SDK v2 and `TOOLSCRIPT_PROTOCOL=legacy|auto` (and the
  same key in the config), default `legacy`. Then come 1.1.x patch releases. A 1.1.x patch flips the default to `auto`, and only on
  the evidence below. In plain words: this flip changes a default in a patch release, which decision 031 did not allow and decision
  043 does. Semantic versioning stays as `docs/sandbox.md` says: the new key is an addition, the flag keeps both values, and
  `legacy` stays.
- `auto` turns on `versionNegotiation: { mode: 'auto' }` downstream, the modern router for shared children, and the modern server upstream.
- On a modern upstream client before Phase 3, an `ask` decision gets the "client cannot ask" refusal, never an allow.
- The evidence for the flip, all of it: the conformance matrix (legacy and modern, upstream and downstream, direct, lazy and shared)
  green on 3 systems in 3 releases in a row. The budgets of section 9 measured again with `auto`. The owner's daily use on `auto`
  for 7 days with no regression in the scout ledger. No open report that names the protocol. Claude Code verified in section 7.
- Rollback: the flag, or `toolscript-mcp@1.0.x`. No config migration: both read the same config and stores.

## 9. Regression budgets (accepted)

A later PR measures with base REF and head the PR, both in one job. For start time and memory that is the `baseline` profile of
`.github/workflows/stress.yml`: it builds head and base on the same runner and measures them in turns. A budget is judged on that
pair, never on a number of another day. Laptop numbers are a second reference only.

| Metric | Value at REF | Unit | Source (command or run) | Date | Spread | Budget |
|---|---|---|---|---|---|---|
| Start, `tools/list` reply, median, head at REF (base `v1.0.4` in brackets), Node 24 | Windows 150.5 (154.0); Ubuntu 158.5 (154.5); macOS 156.0 (214.0) | ms | `baseline` profile, run 46130315779 (https://github.com/yeeyon/toolscript-mcp/actions/runs/46130315779), jobs 140933837726, 140933837802, 140933837708; head at REF, base at the tag `v1.0.4`, built and measured in turns on one runner | 2026-11-28 | the job summary prints one median for each side, not a range | +10% or +50 ms |
| Host private bytes, head, each OS | pending a new run: not measured in run 46130315779 (Windows and Ubuntu: "FAIL (not measured)", a bug of the stress script, which is fixed apart; macOS: the system has no private memory number for a process) | MB | same run | | | +10 MB a host |
| Sharing saving | pending the same new run, same reason | MB | same run | | | modern child: the same saving as legacy |
| Bytes of the `baseline` profile, head (base in brackets), same run | `tools/list` 2849 (2862); instructions 296 (296); `search_tools` 233 (790) | bytes | same run, all three OS print the same | 2026-11-28 | exact | 0 on legacy |
| Start, "laptop" second reference | no number recorded | | `node scripts/start-time.mjs` was not run in PR 1 | | | |
| Host private bytes, "laptop" | 61.1 (60.7 to 61.3), fixture, commit 028435a; 66.7, owner config, commit 726eab2 | MB a host | `bench/RESULTS-memory.md` (2026-11-21, 2026-11-22) | 2026-11-21, 2026-11-22 | as listed | |
| Windows session, "laptop" | 121.0 idle, guard off, 1 session | MB | `bench/RESULTS-memory.md`, "Child guard on Windows" (commit 2818203) | 2026-11-27 | one run | |
| Package, packed size | 382,836 | bytes | `npm pack --dry-run --json` after `npm ci && npm run build`, REF, Windows 11, Node 22.23.3. The same run 46130315779 gives 382,836 (Windows), 382,837 (Ubuntu, macOS) at head and 387,319 / 387,320 at `v1.0.4` | 2026-11-28 | one build; 1 byte apart between systems | +25% (478,545 bytes), each new dependency named |
| Package, unpacked size | 1,647,215 | bytes | same | 2026-11-28 | one build | +25% |
| Package, file count | 16 | files | same | 2026-11-28 | one build | |
| `dist/host/main.js` | 1,488,784 | bytes | same (`files[].size`). Run 46130315779: 1,488,784 at head on all three OS, 1,426,742 at `v1.0.4` | 2026-11-28 | one build | +25% |
| `dist/host/broker.js` | 80,510 | bytes | same | 2026-11-28 | one build | +25% |
| Tokens and cost, toolscript arm | 30 of 30 correct; median 56,972 input tokens, mean 70,537 (54,865 to 122,328); mean cost 0.0024 USD (median 0.0021) | tokens, USD | `bench/RESULTS.md` rerun of #89 and `bench/rerun-2026-11-27/headless-report.txt`, Claude Code 2.1.332, Haiku 5.5, 6 tasks, 5 reps | 2026-11-27 | min to max as listed | 30 of 30, tokens +2% |
| Registration, first-call input of the toolscript arm | 18,052 | tokens | same report, "first-call input" (min 18,037, max 18,063) | 2026-11-27 | as listed | tokens +2% |
| Direct arm, for reference | 30 of 30; median 89,471 input tokens; mean cost 0.0058 USD | | same report | 2026-11-27 | | |

Tokens and cost, which commit. The rerun used main `ed604f6` plus the lean arms of its own change. Registration bytes changed
since that commit: #212 (`84cc1bc`) rewrote the end of `SEARCH_DESCRIPTION` in `src/core/protocol.ts` (the literal went from 416 to 403
characters: "Use an empty query to list all tools. After a reconnect, use an empty query with limit 1" became "An empty query lists the
servers, and "Not connected" the ones still down after a reconnect. A server key lists its tools."). So the numbers above are not the
registration cost of REF. No paid run happens in PR 1. PR 8 and PR 14 measure base REF and head in one bench session, inside the caps
below ($3 headless, $7 interactive, as the #89 rerun).

Suite: the duration of the `npm test` step in the last 5 green `test.yml` runs on main at the read time (2026-11-28; run ids
46128085827, 46126078040, 46122638382, 46122631216, 46122624829, heads `e490238`, `d15d657`, `6627b63`, `3342d9c`, `63c02c1`; REF itself is
newer than all five). Seconds, median and range. Budget +10% for each row.

| System | Node | Median | Range |
|---|---|---|---|
| ubuntu-latest | 22.13 | 161 | 139 to 164 |
| ubuntu-latest | 24 | 144 | 137 to 145 |
| windows-latest | 22.13 | 218 | 186 to 225 |
| windows-latest | 24 | 185 | 177 to 195 |
| macos-latest | 22.13 | 246 | 219 to 250 |
| macos-latest | 24 | 202 | 126 to 204 |

`tools/list` and instructions of the built server at REF, on the legacy era (the client asks 2025-06-18 and the server answers it).
Rule: a v2 PR changes 0 of these bytes. A feature PR that changes them records the new hash in this ADR.

| Config | `tools/list` result bytes | SHA-256 | Instructions bytes | SHA-256 |
|---|---|---|---|---|
| empty: `{"mcpServers":{}}` | 2849 | `a158f339e944a5fa7387b5ce38005b4955fa12a5670d4ef29639e2951d59a420` | 286 | `3c677dd15356ec0047d4fb6716bea6d6a39080f396b37ab5219c2cbf84542f84` |
| demo: one server `demo` at `demo/server.mjs` | 2849 | `a158f339e944a5fa7387b5ce38005b4955fa12a5670d4ef29639e2951d59a420` | 292 | `59c786973984b1a9d194a2ad7560c38bcc5713965bb6acf05c00a581af4247c0` |

The run 46130315779 prints 296 instructions bytes at REF and at `v1.0.4`: its stress script uses its own config, so the number differs from the two rows above, which use the configs named there. A later PR compares like with like, with the same config on both sides. The `tools/list` bytes of that run are 2849 at REF and 2862 at `v1.0.4`: the 13 bytes are the change of #212 (section 9, tokens and cost).

The command, on 2026-11-28 after `npm ci && npm run build` at REF on Windows 11 with Node 22.23.3. The script is saved as
`hash.mjs` in a temp folder, outside the repo. The two configs and an empty home are in temp folders too. The hash is of
`JSON.stringify(result)` of the `tools/list` answer and of the `instructions` string, as UTF-8.

```
node hash.mjs dist/host/main.js <empty-or-demo config> <empty temp home>
```

```js
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
const [main, cfg, home] = process.argv.slice(2)
const child = spawn(process.execPath, [main, '--config', cfg], {
  env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home + '/appdata' },
  stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
})
let buf = ''
let init
const send = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
child.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id === 1) {
      init = m.result
      send({ method: 'notifications/initialized' })
      send({ id: 2, method: 'tools/list' })
    }
    if (m.id === 2) {
      const t = JSON.stringify(m.result)
      const s = init.instructions ?? ''
      const h = x => createHash('sha256').update(x).digest('hex')
      console.log(JSON.stringify({ tools: [Buffer.byteLength(t), h(t)], instructions: [Buffer.byteLength(s), h(s)] }))
      child.stdin.end()
      setTimeout(() => child.kill(), 1500)
    }
  }
})
send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hash', version: '0' } } })
```

## 10. How #90 to #93 and #147 map

- #93 -> Phase 1: roots, elicitation and sampling from a downstream server are refused with a clear reason and documented. A tool added
  and removed while the server runs is tested (on modern through `listen`). Phase 3: a downstream input request passes through as
  MRTR when the client can answer.
- #92 -> Phase 2: hints and saved functions are served as Skills or resources, not as new tools. `SERVED` stays two.
- #90 -> first PR of Phase 3: session-qualified handles, since `requestState` and Tasks need the same nonce.
- #91 -> Phase 4: a long command is a task (`tasks/get`, `tasks/update`, `tasks/cancel`). The synchronous path stays. Finding of PR 1:
  the task methods are "2025-11-25 wire vocabulary with no SDK runtime" in the typed surface of server 2.4.0
  (`dist/mcp-BCJHyo7l.d.mts:725`), so Phase 4 depends on `@modelcontextprotocol/ext-tasks` and not on the SDK packages alone.
- #147 (decided): on Windows a compile-on-first-use opt-in helper, the path of PR #198. It does the confined read and write itself and
  passes bytes on a pipe. macOS needs no helper (plain Node). Outside 1.1.0. No prebuilt signed helper.

## 11. What PR 1 settled by reading, and what waits

Settled now. None of the answers breaks the cut of section 12 or a decision of section 13: "the broker on the modern era in 1.1.0"
stays possible as cut.

| Question | Answer | Source (read 2026-11-28) |
|---|---|---|
| Do the three packages exist at 2.4.0 with the dependencies of section 1? | Yes. The dependency list is longer than the draft said (section 1). | `npm view @modelcontextprotocol/<client,server,core>@2.4.0` |
| Does the `serveStdio` factory run one time or for each request? | One time for each connection, plus one time for a `server/discover` probe instance that is discarded if the client falls back to `initialize`. The factory gets `ctx.era` (`'legacy'` or `'modern'`). A factory must therefore have no side effect that matters twice. | server 2.4.0 `dist/createMcpHandler-DzlXH0KL.d.mts:193` to 209 and `dist/stdio.d.mts` |
| Does one stdio server answer both eras? | The same factory serves both eras, but one connection is pinned to the era of its opening exchange: "the opening exchange selects the era, ONE instance from the factory is pinned for the connection lifetime". A 2025 opening is served by default (`legacy: 'serve'`) or refused (`'reject'`). So one child, which has one connection to the router, has one era. This is the rule of section 4. The spec page says the same for the process: "A dual-era server MAY serve both eras concurrently on the same endpoint or process." (stated, not verified). On stdio a client must "probe with server/discover and fall back on any error that is not a recognized modern error". | server 2.4.0 `dist/stdio.d.mts` (`ServeStdioOptions`, `serveStdio`); `https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning` |
| How does a `subscriptions/listen` notification name its stream on stdio? | `_meta["io.modelcontextprotocol/subscriptionId"]` holds the JSON-RPC id of the listen request, verbatim, on every notification of the stream and on the first `notifications/subscriptions/acknowledged`. The graceful end result carries it too. | core 2.4.0 `dist/internal.d.mts:44` to 54 and `dist/schemas-DBHuY3cl.d.mts:1637` to 1660 |
| Where do `requestState` and the progress token sit? | `requestState` is at the top of an `input_required` result and in the params of the retried request, with `inputResponses`. The progress token is `params._meta.progressToken`, a string or a number. | server 2.4.0 `dist/mcp-BCJHyo7l.d.mts:685` to 711 and 1003 to 1016; core 2.4.0 `dist/schemas-DBHuY3cl.d.mts:39` |

What waits, each with its PR. Items that PR 1 already found are noted, and the PR still confirms them with a test.
- The stdio codec and `OAuthError`: found public in the client package (section 3). PR 3 and PR 6.
- `legacyShim`: found as `ServerOptions.inputRequired.legacyShim` (default `true`): on a 2025 connection the SDK fulfils an
  `input_required` return server-side, with real server to client requests and handler re-entry, up to `maxRounds` 8 (server 2.4.0
  `dist/mcp-BCJHyo7l.d.mts:2865` to 2891). What it does for our push elicitation: PR 7 and PR 13.
- `ttlMs`, `cacheScope` and the header rules: found in the client package (`dist/client-BTIWJvaF.d.mts:78` to 183 and 415; the three
  `Mcp-*` headers in `dist/src-CeKsbNLO.mjs:4655`). The rules for each are read in PR 6 and PR 10.
- The Skills identifier and methods: Phase 2. The package has the export `@modelcontextprotocol/server/ext/skills`.
- Which clients speak 2026-07-28: section 7, with the cells "not verified" that stay open until a test.

## 12. Phase 1 cut, one concern for each PR, all before 1.1.0

1. Baseline and this ADR: the numbers of section 9, the matrix of section 7, the decision that replaces 031. Docs only.
2. Adapter seam on v1: every SDK import of `src/host` moves behind `src/host/sdk/`, with the check. No behaviour change.
3. Own line codec in `src/core` for childtransport.ts and brokerlink.ts. No behaviour change.
4. Test seam: the tests take the SDK through one helper file.
5. v2 packages beside v1 (lockfile and pack review); the downstream client side on `@modelcontextprotocol/client`, legacy only; the
   error mapping and the unknown-tool text.
6. OAuth and login on the v2 client auth, with `iss` validation. SigV4 header test.
7. The server side (server.ts, main.ts, the Workspace provider and roots) on `@modelcontextprotocol/server`.
8. Remove SDK v1, re-measure section 9, update the bench results.
9. The flag: `TOOLSCRIPT_PROTOCOL` and the config key, default `legacy`, in the entry frame and the share key, with the documented
   list of unsupported methods (#93 part 1). `auto` does nothing yet.
10. Modern downstream for direct and lazy links (`auto`, `listen`, `ttlMs`), with the conformance tests.
11. The era-aware router in `src/core/mux.ts` (pure) with its table and property tests. No host change.
12. The broker on the modern era: the `ready` rule, the router wired in, share e2e with a modern child, the memory bench.
13. Modern upstream (`serveStdio`), with the ask refusal of section 8.
14. Release 1.1.0: budgets measured with `legacy` and with `auto`, README, FAQ, the fragments folded.

## 13. Decided by the owner

1.1.0 is SDK v2 always, modern opt-in in both directions and through the broker, legacy the default. A later 1.1.x flips to `auto`
on the evidence of section 8. A new decision replaces 031 (1.1.0 minor, then 1.1.x patches). CIMD after 1.1.0. #147 as in section 10.
The budgets and caps of section 9.
