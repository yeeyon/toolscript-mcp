# Authentication

Back to the [documentation index](../README.md#documentation).

## OAuth login

toolscript-mcp logs in to a remote HTTP server with OAuth. You do not need a proxy such as `mcp-remote`.

1. Add the server to the config with `"type": "http"` and `url`, without `headers`.
2. Run `npx -y toolscript-mcp login <server>`. If your config uses another path, add `--config <path>`.
3. Log in and approve the access in the browser. If the browser does not open, open the URL that login prints.

login waits 5 minutes for the browser and 30 s for the token exchange. Then it connects to the server and prints the
number of tools.

Some servers, such as the Google Workspace MCP servers, list their tools without a token and ask for one only on a
call. If such a server publishes protected-resource metadata, login starts the browser login all the same. A server
that answers without a token and has no such metadata needs no login. If its authorization server has no dynamic
client registration, give a client ID in `oauth`, as the next section shows.

- An HTTP server without `headers` logs in with OAuth. To log in to a server with other headers, add `"oauth": true`.
- `"oauth": false` turns the login off. An entry with an `Authorization` header and `oauth` is an error.
- login registers toolscript-mcp with the server, with dynamic client registration. Atlassian supports it, for
  example.

If a provider has no dynamic client registration, such as Google, register a client with the provider. Then give its
ID in `oauth`:

```json
"google": {
  "type": "http",
  "url": "https://mcp.example.com/mcp",
  "oauth": {
    "clientId": "<client id>",
    "clientSecret": "${GOOGLE_CLIENT_SECRET}",
    "scopes": ["openid", "email"],
    "callbackPort": 8765
  }
}
```

- `clientSecret` takes `${VAR}`, as other values do. Use a variable, so the secret stays out of the config.
- The token requests send the secret as `client_secret_basic` if the authorization server lists it, else as
  `client_secret_post`. Box, for example, lists both.
- `scopes` sets the scopes to ask for when the server names none.
- `callbackPort` sets the port of the login callback on `127.0.0.1`. Register `http://127.0.0.1:<port>/callback` as
  the redirect URI of your client.
- A client that you register by hand needs `callbackPort`, so its redirect URI stays the same at each login.
- Without `clientId`, login registers a client with a free port, and the next login uses that port again. If another
  program has the port, login registers a new client.
- If the server refuses the registered client, login fails and removes the client. Run login again to register a new
  client.

login writes the tokens to `~/.toolscript-mcp@GUARD@/oauth/<server>-<hash>.json`. The hash comes from the URL, so a new URL
needs a new login. On Linux and macOS, only your user account can read the file.

login opens only an authorization URL with `https`, or with `http` on `127.0.0.1`, `::1` or `localhost`. The `headers`
of an entry go only to the origin of its `url`, never to its authorization server.

toolscript-mcp refreshes the tokens when they expire. It never opens a browser while it runs as a server. If a
server needs a new login, `search_tools` shows the login command. Run the command in a terminal. The next search or
call connects again, with no restart. If the authorization server does not answer a refresh in 20 s, `search_tools`
shows the cause. The next search or call tries the refresh again.

Sessions that share one token store refresh one at a time, so a server that revokes a reused refresh token keeps your login.
A `.lock` file can show beside the store for a moment. If a session waits up to 20 s for another session, `search_tools` shows the cause. The next call tries again.

## AWS SigV4

toolscript-mcp signs the requests to an AWS HTTP server, such as the AWS MCP Server, with AWS SigV4. It uses the
credentials of a profile of the AWS CLI. You do not need a proxy such as `mcp-proxy-for-aws`, and you do not need a
login.

```json
{
  "mcpServers": {
    "aws": {
      "type": "http",
      "url": "https://aws-mcp.us-east-1.api.aws/mcp",
      "sigv4": { "profile": "dev" }
    }
  }
}
```

1. Install the AWS CLI version 2 and put `aws` on your `PATH`.
2. For an SSO profile, run `aws sso login --profile <profile>`.
3. Add one entry for each profile. Each entry uses one account.

- toolscript-mcp gets the credentials with `aws configure export-credentials --profile <profile>`. It keeps them in
  memory and gets new ones 5 minutes before they expire.
- When the credentials cannot be read, the call fails with the cause and the `aws sso login` command. After you log in
  again, the next call works, with no restart.
- The region and the service come from the host of `url`, such as `us-east-1` and `aws-mcp`. For another host, set
  `"region"` and `"service"` in `sigv4`.
- To send pairs such as `AWS_REGION` to the server, as `mcp-proxy-for-aws --metadata` does, set `"metadata"` in
  `sigv4`, for example `"metadata": { "AWS_REGION": "ap-southeast-1" }`. toolscript-mcp puts the pairs in `params._meta`
  of each request. A pair that the request already has stays as it is. A value can use `${VAR}`.
- An entry with `sigv4` does not log in with OAuth. An entry with `sigv4` and `oauth`, or with an `Authorization`
  header, is an error.
- toolscript-mcp signs only the requests to the origin of `url`. It never writes the credentials or the signature to a
  log.
