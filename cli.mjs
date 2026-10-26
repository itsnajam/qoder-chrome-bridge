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
  node cli.mjs type <ref|selector> <text> [tabId] [--submit]
  node cli.mjs press <key> [ref] [tabId]
  node cli.mjs scroll <y> [tabId]
  node cli.mjs wait <ms>
  node cli.mjs wait --selector "<css>" [tabId] [timeoutMs]
  node cli.mjs screenshot [tabId]
  node cli.mjs eval '<javascript>' [tabId]
  node cli.mjs '{"cmd":"snapshot","tabId":123}'

Set QCB_PORT (and QCB_TOKEN) if the bridge is not on 8791.`;

function parse() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "help" || args[0] === "--help") {
    console.log(usage);
    process.exit(0);
  }
  if (args[0].trim().startsWith("{")) return JSON.parse(args[0]);

  const [cmd, ...rest] = args;
  const isRefOrSelector = (value) => (/^\d+$/.test(value) ? { ref: Number(value) } : { selector: value });

  switch (cmd) {
    case "health":
      return { cmd };
    case "ping":
    case "tabs":
      return { cmd: cmd === "ping" ? "ping" : "tabs" };
    case "open":
    case "goto":
      return { cmd, url: rest[0], tabId: rest[1] ? Number(rest[1]) : undefined };
    case "activate":
    case "close":
      return { cmd, tabId: Number(rest[0]) };
    case "snapshot":
      return { cmd, tabId: rest[0] ? Number(rest[0]) : undefined, max: rest[1] ? Number(rest[1]) : undefined };
    case "click":
      return { cmd, ...isRefOrSelector(rest[0]), tabId: rest[1] ? Number(rest[1]) : undefined };
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
        tabId: rest[2] ? Number(rest[2]) : undefined,
      };
    case "scroll":
      return { cmd, y: Number(rest[0] || 600), tabId: rest[1] ? Number(rest[1]) : undefined };
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
      return { cmd, tabId: rest[0] ? Number(rest[0]) : undefined };
    case "eval":
      return { cmd, code: rest[0], tabId: rest[1] ? Number(rest[1]) : undefined };
    default:
      throw new Error(`unknown command: ${cmd}\n\n${usage}`);
  }
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
