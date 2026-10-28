import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokenFile = path.join(here, "token");
let TOKEN = (process.env.QCB_TOKEN || "").trim();
if (!TOKEN) {
  try {
    TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    console.error(`No token found. Start the bridge once (node ${path.join(here, "server.mjs")}) to create ${tokenFile}, or set QCB_TOKEN.`);
    process.exit(4);
  }
}
const PORT = Number(process.env.QCB_PORT || 8791);
const BRIDGE = `http://127.0.0.1:${PORT}`;

const usage = `Chrome Bridge CLI

  node cli.mjs health
  node cli.mjs ping
  node cli.mjs tabs
  node cli.mjs open <url> [tabId]
  node cli.mjs goto <url> [tabId]
  node cli.mjs activate <tabId>
  node cli.mjs close <tabId>
  node cli.mjs snapshot [tabId] [max]
  node cli.mjs click <ref|selector> [tabId]
  node cli.mjs mouse <click|move|down|up> <ref|selector> [tabId]
  node cli.mjs mouse <click|move|down|up> <x> <y> [tabId]
  node cli.mjs hover <ref|selector> [tabId]
  node cli.mjs type <ref|selector> <text> [tabId] [--submit]
  node cli.mjs press <key> [ref] [tabId]
  node cli.mjs scroll <y> [tabId]
  node cli.mjs wait <ms>
  node cli.mjs wait --selector "<css>" [tabId] [timeoutMs]
  node cli.mjs screenshot [tabId]
  node cli.mjs eval '<javascript>' [tabId]
  node cli.mjs '{"cmd":"snapshot","tabId":123}'

click, mouse and press send real input events through the debugger, so widgets
built on mousedown or keyCode respond. They report mode:"synthetic" plus a
warning when DevTools is open on that tab and the debugger cannot attach.
Keys are Enter, Escape, Tab, Backspace, Delete, Space, arrows, Home, End,
PageUp, PageDown, F1-F12, a single character, or a symbol such as # or ?.
Two numbers after mouse are viewport pixels; use --tab when you mean a ref and
a tab id. Append --tab <id> to any page command to aim at a background tab.

Set QCB_PORT (and QCB_TOKEN) if the bridge is not on 8791.`;

const MOUSE_ACTIONS = ["click", "move", "down", "up"];

function command([cmd, ...rest]) {
  const isRefOrSelector = (value) => (/^\d+$/.test(value) ? { ref: Number(value) } : { selector: value });
  const tabAt = (value) => (value ? Number(value) : undefined);

  switch (cmd) {
    case "health":
      return { cmd };
    case "ping":
    case "tabs":
      return { cmd: cmd === "ping" ? "ping" : "tabs" };
    case "open":
    case "goto":
      return { cmd, url: rest[0], tabId: tabAt(rest[1]) };
    case "activate":
    case "close":
      return { cmd, tabId: Number(rest[0]) };
    case "snapshot":
      return { cmd, tabId: tabAt(rest[0]), max: rest[1] ? Number(rest[1]) : undefined };
    case "click":
      return { cmd, ...isRefOrSelector(rest[0]), tabId: tabAt(rest[1]) };
    case "mouse": {
      const action = rest[0];
      if (!MOUSE_ACTIONS.includes(action)) {
        throw new Error(`mouse needs ${MOUSE_ACTIONS.join("|")}\n\n${usage}`);
      }
      const coords = /^-?\d+$/.test(rest[1] ?? "") && /^-?\d+$/.test(rest[2] ?? "");
      return coords
        ? { cmd, action, x: Number(rest[1]), y: Number(rest[2]), tabId: tabAt(rest[3]) }
        : { cmd, action, ...isRefOrSelector(rest[1]), tabId: tabAt(rest[2]) };
    }
    case "hover":
      return { cmd: "mouse", action: "move", ...isRefOrSelector(rest[0]), tabId: tabAt(rest[1]) };
    case "type":
      return {
        cmd,
        ...isRefOrSelector(rest[0]),
        text: rest[1] ?? "",
        tabId: rest[2] && !rest[2].startsWith("--") ? Number(rest[2]) : undefined,
        submit: rest.includes("--submit"),
      };
    case "press":
      return {
        cmd,
        key: rest[0] || "Enter",
        ...(rest[1] && /^\d+$/.test(rest[1]) ? { ref: Number(rest[1]) } : {}),
        ...(rest[1] && !/^\d+$/.test(rest[1]) ? { selector: rest[1] } : {}),
        tabId: tabAt(rest[2]),
      };
    case "scroll":
      return { cmd, y: Number(rest[0] || 600), tabId: tabAt(rest[1]) };
    case "wait":
      if (rest[0] === "--selector") {
        if (!rest[1]) throw new Error(`wait --selector needs a CSS selector\n\n${usage}`);
        return {
          cmd,
          selector: rest[1],
          tabId: rest[2] && /^\d+$/.test(rest[2]) ? Number(rest[2]) : undefined,
          timeout: rest[3] && /^\d+$/.test(rest[3]) ? Number(rest[3]) : undefined,
        };
      }
      return { cmd, ms: Number(rest[0] || 1000) };
    case "screenshot":
      return { cmd, tabId: tabAt(rest[0]) };
    case "eval":
      return { cmd, code: rest[0], tabId: tabAt(rest[1]) };
    default:
      throw new Error(`unknown command: ${cmd}\n\n${usage}`);
  }
}

function parse() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "help" || args[0] === "--help") {
    console.log(usage);
    process.exit(0);
  }
  if (args[0].trim().startsWith("{")) return JSON.parse(args[0]);

  const flagIndex = args.indexOf("--tab");
  let explicitTab;
  if (flagIndex >= 0) {
    explicitTab = Number(args[flagIndex + 1]);
    if (!Number.isInteger(explicitTab)) throw new Error(`--tab needs a tab id\n\n${usage}`);
    args.splice(flagIndex, 2);
  }
  const payload = command(args);
  if (explicitTab !== undefined) payload.tabId = explicitTab;
  return payload;
}

async function main() {
  let payload;
  try {
    payload = parse();
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(2);
  }

  if (payload.cmd === "health") {
    try {
      const res = await fetch(`${BRIDGE}/health`);
      console.log(JSON.stringify(await res.json(), null, 2));
    } catch {
      console.error(`Bridge unreachable at ${BRIDGE}. Start it with: node ${path.join(here, "server.mjs")}`);
      process.exit(4);
    }
    return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  let res;
  try {
    res = await fetch(`${BRIDGE}/command?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    console.error(`Bridge unreachable at ${BRIDGE}. Start it with: node ${path.join(here, "server.mjs")}`);
    process.exit(4);
  }
  clearTimeout(timer);

  const body = await res.json().catch(() => ({ ok: false, error: "invalid response" }));
  if (body.dataUrl) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(here, "shots", `shot-${stamp}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(body.dataUrl.split(",")[1], "base64"));
    const { dataUrl, ...rest } = body;
    console.log(JSON.stringify({ ...rest, screenshot: file }, null, 2));
    return;
  }
  console.log(JSON.stringify(body, null, 2));
  if (body.ok === false) process.exit(1);
}

main();
