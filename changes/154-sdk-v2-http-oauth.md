- The OAuth login checks `iss` (RFC 9207) and the `issuer` of the authorization server metadata. A server whose metadata `issuer` is not
  the URL it was read from now fails at login and at each refresh with `the authorization server metadata of <url> names another
  issuer (<received>), so toolscript-mcp sends it no login and no token`. A server that says in its metadata that it always sends `iss`
  gets no code from `login` when the browser answer has none or another one, and `login` prints no value that the browser gave.
- A new client registration sends `application_type: "native"`. The text of the SDK that follows `Cause:` in a `[mcp-sdk]` warning on stderr is
  left out, because an authorization server can echo a code or a client secret in it.
