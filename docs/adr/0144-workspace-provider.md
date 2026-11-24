# Workspace provider for issue #144

Status. Proposed integration and Linux confinement experiment. [Issue #144](https://github.com/yeeyon/toolscript-mcp/issues/144)

## Use the existing downstream call path

Register the built-in provider as a session-local downstream MCP server. Connect it through the SDK's `InMemoryTransport` at the point where `connectAll` creates a transport. The existing SDK client then lists and calls Workspace tools through the same path as other downstream tools. The public MCP server still lists `search_tools` and `run_code`. Keep the adapter outside broker sharing and the lazy tool cache.

| Option | Consequence |
| --- | --- |
| In-process MCP adapter | Reuses MCP schemas, calls, cancellation, and the downstream lifecycle. One host process owns each session's grant. The Workspace handler must bound its own work. |
| Bundled stdio MCP server | Reuses the same protocol and adds a process per workspace. It needs explicit launch and sharing rules so the broker cannot share grants. A child with the same OS rights still needs a filesystem boundary. |
| Synthetic catalog entries and direct dispatch | Requires a second way to link and invoke a tool. Discovery, policy marks, errors, and cancellation can then diverge from the SDK path. |

Use the adapter for the MCP protocol. Keep filesystem confinement in a host-side backend. A platform that needs native code can add a narrow helper behind that backend without adding another MCP server.

## Bind authority at startup

Opt in through local config with one absolute root and optional exclusions. Hold the opened root for the session and close it at shutdown. The configured root and its ancestors must be trusted at startup. A later root replacement must never change the grant. Apply grant changes at restart so the existing per-run policy reload cannot expand filesystem authority. CLI diagnostics must use the same config parser and backend capability check as the running server.

Use `workspace` as the built-in server key. A configured downstream server with that key keeps its existing behavior while the built-in provider is disabled. If both are configured, report the conflict and make the key unavailable. The other links remain usable. Treat provider failure as a workspace-specific diagnostic.

The adapter exposes versioned schemas for `list`, `search`, `read`, and `stat`. The request path uses slash-separated components relative to the grant. The handler validates the path before filesystem access. Results include relative paths. `search` returns line numbers, and `read` returns UTF-8 content and a hash of the original bytes. Mark the provider's results as untrusted through the existing downstream path. Bound the traversal, the bytes read, and the returned data. Check cancellation during traversal and reads.

The Workspace backend must enforce exclusions for every operation. This includes the actual config path, ToolScript's guarded folders, and sensitive names and locations inside the grant. Both direct reads and discovery use this rule. An ignore file can further filter discovery. Exclusions must account for filesystem aliases. Logs contain operation and outcome metadata. File contents, raw queries, and diffs stay out of the logs.

## Prove confinement before enabling workspace access

Node 22 opens paths by name and returns a handle for the resulting file. Its documented API has no equivalent of Linux `openat2` with a directory descriptor and resolution restrictions. A path check and a later open by name leave two separate lookups. A component walk through held directory handles can continue after a nested directory moves outside the grant. [Node 22 filesystem API](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesopenpath-flags-mode), [Linux pathname lookup](https://www.kernel.org/doc/html/latest/filesystems/path-lookup.html#resolution-restriction-flags)

On Linux, the fixture opens each full path relative to the original root descriptor. `openat2` confines resolution and refuses symlinks and mount crossings. The fixture verifies the type and link count on the resulting descriptor before it reads bytes through that same file reference. This uses a trusted `/proc` mount. A read refers to the file authorized at lookup time even if a later rename moves that file. Grant trust and file policy still need to cover how an entry arrives inside the root. [Linux `openat2` manual](https://www.man7.org/linux/man-pages/man2/openat2.2.html), [Linux lookup implementation](https://github.com/torvalds/linux/blob/master/fs/namei.c)

The Linux experiment needs a compiler, Linux headers, and a kernel that supports `openat2`. Run it with `sh tests/workspace-openat2.check.sh`. It creates its own sample trees and checks returned bytes, root separation, refusal of links and special files, and lookups during a directory swap. It exercises file reads only. Production still needs bounded discovery, exclusions, cancellation, config and policy integration, and tests through the public MCP server.

Keep the provider unavailable until the package has a verified way to supply confined filesystem access. For a Linux-first implementation, evaluate a release-built binding that confines opens and leaves search and MCP handling in Node. Verify it from an installed npm tarball on each supported platform and architecture. The regular npm install must work without a compiler. If the binding or required kernel support is absent, the workspace diagnostic reports that the provider is unavailable.

Enable Windows and macOS only after equivalent confinement is verified there. Windows exposes directory-handle-relative opens through native APIs, and macOS exposes a native flag to refuse symlinks across a path. Those APIs are candidates for platform work. [Windows `NtCreateFile` reference](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile), [Apple `fcntl.h`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h)

## Sequence the milestones

1. Verify confinement and packaging, then wire the adapter for the read-only operations. Drive search and read through `run_code` in a Claude-free integration test.
2. Design argument-aware authorization for editing. Preview and apply need separate permissions. An apply needs a fresh check of the approval, target, and expected hash at the write boundary.
3. Evaluate named task execution under a separate grant. Test cancellation, process-tree cleanup, and refusal or confinement of untrusted projects before enabling it.
