# Privacy policy: Chrome Bridge for Qoder

Last updated: 26 October 2026

Chrome Bridge for Qoder is a local tool. It has no account, no analytics, no telemetry and no server of its own.

## What it handles

- **The bridge token.** You paste a token into the extension once, and it is stored in `chrome.storage.local` on your computer. It is never sent anywhere except your own bridge at `127.0.0.1`.
- **Page content.** When a local client asks for a snapshot, a screenshot or another action, the extension reads the page you are on and returns the result to the bridge running on your computer. Nothing is sent to the internet.
- **Tab metadata.** Tab titles and URLs are read only to list tabs and to target the tab a command asks for.

## What it does not do

- It does not collect personal data, usage statistics or crash reports.
- It does not send page content, screenshots, credentials or browsing history to the developer or to any third party.
- It does not load or run remote code. All code ships inside the extension package.

## Network access

The extension talks only to `http://127.0.0.1` and `http://localhost`, the loopback address of your own computer. The bridge server binds to `127.0.0.1`, so other machines on your network cannot reach it.

## Permissions and why they are needed

- `tabs`: list and target tabs.
- `scripting`: read the page structure and perform the actions a local client asks for (click, type, scroll, evaluate).
- `storage`: remember the bridge token and port.
- `alarms`: wake the service worker so the connection survives Chrome's idle timeout.
- Host access to all sites: the tool must work on whichever page you are on. It only acts when a command arrives from your local bridge.

## Removing your data

Remove the extension in `chrome://extensions`. That deletes its stored token. You can also delete the `token` file next to `server.mjs`.

## Contact

Muhammad Najam Ul Hassan, https://najam.dev/contact/
