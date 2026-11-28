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
the MCP clients page (URLs in section 7). `npm run check` resolves the relative links of `docs/adr/` (they are in `LINK_ONLY`) and does not check external URLs.

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
  today) stays 2025. Both names: found, server 2.4.0 `dist/stdio.d.mts` (`serveStdio`, `StdioServerTransport`).
- Downstream: `ClientOptions.versionNegotiation` is an object `{ mode, probe? }` with `mode` `'legacy'` (default), `'auto'` (probes
  `server/discover`, falls back) or `{ pin }`. `client.getProtocolEra()` returns `ProtocolEra | undefined`. The first draft wrote
  the option as the bare string: that is corrected here. Sources, all found, client 2.4.0: `dist/client-BTIWJvaF.d.mts:189` to 250
  (`VersionNegotiationOptions` and the modes `'legacy'`, `'auto'`, `{ pin }`), `:327` (the option `versionNegotiation`), `:769`
  (`getProtocolEra(): ProtocolEra | undefined`), and `dist/index-BCNZS4Ap.d.mts:2493` (`type ProtocolEra = 'legacy' | 'modern'`).
- 1.1.0 is SDK v2 always. Modern is opt-in behind one flag, in both directions and through the broker (section 8). Nothing is
  advertised that the host cannot do: on a modern link roots, push elicitation and sampling do not exist.

## 3. Adapter boundary

- At REF 12 files of `src/host` import the SDK, and `src/core` imports none. New rule: SDK imports only in `src/host/sdk/` (client,
  server, transport, auth, errors). The rest of `src/host` uses that folder, and `tests/code.check.mjs` enforces it.
- The adapter is thin: re-exports, our error classes, the era of a link. The SDK does the protocol work.
- `ReadBuffer`, `serializeMessage` and `deserializeMessage` (childtransport.ts, brokerlink.ts) become a small line codec of our own in
  `src/core`: the broker already splits lines itself. Finding of PR 1: these three names, and `OAuthError`, are found in the export list
  of `@modelcontextprotocol/client@2.4.0` (`dist/index.d.mts`, line 2530), so v2 does not make them private. PR 3 keeps its cut and
  decides whether the own codec is still worth it. Outcome of PR 3: it was worth it, for a different reason. v2's reader was not
  compared with v1's (cap, `\r`, empty line), and a silent difference there ends real servers. `src/core/codec.ts` owns the framing
  of a direct child (bytes to lines, the 10 MB cap in bytes, the send line), and `tests/codec.test.ts` compares it with the SDK's
  `ReadBuffer` on the same bytes, so any SDK can be compared with it. The check that a line is a JSON-RPC message stays the SDK's
  `deserializeMessage`, which the codec takes as a parameter. `brokerlink.ts` keeps `lineSplitter`: it works on text, counts
  characters and skips blank lines, and the direct path does none of these. The two framers stay two. A finding, not fixed in PR 3:
  a blank stdout line closes a direct child (the check throws, and the transport closes) but not a shared one (the splitter skips it).
- Known breaks to absorb, with their source:

| Name or behaviour | Status | Source |
|---|---|---|
| `ProtocolError`, `ProtocolErrorCode` | found | client 2.4.0 `dist/index.d.mts:2530` |
| `McpError`, `ErrorCode` (v1 names) | not found | no `.d.mts` of the three packages |
| `setRequestHandler(method, (request, ctx) => ...)` | found | server 2.4.0 `dist/mcp-BCJHyo7l.d.mts:2540` |
| `ctx.mcpReq.id`, `ctx.mcpReq.signal` | found | same file, `mcpReq` at 2119 to 2183 |
| `ProtocolErrorCode.InvalidParams = -32602` | found | same file:1553 |
| an unknown tool rejects with -32602 where v1 gave `isError: true` | found, no effect on the client | PR 5: a server side change. Our client refuses an unlisted name before the call, and a server that answers -32602 to a listed name gives the text of the golden test (`tests/errors-golden.test.ts`) |
| `callTool` takes no result schema | found | PR 5: `callTool(params, options)`, client `dist/client-BTIWJvaF.d.mts:1082`. The result is checked against the tool's output schema from the response cache of the client, or from `options.toolDefinition` |
| `listMaxPages`, default 64 (we keep `MAX_PAGES`) | found | client `dist/client-BTIWJvaF.d.mts:390` and 814 |
| a list with no capability is empty | found, not reached | PR 5: the host sends `tools/list` by hand (`request()`), so a server with no `tools` capability that answers -32601 gives the same reason as with v1 (golden case `nocaps`) |

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
- MRTR: an `input_required` result goes back by id to the link that asked. The router keeps the `requestState` string itself for that
  link (bounded: 64 for each link, the oldest goes, each at most 8,192 characters; a longer one is not kept). Changed in PR 11: no 10-minute
  expiry and no hash, because the router has no clock and no crypto; the child signs and expires its own state. A retry with `inputResponses` whose `requestState` belongs to another link gets
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

