- With `TOOLSCRIPT_PROTOCOL=auto`, toolscript-mcp serves the 2026-07-28 protocol to a client that opens with `server/discover`, as Claude
  Code does: the same two tools, the same instructions and the same results as a session of the older protocol. A client that opens with
  `initialize` gets what it got before. With the variable unset or `legacy`, `server/discover` gets the same error as before, and no byte
  changes. To go back, set `TOOLSCRIPT_PROTOCOL=legacy` and restart the client.
- On a 2026-07-28 connection, an `ask` rule refuses the call with the text for a client that cannot ask, and never allows it, and the
  built-in Workspace is not available. Both come back with the next two changes of the same release.
