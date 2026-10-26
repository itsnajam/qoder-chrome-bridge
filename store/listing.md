# Chrome Web Store listing

## How to submit

1. Register a Chrome Web Store developer account at https://chrome.google.com/webstore/devconsole/register (one-time 5 USD fee).
2. Click **New item** and upload `dist/chrome-bridge-1.1.0.zip`.
3. Fill the listing from the sections below.
4. Upload `extension/icons/icon-128.png` and `store/assets/screenshot-1.png`.
5. Add the privacy policy URL and submit for review.

Chrome blocks extensions from scripting `chrome.google.com/webstore`, so these steps must be done by hand in the dashboard.

## Name

Chrome Bridge for Qoder

## Summary (132 characters max)

Let Qoder drive your real Chrome profile through a local, token-protected bridge. Built by Najam at najam.dev.

## Category

Developer Tools

## Language

English (United Kingdom)

## Detailed description

Drive your real Chrome profile from Qoder, with your logins and windows, instead of a clean test profile.

Chrome Bridge for Qoder connects the Qoder desktop app to the Chrome you already use through a small server that runs on your own computer. The agent can open tabs, read a page, click, type, scroll, wait for elements and take screenshots. Sites that need a real session stop asking you to sign in again.

How it works:
1. Run the local bridge (Node.js, included in the project).
2. Load this extension and paste the pairing token from the bridge.
3. Qoder talks to the bridge at 127.0.0.1; the extension acts on the tab you choose.

Privacy:
- No account, no analytics, no telemetry, no remote server.
- Page content and screenshots go only to the bridge on your computer.
- The token stays in Chrome's local extension storage.
- The bridge listens on 127.0.0.1 only and rejects requests without the token.

Setup and source: https://github.com/itsnajam/qoder-chrome-bridge

Built by Muhammad Najam Ul Hassan. Need a website, an app or AI automation? https://najam.dev

Unofficial community tool, not affiliated with Qoder or Google.

## Single purpose

Connect a local automation client to the user's own Chrome browser so it can read and act on pages the user chooses.

## Permission justifications

- **tabs**: list open tabs and target the tab a command names.
- **scripting**: read the page structure and perform the requested action (click, type, scroll, evaluate).
- **storage**: remember the local bridge token and port.
- **alarms**: wake the service worker so the connection survives Chrome's idle timeout.
- **Host permission, all sites**: the client must work on whichever site the user is on. The extension only acts when a command arrives from the local bridge, and no page data leaves the computer.
- **Host permission, 127.0.0.1 and localhost**: talk to the local bridge server.

## Remote code

No. All code ships inside the package. The optional `eval` command evaluates a string in the page the user chose; it is not fetched code.

## Data usage

- Does the item collect personally identifiable information? No.
- Health information? No.
- Financial and payment information? No.
- Authentication information? No.
- Personal communications? No.
- Location? No.
- Web history? No. Tab titles and URLs are read locally to target tabs and are not stored or transmitted.
- User activity? No.
- Website content? Yes, but only locally: page text, page structure and screenshots go to the bridge on the user's own computer. Nothing is sent to the developer or a third party.

Certify: data is not sold, not used for unrelated purposes, and not used to determine creditworthiness.

## Privacy policy URL

https://github.com/itsnajam/qoder-chrome-bridge/blob/main/PRIVACY.md

## Support URL

https://najam.dev/contact/

## Assets

- Store icon: `extension/icons/icon-128.png` (128x128)
- Screenshots: 1280x800 (at least one, up to five)
- Small promo tile: 440x280 (optional)