What lives outside the factory (PR 13). With `auto`, `serveStdio` runs the server factory for a `server/discover` probe and again for
the connection, and throws the probe instance away when the client falls back to `initialize` (an opening with a probe and then an
`initialize` on one connection is served as a legacy session). So `createHost` (`src/host/server.ts`) makes the state of the process one
time: the kept results of `recall`, the `saveFile` folder and the written files, the learned shapes and their load, the policy and its
reload, the runs in flight and their stop signal, the downstream links, the Workspace bind and the orphan sweep. The factory only
builds an instance (`HostServer`) and sets its two handlers, so closing a discarded instance stops no run, closes no child and removes
no file. Both eras get the same surface (`tools` only, no `resources`, no `extensions`) and the same instructions. Until the next two
changes of the release, a modern instance cannot ask (`elicitInput` throws on a 2026-07-28 request, so `canAsk` is false and an `ask`
decision gets the refusal for a client that cannot ask). Its Workspace follows the roots of the client (P3-2): roots/list does not exist in
that era, so the first `tools/call` that needs the Workspace of a connection whose request declares `roots` in its envelope returns
`input_required` with a roots request (`inputRequired.listRoots()`) and a sealed, used-once state of kind `roots` bound to the tool
and the arguments (HMAC-SHA256, a key of 32 random bytes made at the start, 10 minutes, at most 256 open; `src/host/workspace/rootsstate.ts`),
and does nothing else. The retry's `inputResponses.roots` settles the same list that the legacy push settles, through `narrowRoot`, so a
root is the bound root or inside it. The first answer of the process stays. No `roots` declared, or a retry with no usable `roots` entry
(none, an error, another shape), or a third call after two roots requests with no good retry, ends with no Workspace for the process: the
bind refuses (never the bound root), its tools are not listed, a nested call of one is refused as a server that is not available, and one
fixed line on stderr says so. So a client that declares roots and never answers loses at most two calls. Rows: `tests/workspace-roots-modern.test.ts`
(the state, the decisions, gate G6 with a legacy and a modern column) and `tests/modern-upstream.e2e.mjs` (the built server). A request of
`serveStdio` that is not 2026-07-28 and not a legacy opening is answered by the entry itself, with the errors of the SDK: a probe with
a partial envelope gets -32602 (a malformed envelope) where the legacy server answered -32601.

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
PR 13 and the release: Claude Code states that on its v2 runtime it "Asks HTTP, stdio, and claude.ai connector servers whether they support the newer
revision and uses it with those that do." It adds: "Claude Code asks stdio servers for that revision by default." So today a probe may already reach our v1 stdio server. Observed in use on 2026-11-28 (Claude Code 2.1.332, Windows, SDK 1.32.2 server, one working day of `run_code` calls), no test in this repo: the session worked. Which runtime that session used is not recorded. The gap stays: its answer to `server/discover` is not verified in a test, and PR 13 adds a test that sends `server/discover` to the built server and checks the answer that the stdio fallback of the spec expects.
The same page says: "To decide whether Claude Code asks servers about the newer revision, set MCP_PROTOCOL_NEGOTIATION to auto or legacy." The same page also says "Claude Code connects to every other server as v1 does."

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

