#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const tokenFile = path.join(root, "token");
const BRIDGE = (process.env.QCB_BRIDGE || `http://127.0.0.1:${Number(process.env.QCB_PORT || 8791)}`).replace(/\/$/, "");
const TIMEOUT_MS = 45_000;

function loadToken() {
  const fromEnv = (process.env.QCB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

const TOKEN = loadToken();

const NOT_RUNNING = [
  `Chrome Bridge is not reachable at ${BRIDGE}.`,
  "Start it with `npm start` (or `node server.mjs`) in the Chrome Bridge folder.",
  "Then open Chrome with the Chrome Bridge extension loaded and paired. Ask the user before installing anything.",
].join(" ");

function withScheme(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

async function callBridge(payload) {
  if (!TOKEN) {
    return {
      ok: false,
      error: `No bridge token found at ${tokenFile} and QCB_TOKEN is not set.`,
      hint: "Start the bridge once with `npm start`; it creates the token file. Paste that token into the Chrome Bridge extension popup.",
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BRIDGE}/command?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch {
    return { ok: false, error: NOT_RUNNING };
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({ ok: false, error: `invalid response from bridge (${res.status})` }));
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error: "The bridge rejected the token.",
      hint: "The extension and server tokens do not match. Run `npm run token`, paste it into the extension popup, and retry.",
    };
  }
  return body;
}

function result(body) {
  const { dataUrl, ...rest } = body || {};
  const content = [{ type: "text", text: JSON.stringify(rest, null, 2) }];
  return { content, isError: rest.ok === false };
}

function screenshotResult(body) {
  if (!body?.dataUrl) return result(body);
  const { dataUrl, ...rest } = body;
  return {
    content: [
      { type: "image", data: dataUrl.split(",")[1], mimeType: "image/png" },
      { type: "text", text: JSON.stringify(rest, null, 2) },
    ],
    isError: false,
  };
}

const server = new McpServer(
  { name: "chrome-bridge", version: "1.3.0" },
  {
    instructions: [
      "Chrome Bridge drives the user's real Google Chrome through a local, token-protected bridge and an extension the user installs.",
      "Workflow: call chrome_tabs or chrome_snapshot to see the page, then act with refs from the latest snapshot (refs are invalidated when the page changes).",
      "Call chrome_snapshot again after navigation, clicks that change the page, or form submissions.",
      "chrome_click, chrome_press and chrome_mouse send trusted input through the Chrome debugger. If a result reports mode:synthetic, DevTools is open on that tab and the page only saw a plain click or a keyCode-less key event.",
      "Screenshots need the tab to be visible; chrome_screenshot activates the tab first.",
      "Never enter passwords, payment details, or one-time codes unless the user explicitly asks you to do it in this session.",
      "If chrome_health reports extensionConnected false, explain that the bridge server and the Chrome extension must both be running and paired.",
      "Built by Muhammad Najam Ul Hassan, https://najam.dev.",
    ].join(" "),
  },
);

server.registerTool(
  "chrome_health",
  {
    title: "Chrome Bridge health",
    description:
      "Check whether the local bridge server is running and whether the Chrome extension is connected. Call this before other tools when unsure.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    try {
      const res = await fetch(`${BRIDGE}/health`, { signal: ctrl.signal });
      const body = await res.json().catch(() => null);
      if (!body) return { content: [{ type: "text", text: `Bridge responded with status ${res.status}.` }], isError: true };
      if (!body.extensionConnected) {
        body.hint = "The server is up but the extension is not polling. Open Chrome, make sure the Chrome Bridge extension is enabled, and check its popup for the token and connection status.";
      }
      return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: false };
    } catch {
      return { content: [{ type: "text", text: NOT_RUNNING }], isError: true };
    } finally {
      clearTimeout(timer);
    }
  },
);

