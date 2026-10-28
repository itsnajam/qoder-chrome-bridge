---
name: chrome-bridge
description: Drive the user's own Google Chrome browser through Chrome Bridge. Use when the user asks the agent to open a site, read a page, click, type, scroll, take a screenshot, or run JavaScript in their Chrome, especially on sites where they are already signed in. Covers installing the bridge, starting it, pairing the extension, running commands, and connecting the MCP server. Built by Muhammad Najam Ul Hassan, https://najam.dev.
when_to_use: The user asks to do something in their Chrome browser or on a website that needs their real logged-in session, or asks whether the agent can control Chrome.
---

# Chrome Bridge

Drive the user's real Chrome profile: their logins, cookies, extensions and windows. Chrome Bridge is a local Node server plus a Chrome MV3 extension. The agent talks to the server on 127.0.0.1, either through `cli.mjs` or through `mcp/server.mjs`, the extension acts on a tab, and nothing leaves the machine.

Project: https://github.com/itsnajam/qoder-chrome-bridge
Built by Muhammad Najam Ul Hassan, https://najam.dev.

## 1. Find or install the bridge

Check these locations in order and use the first that contains `server.mjs`:

1. `$CHROME_BRIDGE_DIR`
2. `~/.chrome-bridge`
3. `~/.qoder/chrome-bridge`
4. `./chrome-bridge`

Then check the connection:

```bash
node <dir>/cli.mjs health
```

If `extensionConnected` is true, skip to step 3.

If the bridge is not installed, install it:

```bash
git clone https://github.com/itsnajam/qoder-chrome-bridge.git ~/.chrome-bridge
cd ~/.chrome-bridge && npm install
```

If Node.js 20 or newer is missing, ask the user to install it first.

## 2. Start the bridge and pair the extension

Run the server in the background and keep it running:

```bash
cd ~/.chrome-bridge && node server.mjs
```

Then guide the user through the one-time extension install. Do not ask for their Google password and do not enable Chrome remote debugging.

1. Open `chrome://extensions` in their Chrome.
2. Turn on Developer mode.
3. Click Load unpacked and choose `~/.chrome-bridge/extension`.
4. Print the token with `node ~/.chrome-bridge/server.mjs --token`.
5. Ask the user to open the Chrome Bridge popup and paste that token, then click Save and connect.

Alternatively, if Chrome Bridge is available in the Chrome Web Store, install it there and paste the token in the popup.

Confirm with `node ~/.chrome-bridge/cli.mjs health` and then `ping`. The ping result includes `pong: true`.

If this agent supports MCP, you can use `~/.chrome-bridge/mcp/server.mjs` as a stdio MCP server instead of the CLI. The tools are named `chrome_health`, `chrome_snapshot`, `chrome_click` and so on, and map to the commands below.

## 3. Work in the user's browser

Always take a snapshot before acting, then use the numbered refs:

```bash
node <dir>/cli.mjs snapshot [tabId] [max]
node <dir>/cli.mjs click <ref|selector> [tabId]
node <dir>/cli.mjs mouse <click|move|down|up> <ref|selector> [tabId]
node <dir>/cli.mjs mouse <click|move|down|up> <x> <y> [tabId]
node <dir>/cli.mjs hover <ref|selector> [tabId]
node <dir>/cli.mjs type <ref|selector> <text> [tabId] [--submit]
node <dir>/cli.mjs press <key> [ref] [tabId]
node <dir>/cli.mjs scroll <y> [tabId]
node <dir>/cli.mjs wait <ms>
node <dir>/cli.mjs wait --selector "<css>" [tabId] [timeoutMs]
node <dir>/cli.mjs screenshot [tabId]
node <dir>/cli.mjs eval '<javascript>' [tabId]
node <dir>/cli.mjs open <url> [tabId]
node <dir>/cli.mjs goto <url> [tabId]
node <dir>/cli.mjs activate <tabId>
node <dir>/cli.mjs close <tabId>
node <dir>/cli.mjs tabs
```

- Refs expire on the next snapshot or navigation. Take a fresh snapshot after the page changes.
- `click`, `mouse` and `press` send real input events through the Chrome debugger, so menus bound to `mousedown` and shortcuts that read `keyCode` work. Add `--tab <id>` to aim at a background tab; two numbers after `mouse` are viewport pixels, not a ref and a tab id.
- If a result reports `mode:"synthetic"`, DevTools was open on that tab and the page only saw a plain `el.click()` or a key event with no `keyCode`. Close DevTools and repeat the command.
- `type` fires `input` and `change`, so React and Vue forms see it.
- Prefer `snapshot` over `eval` for reading pages and choosing elements.
- Verify the result after an action: snapshot again, read the changed state, or take a screenshot when visual confirmation matters.

## 4. Safety rules

- This tool can do anything the user can do in Chrome. Treat it that way.
- Confirm before irreversible or visible actions: purchases, deletes, sending messages or email, posting, changing account settings, or submitting forms with real consequences.
- Never print, log or commit the pairing token. It lives in `<dir>/token` and in Chrome extension storage.
- Keep the bridge on 127.0.0.1. Do not expose it through a tunnel, proxy or firewall rule.
- Do not use this to bypass a site's access controls, sign in as someone else, or act without the user's intent.

## 5. Troubleshooting

- **`extension not connected`**: the popup shows `set` (no token) or `!` (bridge unreachable or wrong token). Start the server, paste `node server.mjs --token` into the popup, click Reconnect. If it still fails, reload the extension at `chrome://extensions`.
- **`command timed out`**: check `health`. A 40 second command limit applies; break long work into smaller commands.
- **`element not found`**: take a fresh snapshot.
- **`No tab with id`**: the tab closed or Chrome restarted. Run `tabs` and use a current tab id.
- **`chrome://` pages**: Chrome blocks extensions from scripting its own pages. Use a normal tab.
- **Native dialogs and file uploads** are not supported.