- Release line (decision 043 replaces decision 031). 1.1.0 is a minor release with SDK v2 and `TOOLSCRIPT_PROTOCOL=legacy|auto` (the
  environment only, never a config key: 1.0.5 refuses a config with an unknown key, so a key would break a rollback to it, and 1.0.5
  ignores a variable), default `legacy`. `TOOLSCRIPT_LEGACY_SERVERS=<key>,<key>` keeps the named servers on `legacy` whatever the host
  value is, so one old server that hangs on the probe does not force the whole host back. It is a variable and not a key on the entry,
  for the same reason: 1.0.5 turns an entry with an unknown key into an invalid server. Then come 1.1.x patch releases. A 1.1.x patch
  flips the default to `auto`, and only on the evidence below (decision 048 moves that flip into 1.1.0). In plain words: this flip
  changes a default in a patch release, which decision 031 did not allow and decision 043 does. Semantic versioning stays as
  `docs/sandbox.md` says: the flag keeps both values, and `legacy` stays.
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

Open point for the start budget on macOS. The same product code measured 156.0 ms against 214.0 ms for base in one run and 258.5 ms
against 189.5 ms in another, and the second one fails the budget of +50 ms. One median of one run is too noisy there, so the
start budget needs a sturdier measure on macOS (the stress script gets a fix for it). The budget itself stays as accepted.

