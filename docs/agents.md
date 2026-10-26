# Connect Chrome Bridge to your agent

Chrome Bridge speaks MCP over stdio. Any client that can launch a local command can use it. Point the client at `mcp/server.mjs` in your clone and make sure the bridge server is running.

These snippets assume the clone lives at `~/.chrome-bridge` on macOS or Linux. Use your full path on Windows, for example `C:\\Users\\you\\.chrome-bridge\\mcp\\server.mjs`.

Before connecting an agent, start the bridge and check it:

```bash
node ~/.chrome-bridge/server.mjs
node ~/.chrome-bridge/cli.mjs health
```

`extensionConnected` must be `true`. The agent can also call `chrome_health` to check this itself.

## Qoder

Install the skill, then ask Qoder to use your Chrome:

```bash
npx skills add itsnajam/qoder-chrome-bridge --skill chrome-bridge -a qoder
```

Or add a stdio MCP server in Qoder settings: command `node`, argument `/Users/you/.chrome-bridge/mcp/server.mjs`.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/Users/you/.chrome-bridge/mcp/server.mjs"]
    }
  }
}
```

Restart Claude Desktop. The tools appear under the tools menu in a chat.

## Claude Code

```bash
claude mcp add --scope user chrome-bridge -- node ~/.chrome-bridge/mcp/server.mjs
claude mcp list
```

Use `--scope project` and commit `.mcp.json` if the whole team should share the server. The bridge and token still live on each machine.

## Cursor

Add to `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one project:

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/Users/you/.chrome-bridge/mcp/server.mjs"]
    }
  }
}
```

Open Cursor Settings, MCP, and confirm the server is green.

## VS Code

Create `.vscode/mcp.json` in the workspace, or add the same object to your user settings under `mcp`:

```json
{
  "servers": {
    "chrome-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/you/.chrome-bridge/mcp/server.mjs"]
    }
  }
}
```

Start the server from the MCP panel, then use agent mode with the Chrome tools enabled.

## Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/Users/you/.chrome-bridge/mcp/server.mjs"]
    }
  }
}
```

Refresh MCP servers in Cascade settings.

## Cline

In the Cline panel, open MCP Servers, Installed, Configure MCP Servers. Add:

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/Users/you/.chrome-bridge/mcp/server.mjs"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Keep write tools on manual approval until you trust the workflow.

## Gemini CLI

Edit `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/Users/you/.chrome-bridge/mcp/server.mjs"]
    }
  }
}
```

Run `/mcp` in Gemini CLI to confirm the tools are loaded.

## Codex CLI and IDE extension

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.chrome-bridge]
command = "node"
args = ["/Users/you/.chrome-bridge/mcp/server.mjs"]
```

Then run `codex mcp list` or reload the IDE extension. The Codex desktop app also exposes this under Settings, MCP servers, Add server, with STDIO selected.

## ChatGPT desktop and web

OpenAI's developer mode connectors take a public HTTPS URL. They cannot launch a local process or reach `127.0.0.1`.

Do not put this bridge behind a tunnel to make it reachable. The bridge can drive your logged-in Chrome, so a public URL is a public browser. Use Codex CLI or the Codex IDE extension instead. It runs the same MCP server locally and uses the same OpenAI account.

## Any other MCP client

Use the standard stdio shape:

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/Users/you/.chrome-bridge/mcp/server.mjs"]
    }
  }
}
```

If the client asks for a command and arguments separately, use `node` and the absolute path to `mcp/server.mjs`. There is no URL and no port to configure on the client side.

## Environment variables

The MCP server and CLI read:

| Variable | Default | Purpose |
| --- | --- | --- |
| `QCB_PORT` | `8791` | Bridge port |
| `QCB_TOKEN` | the `token` file | Pairing token |
| `QCB_BRIDGE` | `http://127.0.0.1:<port>` | Full bridge URL |

Set them in the client's `env` block if your setup differs:

```json
{
  "mcpServers": {
    "chrome-bridge": {
      "command": "node",
      "args": ["/Users/you/.chrome-bridge/mcp/server.mjs"],
      "env": {
        "QCB_PORT": "8791"
      }
    }
  }
}
```

## First prompt

Once connected, try:

> Open https://example.com in my Chrome, take a snapshot, and tell me what links are on the page.

The agent should call `chrome_open`, then `chrome_snapshot`, and answer from the snapshot. If it reports that the extension is not connected, open the extension popup and confirm the badge is `on`.
