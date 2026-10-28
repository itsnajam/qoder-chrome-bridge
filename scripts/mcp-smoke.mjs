import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(path.dirname(here), "mcp", "server.mjs");

const PAGE = `<!doctype html>
<html><head><title>Chrome Bridge smoke test</title></head>
<body style="font-family:system-ui;padding:40px">
  <h1>Chrome Bridge smoke test</h1>
  <input id="name" placeholder="Your name">
  <button id="go" onclick="document.getElementById('out').textContent='clicked ' + document.getElementById('name').value">Go</button>
  <p id="out">not clicked</p>
  <div id="pad" style="width:180px;height:44px;line-height:44px;text-align:center;background:#dbeafe;border-radius:8px;user-select:none">press me</div>
  <p id="padout">no pointerdown seen</p>
  <p id="keyout">no hash keydown seen</p>
  <div style="height:2000px"></div>
  <p id="late">late content</p>
  <script>
    setTimeout(() => document.getElementById('late').setAttribute('data-ready', '1'), 600);
    document.getElementById('pad').addEventListener('pointerdown', () => {
      document.getElementById('padout').textContent = 'pointerdown seen';
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '#') document.getElementById('keyout').textContent = 'hash keydown, keyCode ' + e.keyCode;
    });
  </script>
</body></html>`;

const site = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${site.address().port}/`;

const transport = new StdioClientTransport({ command: process.execPath, args: [server] });
const client = new Client({ name: "chrome-bridge-smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

let failures = 0;
async function call(name, args = {}, soft = false) {
  const out = await client.callTool({ name, arguments: args });
  const text = out.content.find((c) => c.type === "text")?.text || "";
  const image = out.content.find((c) => c.type === "image");
  console.log(`\n${name}${out.isError ? " [error]" : ""}: ${text.slice(0, 300)}${text.length > 300 ? "..." : ""}`);
  if (image) console.log(`${name}: image ${image.mimeType}, ${Math.round((image.data.length * 3) / 4 / 1024)} KB`);
  if (out.isError && !soft) failures += 1;
  return out;
}

const parse = (out) => JSON.parse(out.content.find((c) => c.type === "text").text);

await call("chrome_health");
await call("chrome_ping");
await call("chrome_tabs");

const opened = await call("chrome_open", { url: pageUrl.replace(/^http:/, "http:") });
const tabId = parse(opened).tab?.id;
if (!tabId) throw new Error("open did not return a tab id");

try {
  const snap = await call("chrome_snapshot", { tabId });
  const buttonRef = parse(snap).elements.find((e) => e.startsWith("[") && e.includes("<button"))?.match(/^\[(\d+)\]/)?.[1];
  await call("chrome_type", { tabId, selector: "#name", text: "Najam" });
  const clicked = await call("chrome_click", { tabId, selector: "#go" });
  await call("chrome_eval", { tabId, code: "document.getElementById('out').textContent" });
  await call("chrome_wait", { tabId, selector: "#late[data-ready='1']", timeout: 5000 });
  await call("chrome_scroll", { tabId, y: 400 });
  const hovered = await call("chrome_mouse", { tabId, action: "move", selector: "#name" }, true);
  if (buttonRef) await call("chrome_click", { tabId, ref: Number(buttonRef) });
  const padClicked = await call("chrome_click", { tabId, selector: "#pad" });
  const pressed = await call("chrome_press", { tabId, key: "#" });
  const seen = parse(
    await call("chrome_eval", { tabId, code: "document.getElementById('padout').textContent + ' | ' + document.getElementById('keyout').textContent" }),
  ).value;
  await call("chrome_screenshot", { tabId });

  const trusted = [parse(clicked).mode, parse(hovered).mode, parse(padClicked).mode, parse(pressed).mode].filter((m) => m === "trusted").length;
  console.log(`\nTrusted input: ${trusted}/4 events went through the debugger.`);
  console.log(`Page saw: ${seen}`);
  if (!trusted) {
    console.log("Chrome refused the debugger attach, usually because DevTools is open on this tab, so the page only saw synthetic events.");
  } else if (!seen.includes("pointerdown seen") || !seen.includes("hash keydown")) {
    failures += 1;
    console.log("A trusted event never reached the page's pointerdown or keydown listener.");
  }
} finally {
  await call("chrome_close", { tabId });
  await client.close();
  site.close();
}

console.log(failures ? `\nSmoke test failed: ${failures} error result(s)` : "\nSmoke test passed");
if (failures) process.exit(1);