| Metric | Value at REF | Unit | Source (command or run) | Date | Spread | Budget |
|---|---|---|---|---|---|---|
| Start, `tools/list` reply, median, head at REF (base `v1.0.4` in brackets), Node 24. Head of run 1 is `5b9e4ff`, the same product code as REF | Run 1 (46130315779): Windows 150.5 (154.0); Ubuntu 158.5 (154.5); macOS 156.0 (214.0). Run 2 (46131176322): Windows 134.0 (142.0); Ubuntu 147.0 (141.0); macOS 258.5 (189.5) | ms | `baseline` profile, run 46130315779 (https://github.com/yeeyon/toolscript-mcp/actions/runs/46130315779), jobs 140933837726, 140933837802, 140933837708; head at REF, base at the tag `v1.0.4`, built and measured in turns on one runner | 2026-11-28 | two runs, one median for each side in each: Windows 134.0 to 150.5, Ubuntu 147.0 to 158.5, macOS 156.0 to 258.5 | +10% or +50 ms |
| Host private bytes, head (base `v1.0.4`), 6 hosts, Node 24 | Ubuntu 74.7 (73.6); Windows 159.5 (159.8); macOS not judged: the system has no private memory number for a process | MB a host | `baseline` profile, run 46131176322 (https://github.com/yeeyon/toolscript-mcp/actions/runs/46131176322). Same product code as REF: only `scripts/stress.mjs` differs, with the fix of the memory check. Run 46130315779 did not measure memory (a bug of the stress script) | 2026-11-28 | one value for each side in one run | +10 MB a host |
| Sharing saving, head (base) | Ubuntu 26.6 (26.5); Windows 57.9 (58.2); macOS not judged, same reason | MB saved a host | same run | 2026-11-28 | one value for each side in one run | modern child: the same saving as legacy |
| Bytes of the `baseline` profile, head (base in brackets), same run | `tools/list` 2849 (2862); instructions 296 (296); `search_tools` 233 (790; the empty-query overview that #208 rewrote) | bytes | same run, all three OS print the same. A size guard, see the rule below | 2026-11-28 | exact | 0 on legacy |
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
since that commit: #212 (`84cc1bc`) rewrote the end of `SEARCH_DESCRIPTION` in `src/core/protocol.ts` (the literal went from 381 to 368
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
Rule: a v2 PR changes 0 of these bytes. The rule is judged by equal SHA-256, from the hash command below with the configs of this table.
The byte rows of the `baseline` profile (`scripts/stress.mjs:449` to 451, `head <= base` on the length) are a size guard only, not this proof.
A feature PR that changes the bytes records the new hash in this ADR.

| Config | `tools/list` result bytes | SHA-256 | Instructions bytes | SHA-256 |
|---|---|---|---|---|
| empty: `{"mcpServers":{}}` | 2849 | `a158f339e944a5fa7387b5ce38005b4955fa12a5670d4ef29639e2951d59a420` | 286 | `3c677dd15356ec0047d4fb6716bea6d6a39080f396b37ab5219c2cbf84542f84` |
| demo: `{"mcpServers":{"demo":{"command":"node","args":["<abs>/demo/server.mjs"]}}}` | 2849 | `a158f339e944a5fa7387b5ce38005b4955fa12a5670d4ef29639e2951d59a420` | 292 | `59c786973984b1a9d194a2ad7560c38bcc5713965bb6acf05c00a581af4247c0` |

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
  (`dist/mcp-BCJHyo7l.d.mts:723`), so Phase 4 depends on `@modelcontextprotocol/ext-tasks` and not on the SDK packages alone.
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
| How does a `subscriptions/listen` notification name its stream on stdio? | `_meta["io.modelcontextprotocol/subscriptionId"]` holds the JSON-RPC id of the listen request, verbatim, on every notification of the stream and on the first `notifications/subscriptions/acknowledged`. The graceful end result carries it too. | core 2.4.0 `dist/internal.d.mts:44` to 54 and `dist/schemas-DBHuY3cl.d.mts:1610` to 1616 and 1637 to 1660 |
| Where do `requestState` and the progress token sit? | `requestState` is at the top of an `input_required` result and in the params of the retried request, with `inputResponses`. The progress token is `params._meta.progressToken`, a string or a number. | server 2.4.0 `dist/mcp-BCJHyo7l.d.mts:655` to 661, 685 to 711 and 1003 to 1016; core 2.4.0 `dist/schemas-DBHuY3cl.d.mts:39` |

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
   Done. Rule 3 names (not in the table of section 3, re-exported under their own name, for PR 5 to read): `Client`,
   `getDefaultEnvironment`, `StreamableHTTPClientTransport`, `StreamableHTTPError`, `InMemoryTransport`, `McpServer`, `Server`,
   `StdioServerTransport`, `auth`, `discoverOAuthProtectedResourceMetadata`, `UnauthorizedError`, `OAuthClientProvider` and the
   schemas `OAuthClientInformationFullSchema`, `OAuthClientInformationSchema`, `OAuthTokensSchema`. Rule 2 names that stay in
   the folder: `McpError`, `ErrorCode` (as `isProtocolError`, `protocolCode`, `PROTOCOL_CODES`), `ListToolsRequestSchema` and
   `CallToolRequestSchema` (as `onListTools`, `onCallTool`), `ToolListChangedNotificationSchema` (as `onToolListChanged`),
   and the result-schema slot of `callTool` (as `callClientTool`).
   For PR 7: callers still use v1 members of the server side that stay outside the folder: `extra.signal` and
   `extra.requestId` (`server.ts`, `workspace/provider.ts`; v2 has `ctx.mcpReq.signal` and `ctx.mcpReq.id`),
   `mcp.server.getClientCapabilities()` and `elicitInput` (`server.ts`), `oninitialized`, `onclose` and `listRoots`
   (`workspace/roots.ts`), and `client.listTools` (`downstream.ts`). PR 7 leaves the callers alone only if `onCallTool`
   hands them a v1-shaped `extra` built from the v2 ctx.
3. Own line codec in `src/core` for childtransport.ts and brokerlink.ts. No behaviour change. Done, narrower than the title: the
   framing of `childtransport.ts` only (`src/core/codec.ts`), the SDK check passed in, `lineSplitter` untouched. See section 3.
4. Test seam: the tests take the SDK through one helper file. Done: `tests/sdk.mjs` re-exports the SDK v1 names that the tests use (and `ReadBuffer`, `deserializeMessage` and `serializeMessage` for `tests/codec.test.ts`), imports the package and never `src/host/sdk/`, so from PR 5 to PR 7 the test peers stay on v1 while the host moves. PR 8 moves them by a change to that file. The raw-text check covers `tests/`, `bench/`, `demo/`, `scripts/` and `plugin/` too, with two named exceptions (`tests/code.check.mjs`, and the reference servers `@modelcontextprotocol/server-*` that tests name as sample config data), and fails when `src/`, `runtime/` or `demo/` import from `tests/`.
5. v2 packages beside v1 (lockfile and pack review); the downstream client side on `@modelcontextprotocol/client`, legacy only; the
   error mapping and the unknown-tool text. Done, with a narrower cut: the `Client` of the stdio, shared and Workspace links, the
   transport types of those links, their `deserializeMessage` and the in-memory pair. The HTTP link, the OAuth provider, `auth`,
   `login.ts` and the SigV4 fetch stay on v1 (PR 6), because the v2 HTTP transport runs the SDK's own auth flow on the provider and
   its errors are tested with `instanceof`: transport, provider and errors must be one SDK version. `getDefaultEnvironment` stays on
   v1 too. Findings of PR 5, all read in client 2.4.0 and tested:
   - Lockfile: two packages are gained, `@modelcontextprotocol/client` 2.4.0 and `@modelcontextprotocol/core` 2.4.0 (both Apache-2.0,
     registry.npmjs.org, no install script). `zod` (4.6.7), `jose`, `eventsource`, `eventsource-parser`, `pkce-challenge` and `cross-spawn`
     were in the lockfile already, from SDK 1.32.2, at versions that satisfy the ranges of section 1. Only the client is a dependency
     of the repository; `@modelcontextprotocol/server` is not added before a file imports it (PR 7).
   - Size: packed 517,003 bytes (REF 382,836, budget 478,545), unpacked 2,314,296, `dist/host/main.js` 2,131,108 bytes (base 1,491,349), 16
     files. The packed size is over its budget by 38,458 bytes until SDK v1 leaves in PR 8. `dist/host/broker.js` is byte-identical to a
     base build (SHA-256 `8e677c76d452533a27f331f28db885784fd7a7b7e34842ff6e4a64d3a7b8caf4`) and holds no SDK.
   - Legacy only, written out: `versionNegotiation: { mode: 'legacy' }`. The first message of each link kind (direct, shared,
     Workspace) is the same bytes at base and head (`tests/initialize-golden.test.ts`): protocol version `2025-11-25`, `capabilities: {}`,
     `clientInfo`. No `server/discover` is sent.
   - Error texts: v2 raises `ProtocolError` for a code that a server answered and `SdkError` for a timeout and a closed connection, with a
     message that has no `MCP error <code>:` prefix, and a timeout with the code string `REQUEST_TIMEOUT`. The folder maps both to
     the v1 text and numeric code (`sdkErrorText`, `protocolFailure`), so every text of `tests/errors-golden.test.ts` is the same at base
     and head: the codes -32602, -32601, -32603 and a custom code, the call limit, a child that exits, a cancelled call, an `isError`
     result, a result that breaks its schema, a result with no structured content, a server with no `tools` capability, an unlisted name
     and a missing command.
   - Paging: `client.listTools()` with no cursor walks every page itself, with a cap of 64 pages that throws, and fills the response
     cache. The host keeps its own `MAX_PAGES` (100) and its time limit, so it sends each page of `tools/list` by hand. A page by hand
     fills no cache, so `callClientTool` gives the v2 client the listed tool (`toolDefinition`) and a result is still checked against its
     output schema.
   - `getDefaultEnvironment` of v2 adds six Windows variables (`COMSPEC`, `PATHEXT`, `PROGRAMDATA`, `PROGRAMFILES(X86)`,
     `PROGRAMW6432`, `WINDIR`) to the list of v1. That changes the environment of every child on Windows, so it stays v1 until a decision.
   - `deserializeMessage` of v2 gives the same messages and the same error names as v1 on every row of `tests/codec.test.ts`
     (the list of rows that differ is empty).
   - The v1 `Transport` and the v2 `Transport` are assignable both ways, and a v2 client connects to a v1 `Server` over the v2 in-memory
     pair, with no cast. Only `src/host/sdk/` knows which client a link has.
   - A result that breaks the result schema of the SDK: v2 raises `SdkError` (`INVALID_RESULT`) with the message `Invalid result for
     <method>: <issues>`, where v1 gave the issues alone. `sdkErrorText` strips the prefix, so the text of a `tools/call` result with a
     text block that has no text, and the reason of a `tools/list` with a tool that has no `inputSchema`, are the v1 bytes (golden cases
     `bad_result` and `badlist`).
   - What a server sees that is not the same as with v1 (nothing a server is known to read): on a call timeout, the `reason` of
     `notifications/cancelled` is `SdkError: Request timed out` (v1: `McpError: MCP error -32001: Request timed out`), and
     `notifications/initialized` has its keys in another order.
   - Size: the growth is not two copies of zod (zod 4.6.7 is one package, and v1 already used it). The v2 client inlines `ajv` (its
     `ajvProvider-*.mjs`, about 289 KB) beside the `ajv` (215 KB) and `ajv-formats` of v1, and adds its own `src-*` (198 KB) and
     `public-*` (110 KB) chunks. The notice of the inlined ajv (MIT) must stay in `dist/third-party-licenses.txt` after PR 8.
   - The `baseline` run of this PR (stress run 46144301916, against `d18eaa6`, Node 24): the start time, paired, is +23.5 ms on
     Ubuntu, +30.5 ms on macOS and +36.5 ms on Windows (all inside the budget); host memory is +9.5 MB on Ubuntu (84.2 against 74.7 MB,
     budget +10) and +3.2 MB on Windows; the sharing saving on Windows is 57.4 against 58.1 MB, which fails the strict rule; the package
     is +35 % and `main.js` +43 %, which fail as expected until PR 8 removes v1.
6. OAuth, login, `StreamableHTTPClientTransport` and the SigV4 fetch on the v2 client, with `iss` validation, in one PR: the HTTP link
   leaves v1 there. SigV4 header test. Done, in one PR because the transport, the provider and `auth` are one SDK version. After it
   no file in `src/` names `sdk/client/`, `sdk/shared/` or `sdk/server/auth/` (`tests/code.check.mjs`, a row for each); the folder
   imports from v1 only `server/index.js`, `server/mcp.js`, `server/stdio.js` and `types.js`, which PR 7 moves. `HostClient` is
   the v2 `Client` and `newClient` takes no link kind; the one v1 shape that stays is the test double of `tests/run.test.ts` in
   `callClientTool`. Findings of PR 6, read in client 2.4.0 and tested:
   - Lockfile: no package gained or changed. `@modelcontextprotocol/core` 2.4.0 (in the lockfile since PR 5) is now a pinned
     dependency of the repository, one root line, because the client package does not export the schemas of the stored values
     (`OAuthTokensSchema`, `OAuthClientInformationSchema`, `OAuthClientInformationFullSchema`); only `src/host/sdk/auth.ts` names core.
     `parseStored` keeps and drops the same parts at base and head (`tests/store-golden.test.ts`, 19 store files). Core's schemas
     leave out the `issuer` stamp, so `oauth.ts` puts a string stamp back (`stampOf`), as v1's schemas kept it.
   - `getDefaultEnvironment`: the list is now our own constant (`src/core/childenv.ts`), the v1 list. `tests/childenv.test.ts` runs the v1
     function in a child on `win32`, `linux` and `darwin` with every variable set and compares: no child sees a new variable.
   - Provider: same methods in the same order. `OAuthError` is `(code, message)` with `.code` (v1 `.errorCode`): `LoginNeeded`,
     `RefreshFailed` and the new `IssuerRefused` take `invalid_request`, a code that makes `auth` neither retry nor start a login, so the
     message stays the whole reason. `auth` calls `invalidateCredentials('client')` then `('tokens')`, never `'all'`: the two refusal
     texts of `oauth.ts` stay, and the `client` branch also clears the tokens of the login. The running server still starts no login,
     registers no client and opens no browser: `state`, `redirectToAuthorization`, `saveCodeVerifier` and `invalidateCredentials` throw `LoginNeeded`.
     The login provider keeps `discoveryState` and `saveDiscoveryState` in memory, so the callback leg is bound to its server and the
     `[mcp-sdk]` warning about a provider without them never prints.
   - HTTP errors: `SdkHttpError` (`.status`) and `SdkError` `CLIENT_HTTP_UNEXPECTED_CONTENT` replace `StreamableHTTPError`. `sdkErrorText` gives
     the v1 text (`Streamable HTTP error: <message>`, `after successful authentication`, `after trying upscoping`, and the redirect text without
     the hint that v2 adds). `tests/errors-golden.test.ts` has 17 HTTP cases (401 without OAuth, with OAuth and no token, after a refresh,
     403, 404 with and without a session, 400 with an unknown session, 500, 503, `text/html`, a body that is not JSON, a dropped connection,
     a 307 to another origin, an SSE answer that ends early, a refused connection at connect and at a call, SigV4): the same bytes at base
     and head, from a raw `node:http` fake with no SDK. One v2 text had to be mapped for that (the redirect hint).
   - First requests: `tests/initialize-golden.test.ts` records the `initialize` body and the header names and values of the first three
     requests with and without OAuth. They are equal; no `server/discover`, `mcp-method` or `mcp-name` is sent.
   - Server-visible change, forced: the registration body gains `application_type: "native"` (v2 derives it from the loopback redirect).
     `tests/login-golden.test.ts` records the registration, the authorization URL and the code exchange at base; the only difference at
     head is that field. The `[mcp-sdk]` lines on stderr: the text after `Cause:` is the error text of the authorization server and can echo
     a code or a client secret, so `oauth.ts` leaves it out once per process (`guardSdkWarnings`, which wraps `console.warn`).
     `tests/issuer.test.ts` echoes the code and the secret with `invalid_client` and `invalid_grant` and finds neither on stderr.
   - `iss` (RFC 9207), new: `login` reads `iss` from the callback and checks it against the metadata before it sends the code, and before it
     prints the `error` text of an error answer. No metadata or no `issuer`: no check. No flag and no `iss`: works as before. The flag
     `authorization_response_iss_parameter_supported: true` with no `iss`, or any `iss` that is not the exact issuer (also with no flag, as v2 does):
     exit 1, no code sent, no tokens stored, the received value never printed.
   - The `issuer` of the metadata must equal the URL it was read from, one trailing `/` apart, at login and at each refresh, with no skip
     option. A server whose metadata names another issuer, and worked on v1, now fails with `the authorization server metadata of <url>
     names another issuer (<received>), so toolscript-mcp sends it no login and no token`, in `login` and as the link reason. An opt-out
     is a later decision of the owner. A store stamped by v1 with and without the trailing `/` still refreshes (tested).
   - SigV4: v2 sets `mcp-method` and `mcp-name` only on a request with a modern envelope, so never here. The signature covers `host`,
     `x-amz-*` and `content-type`, so it is the same; the test recomputes the signature of each request the transport sent and compares the
     other headers with the recording of base. This replaces a fixed clock: the signature covers only `content-type`, `host` and `x-amz-*`, so re-deriving it from what the fake received proves the covered headers more directly (accepted deviation from the bar's fixed-clock test).
   - Refresh under the lock is unchanged: the refresh request body is still a `URLSearchParams` at `fetchWithinOrigin`, `src/core/lock.ts` and
     `oauthlock.ts` have 0 changed lines, and `oauth-lock*.test.ts`, `oauthlock.test.ts` and `oauth.test.ts` pass unchanged on the v2 flow.
7. The server side (server.ts, main.ts, the Workspace provider and roots) on `@modelcontextprotocol/server`. Done (PR 7), legacy era only, no model-facing change.
   - `src/host/sdk/server.ts` names `@modelcontextprotocol/server` 2.4.0 (exact, dev dependency; the lockfile gains that one package).
     No file of `src/` imports the first SDK; `tests/code.check.mjs` refuses it there, with a row for each v1 path. The test peers stay
     on v1 (`tests/sdk.mjs`) until PR 8.
   - `onListTools` and `onCallTool` take the v2 form and hand the caller `signal` and `requestId` from `ctx.mcpReq`. `getClientCapabilities`,
     `elicitInput` (with `relatedRequestId`), `oninitialized`, `onclose` and `listRoots` keep their names on the v2 `Server`: no cast.
   - The session server is `HostServer`, a `Server` and no longer an `McpServer` (the host never used its tool registry). A hand-made
     instance lists no 2026 revision, so it installs no `server/discover` handler: the probe is answered -32601 and Claude Code falls back to
     `initialize`. Two differences that a raw client saw, and the fix of each: (1) `McpServer` of v1 declared `tools.listChanged: true`, so
     `HostServer` declares it by hand; (2) v2 answers a `tools/call` request that fails its schema with -32602 and a text that starts with
     `Invalid tools/call request: `, where v1 gave -32603 and the issues alone. `HostServer` overrides the documented protected hook
     `_wrapHandler` and maps it back.
   - Golden: `tests/upstream-golden.test.ts` (raw JSON-RPC peer, no SDK client), recorded at the PR 6 head before the change and unchanged
     after it, byte for byte, key order included. `initialize` for six versions, the plain requests, the `server/discover` probe (in process
     and over `dist/host/main.js`), the ask (accept, decline, cancel, a bad action, an empty result, an error; the 10-minute timeout is not
     waited for, the cancelled run covers "no answer"), roots, a cancelled run, an id in flight twice and a peer that closes mid-run.
     `inputRequired.legacyShim` changes nothing, so it stays at its default. No `[mcp-sdk]` line reaches stderr in these cases.
   - Size against PR 6 (`ecaf4e5`, Windows, Node 22): `main.js` 2116508 to 2047428 bytes, packed 515483 to 508024, unpacked 2298543 to
     2233146, 16 files, `broker.js` SHA-256 unchanged (`8e677c76...`). Bytes in `main.js` by part: the v1 SDK (160 KB), its `ajv` (212 KB),
     `fast-uri`, `zod-to-json-schema` and a part of `zod` (332 to 213 KB) are gone; the server adds `ajv` 289 KB, `src` 189 KB, `mcp` 49 KB and
     `stdio` 3 KB. The client and the server each hold an `ajv` of 289 KB: one validator could serve both (the `jsonSchemaValidator` option
     of the server); measured here, not applied. PR 8 takes it.
8. Remove SDK v1, re-measure section 9, update the bench results.
9. The flag: `TOOLSCRIPT_PROTOCOL` and `TOOLSCRIPT_LEGACY_SERVERS` (environment only, no config key), default `legacy`, in the entry
   frame and the share key when `auto` (a `legacy` link has the bytes of 1.0.5, so a `legacy` and an `auto` link never share a child),
   with the documented list of unsupported methods (#93 part 1, `docs/sandbox.md`). `auto` changes no byte of a message yet.
10. Modern downstream for direct and lazy links (`auto`, `listen`, `ttlMs`), with the conformance tests.
11. The era-aware router in `src/core/mux.ts` (pure) with its table and property tests. No host change.
12. The broker on the modern era: the `ready` rule, the router wired in, share e2e with a modern child, the memory bench.
13. Modern upstream (`serveStdio`), with the ask refusal of section 8.
14. Release 1.1.0: budgets measured with `legacy` and with `auto`, README, FAQ, the fragments folded.

## 13. Decided by the owner

1.1.0 is SDK v2 always, modern opt-in in both directions and through the broker, legacy the default. A later 1.1.x flips to `auto`
on the evidence of section 8. A new decision replaces 031 (1.1.0 minor, then 1.1.x patches). CIMD after 1.1.0. #147 as in section 10.
The budgets and caps of section 9.