server.registerTool(
  "chrome_ping",
  {
    title: "Ping Chrome",
    description: "Round-trip through the bridge and extension. Returns the extension id and how many tabs are open.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => result(await callBridge({ cmd: "ping" })),
);

server.registerTool(
  "chrome_tabs",
  {
    title: "List Chrome tabs",
    description: "List every open tab with its id, window id, title, and URL. Use tab ids with the other tools.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => result(await callBridge({ cmd: "tabs" })),
);

server.registerTool(
  "chrome_open",
  {
    title: "Open a URL in a new tab",
    description: "Open a URL in a new Chrome tab and wait for it to load. Returns the new tab id.",
    inputSchema: {
      url: z.string().min(1).describe("URL to open. A missing scheme defaults to https://."),
      active: z.boolean().optional().describe("Focus the new tab. Defaults to true."),
      timeout: z.number().int().positive().optional().describe("Load timeout in milliseconds, max 30000."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ url, active, timeout }) =>
    result(await callBridge({ cmd: "open", url: withScheme(url), active, timeout })),
);

server.registerTool(
  "chrome_goto",
  {
    title: "Navigate a tab",
    description: "Navigate an existing tab to a URL and wait for it to load. Defaults to the active tab.",
    inputSchema: {
      url: z.string().min(1).describe("URL to navigate to. A missing scheme defaults to https://."),
      tabId: z.number().int().optional().describe("Tab id. Defaults to the active tab."),
      timeout: z.number().int().positive().optional().describe("Load timeout in milliseconds, max 30000."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ url, tabId, timeout }) =>
    result(await callBridge({ cmd: "goto", url: withScheme(url), tabId, timeout })),
);

server.registerTool(
  "chrome_activate",
  {
    title: "Focus a tab",
    description: "Bring a tab to the front and focus its window. Required before a screenshot of that tab.",
    inputSchema: {
      tabId: z.number().int().describe("Tab id from chrome_tabs."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ tabId }) => result(await callBridge({ cmd: "activate", tabId })),
);

server.registerTool(
  "chrome_close",
  {
    title: "Close a tab",
    description: "Close a tab. Only close tabs you opened unless the user asks otherwise.",
    inputSchema: {
      tabId: z.number().int().describe("Tab id from chrome_tabs."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ tabId }) => result(await callBridge({ cmd: "close", tabId })),
);

server.registerTool(
  "chrome_snapshot",
  {
    title: "Snapshot the page",
    description:
      "Return the page URL, title, visible text, and a numbered list of interactive elements (links, buttons, inputs). Pass those numbers as ref to chrome_click, chrome_type, and chrome_press. Refs are only valid for this snapshot.",
    inputSchema: {
      tabId: z.number().int().optional().describe("Tab id. Defaults to the active tab."),
      max: z.number().int().min(1).max(1000).optional().describe("Maximum elements to return. Defaults to 250."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ tabId, max }) => result(await callBridge({ cmd: "snapshot", tabId, max })),
);

server.registerTool(
  "chrome_click",
  {
    title: "Click an element",
    description:
      'Send a real mouse click to an element by snapshot ref or CSS selector, through the Chrome debugger, so menus and widgets bound to mousedown or pointerdown respond. Reports mode:"synthetic" with a warning if DevTools is open on the tab and only plain click handlers ran. Snapshot again afterwards if the page changes.',
    inputSchema: {
      ref: z.number().int().optional().describe("Element number from the latest chrome_snapshot."),
      selector: z.string().optional().describe("CSS selector, used instead of ref."),
      tabId: z.number().int().optional().describe("Tab id. Defaults to the active tab."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ ref, selector, tabId }) => result(await callBridge({ cmd: "click", ref, selector, tabId })),
);

server.registerTool(
  "chrome_mouse",
  {
    title: "Real mouse input",
    description:
      "Send trusted mouse events at raw viewport coordinates or at a snapshot ref / CSS selector. Use action move to hover open menus, down and up to hold a control, and click for a normal press and release.",
    inputSchema: {
      action: z.enum(["click", "move", "down", "up"]).describe("Mouse event to send."),
      x: z.number().int().optional().describe("Viewport x in CSS pixels. Needs y. Ignored when ref or selector is given."),
      y: z.number().int().optional().describe("Viewport y in CSS pixels."),
      ref: z.number().int().optional().describe("Element number from the latest chrome_snapshot; the click lands on its centre."),
      selector: z.string().optional().describe("CSS selector used instead of ref."),
      tabId: z.number().int().optional().describe("Tab id. Defaults to the active tab."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ action, x, y, ref, selector, tabId }) =>
    result(await callBridge({ cmd: "mouse", action, x, y, ref, selector, tabId })),
);

server.registerTool(
  "chrome_type",
  {
    title: "Type into a field",
    description:
      "Set the value of an input, textarea, or contenteditable element, then fire input and change events. Use submit to submit the surrounding form.",
    inputSchema: {
      text: z.string().describe("Text to enter."),
      ref: z.number().int().optional().describe("Element number from the latest chrome_snapshot."),
      selector: z.string().optional().describe("CSS selector, used instead of ref."),
      submit: z.boolean().optional().describe("Submit the closest form after typing."),
      tabId: z.number().int().optional().describe("Tab id. Defaults to the active tab."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ text, ref, selector, submit, tabId }) =>
    result(await callBridge({ cmd: "type", ref, selector, text, submit, tabId })),
);

server.registerTool(
  "chrome_press",
  {
    title: "Press a key",
    description:
      "Send a real key down and up through the Chrome debugger, with the virtual key code the page expects, so keyboard shortcuts such as Gmail's # work. Give a ref or selector to focus that element first, or omit both for the focused element. Enter also submits the closest form. Reports mode:\"synthetic\" if the debugger could not attach.",
    inputSchema: {
      key: z
        .string()
        .min(1)
        .describe("Key name: Enter, Escape, Tab, Backspace, Delete, Space, ArrowUp, Home, PageDown, F5, or a single character such as a, 7 or #."),
      ref: z.number().int().optional().describe("Element number from the latest chrome_snapshot."),
      selector: z.string().optional().describe("CSS selector, used instead of ref."),
      tabId: z.number().int().optional().describe("Tab id. Defaults to the active tab."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ key, ref, selector, tabId }) =>
    result(await callBridge({ cmd: "press", key, ref, selector, tabId })),
);

server.registerTool(
  "chrome_scroll",
  {
    title: "Scroll the page",
    description: "Scroll the page vertically by a number of pixels, or scroll an element into view by ref.",
    inputSchema: {
      y: z.number().int().optional().describe("Pixels to scroll. Positive scrolls down. Defaults to 600."),
      ref: z.number().int().optional().describe("Optional element number to scroll into view."),
      tabId: z.number().int().optional().describe("Tab id. Defaults to the active tab."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ y, ref, tabId }) => result(await callBridge({ cmd: "scroll", y, ref, tabId })),
);

server.registerTool(
  "chrome_wait",
  {
    title: "Wait",
    description:
      "Wait a number of milliseconds, or wait until a CSS selector appears. Use this after actions that load content asynchronously.",
    inputSchema: {
      ms: z.number().int().min(0).optional().describe("Milliseconds to wait. Defaults to 1000."),
      selector: z.string().optional().describe("Wait until this CSS selector matches an element."),
      timeout: z.number().int().positive().optional().describe("Selector wait timeout in milliseconds. Defaults to 15000, max 30000."),
      tabId: z.number().int().optional().describe("Tab id. Defaults to the active tab."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ ms, selector, timeout, tabId }) =>
    result(await callBridge({ cmd: "wait", ms, selector, timeout, tabId })),
);

server.registerTool(
  "chrome_screenshot",
  {
    title: "Screenshot the visible tab",
    description:
      "Capture the visible area of a tab as a PNG and return it as an image. Activates and focuses the tab first, so the user will see it.",
    inputSchema: {
      tabId: z.number().int().optional().describe("Tab id. Defaults to the active tab."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ tabId }) => screenshotResult(await callBridge({ cmd: "screenshot", tabId })),
);

server.registerTool(
  "chrome_eval",
  {
    title: "Run JavaScript in the page",
    description:
      "Evaluate a JavaScript expression in the page's main world and return the JSON-serialized result. Use for reading data the snapshot does not expose. Do not use it to bypass login, payment, or consent flows.",
    inputSchema: {
      code: z.string().min(1).describe("JavaScript expression to evaluate."),
      tabId: z.number().int().optional().describe("Tab id. Defaults to the active tab."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ code, tabId }) => result(await callBridge({ cmd: "eval", code, tabId })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Chrome Bridge MCP server ready (bridge: ${BRIDGE}, token: ${TOKEN ? "loaded" : "missing"})`);
