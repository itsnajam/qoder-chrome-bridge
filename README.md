# Chrome Bridge for Qoder

Drive your **real Chrome profile** from Qoder: your logins, your extensions, your windows, in the Chrome you already use. A tiny local bridge connects Qoder to a Chrome extension, so the agent can open tabs, read a page, click, type and take screenshots, the same way you would.

Built by **Muhammad Najam Ul Hassan**.

> **Need a website, an app or AI automation?** I build them for founders and small teams.
> Tell me what you need at **[najam.dev](https://najam.dev)**.

![Chrome Bridge for Qoder](store/assets/screenshot-1.png)

Unofficial community tool. Not affiliated with or endorsed by Qoder or Google.

## Why

The Qoder desktop app ships with Chrome DevTools MCP, which launches a separate, clean Chrome profile. That profile has none of your logins, so sites that need a real session (Cloudflare, Vercel, GitHub, a client dashboard) ask you to sign in again and often block automation.

This bridge runs inside the Chrome you already use. You keep your session; the agent gets a way in.

```
Qoder (shell)  ->  cli.mjs  ->  http://127.0.0.1:8791  ->  Chrome extension  ->  your tab
```

- `server.mjs`: a localhost-only HTTP bridge with a command queue and long polling. Binds `127.0.0.1`, and every request needs the pairing token.
- `extension/`: a Manifest V3 extension. It polls the bridge, runs the command and posts the result back.
- `cli.mjs`: the command line Qoder runs.
- `token`: the shared secret, created on first run (`chmod 600`) and kept out of git and the packaged extension.

## Requirements

- Google Chrome 116 or newer (any platform)
- Node.js 20 or newer

## Install

1. **Clone and start the bridge**

   ```bash
   git clone https://github.com/itsnajam/qoder-chrome-bridge.git
   cd qoder-chrome-bridge
   node server.mjs
   ```

   On first run the server creates `token` and prints where it is. Keep the server running while you want Qoder to drive Chrome.

2. **Load the extension**

   - Open `chrome://extensions`
   - Turn on **Developer mode**
   - Click **Load unpacked** and pick the `extension/` folder
   - Pin **Chrome Bridge for Qoder** to the toolbar

3. **Pair it**

   ```bash
   node server.mjs --token
   ```

   Copy that token, open the extension popup, paste it, and click **Save and connect**. The badge turns to `on` when it is connected.

4. **Check the connection**

   ```bash
   node cli.mjs ping
   node cli.mjs tabs
   ```

   `ping` should return `"pong": true` and the number of open tabs.

## Use it from Qoder

The repo ships a Qoder skill that tells the agent when to use Chrome and how to install it. Install it once:

```bash
npx skills add itsnajam/qoder-chrome-bridge --skill chrome-bridge -a qoder
```

Then ask Qoder something like "Can you open this site in my Chrome and fill the form?" Qoder will check the bridge, help you load the extension, and run the commands.

## Commands

```bash
node cli.mjs health                            # bridge and connection state
node cli.mjs ping
node cli.mjs tabs
node cli.mjs open <url> [tabId]                # new tab
node cli.mjs goto <url> [tabId]
node cli.mjs activate <tabId>
node cli.mjs close <tabId>
node cli.mjs snapshot [tabId] [max]            # numbered, visible elements plus page text
node cli.mjs click <ref|selector> [tabId]
node cli.mjs type <ref|selector> <text> [tabId] [--submit]
node cli.mjs press <key> [ref] [tabId]
node cli.mjs scroll <y> [tabId]
node cli.mjs wait <ms>
node cli.mjs wait --selector "<css>" [tabId] [timeoutMs]
node cli.mjs screenshot [tabId]                # saved under shots/
node cli.mjs eval '<javascript>' [tabId]       # runs in the page's main world
node cli.mjs '{"cmd":"snapshot","tabId":123}'  # raw command
```

- `snapshot` numbers the elements it can see and writes `data-qcb-ref` on them. Refs stay valid until the next snapshot or navigation.
- `type` sets the field value and fires `input` and `change`, so React and Vue forms see it. Add `--submit` to submit the surrounding form.
- `press Enter` also submits the field's form, since synthetic key events do not trigger native submission.
- `screenshot` captures the visible viewport as a PNG.

Set `QCB_PORT` (default `8791`) and `QCB_TOKEN` (default: the `token` file) if your setup differs.

## Security model

This tool can do anything you can do in Chrome. Treat it accordingly.

- The bridge listens on `127.0.0.1` only. Nothing on your network can reach it.
- Every request carries the token. The server rejects requests without it, and cross-origin requests from web pages are refused.
- The token is created locally and never leaves your machine. It is not in the extension package.
- The extension has host access to all sites because it must work on whichever page you are on. It only acts when a command arrives from your local bridge.
- Only run the server while you need it. To revoke access, stop the server, remove the extension, or rotate the token.

Do not expose port `8791` through a tunnel, reverse proxy or firewall rule.

## Troubleshooting

- **Badge shows `set`:** the extension has no token. Open the popup and paste the one from `node server.mjs --token`.
- **Badge shows `!`:** the bridge is not reachable or the token is wrong. Check that `node server.mjs` is running, then click **Reconnect**.
- **`extension not connected`:** Chrome has suspended the service worker, or the extension needs reloading after an update. Click **Reconnect** in the popup, or reload the extension in `chrome://extensions`.
- **`element not found`:** take a fresh snapshot. Refs expire on navigation.
- **`chrome://` pages:** Chrome blocks extensions from scripting its own pages. Use a normal page.

## Limitations

- No `chrome://` pages, cross-origin iframes, or shadow DOM inside shadow DOM.
- Screenshots capture the visible viewport, not the full page.
- File uploads and native dialogs are not supported yet.
- Commands run one at a time, up to 40 seconds each.
- The extension does not load or run remote code.

## Privacy

See [PRIVACY.md](PRIVACY.md). No analytics, no telemetry, no remote server. Page data goes only to the bridge on your own computer.

## License

[MIT](LICENSE). Copyright (c) 2026 Muhammad Najam Ul Hassan.

## Credit

Built by [Muhammad Najam Ul Hassan](https://najam.dev). If this saves you time, the best thank-you is to send interesting work my way: [najam.dev](https://najam.dev).
