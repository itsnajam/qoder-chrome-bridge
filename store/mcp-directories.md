# MCP directory kit

Chrome Bridge is a local stdio MCP server. It cannot be hosted in a cloud directory sandbox, because it drives Chrome on the user's own machine. Directories should link to the source and show a local install command, not a hosted endpoint.

## One-line pitch

Your real Chrome, for any MCP agent. Logins, cookies, extensions and tabs, through a local token-protected bridge.

## Short description

Chrome Bridge lets Qoder, Claude, Cursor, VS Code, Windsurf, Cline, Gemini CLI, Codex or any MCP client drive the user's own Chrome profile. Open tabs, read pages, click, type, scroll, screenshot and run JavaScript in the session they already have. Everything stays on 127.0.0.1 and every request needs a local token.

## Long description

Most browser automation starts a separate, clean Chrome profile. The sites people actually use need their real session, so they ask for a sign-in again and often block automation.

Chrome Bridge runs inside the Chrome the user already has open. A small Node server on 127.0.0.1 queues commands, a Chrome MV3 extension runs them in the chosen tab, and a stdio MCP server exposes 15 tools to any agent.

Tools: `chrome_health`, `chrome_ping`, `chrome_tabs`, `chrome_open`, `chrome_goto`, `chrome_activate`, `chrome_close`, `chrome_snapshot`, `chrome_click`, `chrome_type`, `chrome_press`, `chrome_scroll`, `chrome_wait`, `chrome_screenshot`, `chrome_eval`.

Security model:
- The bridge binds 127.0.0.1 only.
- Every command needs a token created on the user's machine.
- Page data and screenshots go only to that local bridge.
- No analytics, no telemetry, no remote server.

Setup:
1. Clone https://github.com/itsnajam/qoder-chrome-bridge to `~/.chrome-bridge` and run `npm install`.
2. Start the bridge with `node ~/.chrome-bridge/server.mjs`.
3. Load `~/.chrome-bridge/extension` in `chrome://extensions` with Developer mode on.
4. Paste the token from `node ~/.chrome-bridge/server.mjs --token` into the extension popup.
5. Add `node /absolute/path/to/.chrome-bridge/mcp/server.mjs` as a stdio MCP server in the client.

Per-client setup: https://github.com/itsnajam/qoder-chrome-bridge/blob/main/docs/agents.md

Built by Muhammad Najam Ul Hassan. Need a website, an app or AI automation? https://najam.dev

## Metadata

- Name: Chrome Bridge
- Author: Muhammad Najam Ul Hassan
- Website: https://najam.dev
- Source: https://github.com/itsnajam/qoder-chrome-bridge
- License: MIT
- Category: Browser automation, Developer tools
- Tags: chrome, browser, automation, mcp, local, playwright-alternative, real-profile
- Transport: stdio
- Runtime: Node.js 20 or newer
- Authentication: local token, no OAuth

## Official MCP Registry

The official registry verifies an npm package. Publishing needs an npm account, so this step waits on that.

Add this to `package.json` before publishing:

```json
{
  "mcpName": "io.github.itsnajam/chrome-bridge",
  "private": false,
  "bin": {
    "chrome-bridge-agent": "mcp/server.mjs"
  }
}
```

Then publish the package and a root `server.json`:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.itsnajam/chrome-bridge",
  "description": "Drive the user's real Chrome profile from any MCP agent through a local, token-protected bridge.",
  "version": "1.2.0",
  "repository": {
    "url": "https://github.com/itsnajam/qoder-chrome-bridge",
    "source": "github"
  },
  "packages": [
    {
      "registryType": "npm",
      "identifier": "chrome-bridge-agent",
      "version": "1.2.0",
      "transport": { "type": "stdio" }
    }
  ]
}
```

Submit with the official publisher after `npm publish`:

```bash
brew install mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

Do not publish until the MCP server can find a stable token for npm installs. Today the token lives next to `server.mjs` in the clone, so the documented clone install is the supported path.

## Glama

Glama indexes public MCP repositories and builds a server page with tools, environment variables and install snippets.

1. Sign in with the `itsnajam` GitHub account at https://glama.ai.
2. Submit https://github.com/itsnajam/qoder-chrome-bridge.
3. Use the short description and metadata above.
4. Mark the server as local stdio only. Do not offer a hosted endpoint.

## mcp.so

1. Sign in at https://mcp.so.
2. Submit the repository URL.
3. Paste the short description, tags and install steps.
4. Link the README and docs/agents.md.

## PulseMCP

PulseMCP indexes the official registry and accepts community submissions at https://www.pulsemcp.com/submit. Submit after the official registry listing exists.

## What not to do

- Do not list Chrome Bridge on a directory that only hosts remote servers. The bridge cannot run in a cloud sandbox.
- Do not offer a public tunnel as a hosted endpoint. That would let anyone who finds the URL drive the user's logged-in browser.
- Do not claim ChatGPT desktop or web support through its connector UI. OpenAI's connectors need a public HTTPS URL. ChatGPT users can use Codex CLI or the Codex IDE extension instead.

## Account requirements

- npm account with the package name `chrome-bridge-agent` (checked available on 26 October 2026): official registry.
- GitHub account `itsnajam`: Glama, mcp.so.
- No payment is required for the MCP directories.
