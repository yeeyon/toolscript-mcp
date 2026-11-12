# toolscript-mcp

toolscript-mcp will be a standalone MCP server that works from any MCP client. The model writes one JavaScript
program that calls the tools of your other MCP servers in a sandbox. Only the result comes back into the context.

## Status

Pre-release, not published. This repository holds the reusable core and the sandbox runner. The server is not built yet.

## Credits

toolscript-mcp is derived from claude-code-mode by Gabriele Pavanello (https://github.com/gabe4coding/claude-code-mode), MIT License, at commit eea4077. The sandbox runner, its protocol, tool search, output projection and the hint format are his work. toolscript-mcp is an independent project and is not endorsed by him. It is not affiliated with or endorsed by Anthropic.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
