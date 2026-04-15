# Contributing

Thanks for your interest in contributing to pocket-option-mcp.

## Scope

This tool is an **MCP server** that connects Claude Code to a live Pocket Option trading bot. All contributions must stay within this scope.

### What's in scope

- Improving reliability of existing MCP tools (better error handling, validation)
- Adding new analysis and intelligence features
- Bug fixes and test coverage
- Documentation improvements
- Strategy development and backtesting enhancements
- New trading signal patterns and indicators

### What's out of scope

Contributions **must not** add features that:

- **Modify the bot's core database (`trading_data.db`)** — MCP server is read-only on bot data
- **Bypass Pocket Option authentication** — this tool requires a valid Pocket Option account
- **Execute trades without user consent** — all manual trades via `po_trade` are explicit
- **Introduce security vulnerabilities** — no SQL injection, command injection, or XSS
- **Write to `socket_option/determ/` directory** — all bot modifications go in `pocket-option-mcp/bot/`
- **Use Python for database operations** — SQLite conflicts with JS process

If you're unsure whether a feature fits, open an issue to discuss before submitting a PR.

## Development

```bash
npm install
npm test          # Run tests
node src/server.js # Start MCP server (requires bot running)
```

## Pull Requests

- Keep changes focused — one feature or fix per PR
- Add tests for new functionality where possible
- Ensure `npm test` passes
- Test with a running `pocket-option-bot.js` instance before submitting
- Always validate with `po_simulate` before changing live gate thresholds
