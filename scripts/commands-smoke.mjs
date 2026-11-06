// Live check of the four commands that need a real browser: batch, window,
// upload and visible. It drives cli.mjs the way an agent does, against a local
// page whose popover only mounts when Chrome is actually painting the tab.
//
// Every call is awaited rather than spawned synchronously: the test page is
// served by this same process, so a blocking spawn would freeze the server that
// the browser is waiting on and the page would never load.
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run3 = promisify(execFile);
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(here, "cli.mjs");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "qcb-upload-"));
const uploadFile = path.join(uploadDir, "sample.png");
fs.writeFileSync(uploadFile, PNG);

// The popover is the point of the whole test: it waits for a frame before it
// measures itself, exactly like a React select portal, so it never appears in a
// tab Chrome has stopped painting.
const PAGE = `<!doctype html>
<html><head><title>Chrome Bridge command check</title></head>
<body style="font-family:system-ui;padding:40px">
  <h1>Chrome Bridge command check</h1>
  <p id="vis">unknown</p>
  <input id="file" type="file" style="display:none">
  <p id="fileout">no file set</p>
  <div id="popover"></div>
  <script>
    document.getElementById('vis').textContent = document.visibilityState;
    document.getElementById('file').addEventListener('change', function (e) {
      var f = e.target.files[0];
      document.getElementById('fileout').textContent = f ? f.name + ':' + f.size : 'empty change';
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var box = document.createElement('div');
        box.id = 'popover-box';
        box.textContent = 'popover mounted at ' + Math.round(window.innerWidth);
        document.getElementById('popover').appendChild(box);
      });
    });
  </script>
</body></html>`;

const site = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${site.address().port}/`;

let failures = 0;
async function run(...args) {
  let out;
  try {
    out = await run3(process.execPath, [cli, ...args], { maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    out = { stdout: e.stdout || "", stderr: e.stderr || "" };
  }
  try {
    return JSON.parse(out.stdout);
  } catch {
    return { ok: false, error: `cli gave no JSON: ${String(out.stdout || out.stderr).slice(0, 200)}` };
  }
}
const check = (name, pass, detail) => {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const health = await run("health");
if (!health.extensionConnected) {
  console.error("The extension is not connected. Start Chrome with Chrome Bridge loaded and paired, then rerun.");
  site.close();
  process.exit(1);
}

// 1. batch: ordered steps, every result back, and a stop at the first failure.
const good = await run("batch", JSON.stringify([
  { cmd: "open", url: pageUrl },
  { cmd: "wait", selector: "#file", timeout: 20_000 },
  { cmd: "eval", code: "1+1" },
  { cmd: "eval", code: "document.title" },
]));
if (process.env.QCB_DEBUG) console.log("first batch raw:", JSON.stringify(good).slice(0, 900));
check("batch runs every step", good.ok === true && good.ran === 4, `ran ${good.ran} of 4, error ${good.error || "none"}`);
const openedTab = good.results?.[0]?.tab?.id;
check("batch returns each result", good.results?.[2]?.value === 2 && String(good.results?.[3]?.value).includes("command check"), JSON.stringify(good.results?.map((r) => r.cmd)));
check("batch adopts the tab its first step opened", !!openedTab && good.tabId === openedTab, `batch tab ${good.tabId} vs opened ${openedTab}`);

const bad = await run("batch", JSON.stringify([
  { cmd: "eval", code: "'first'", tabId: openedTab },
  { cmd: "click", selector: "#never-rendered", tabId: openedTab },
  { cmd: "eval", code: "'never reached'", tabId: openedTab },
]));
check("batch stops at the first error", bad.ok === false && bad.stoppedAt === 1 && bad.results?.length === 2, `stoppedAt ${bad.stoppedAt}, ${bad.results?.length} results`);
check("batch never runs the step after the failure", !JSON.stringify(bad.results).includes("never reached"));
check("batch refuses a nested batch", (await run("batch", JSON.stringify([{ cmd: "batch", commands: [{ cmd: "ping" }] }]))).ok === false);
check("batch refuses more than 16 steps", (await run("batch", JSON.stringify(Array.from({ length: 17 }, () => ({ cmd: "ping" }))))).ok === false);

// 2. window: a dedicated window that never takes focus. Whether it also paints
// depends on the desktop: macOS marks a window that no part of which is on screen
// as covered, and Chrome then neither loads nor paints its tab. The structure is
// always asserted; the painting claim matches whatever the machine reported.
const win = await run("open", pageUrl, "--window");
const winTab = win.tab?.id;
check("open --window returns a tab in its own window", !!winTab && win.window?.id !== undefined, JSON.stringify(win.window));
check("the automation window ends up unfocused and not fullscreen", win.window?.focused === false && win.window?.state !== "fullscreen", `focused ${win.window?.focused}, state ${win.window?.state}, corrected ${JSON.stringify(win.window?.correctedAfter || false)}`);
check("the automation tab is the window's active tab", win.tab?.active === true, `visibility ${win.tab?.visibility}`);
const reused = await run("open", pageUrl, "--window");
check("a second --window reuses the same window", reused.window?.reused === true && reused.window?.id === win.window?.id, JSON.stringify(reused.window));
const winInfo = await run("window");
check("window reports its tabs", winInfo.exists === true && winInfo.tabs?.length >= 2, `${winInfo.tabs?.length} tabs`);

// 3. upload: a real file onto a hidden input, no OS chooser. This runs in a
// background tab of the user's own window, which is where uploads actually
// happen; the automation window above is only checked for structure because a
// covered window has no live DOM for the debugger to hand a node over.
const bg = await run("open", pageUrl);
const bgTab = bg.tab?.id;
await run("wait", "--selector", "#file", String(bgTab), "20000");
const up = await run("upload", "#file", uploadFile, String(bgTab));
check("upload accepts the file", up.ok === true && up.accepted === 1, `accepted ${up.accepted}, hidden ${up.inputWasHidden}, error ${up.error || "none"}`);
const seen = await run("eval", "document.getElementById('fileout').textContent", "--tab", String(bgTab));
check("the page's change handler saw the file", String(seen.value).startsWith("sample.png"), String(seen.value ?? JSON.stringify(seen)));
check("upload refuses something that is not a file input", (await run("upload", "#popover", uploadFile, String(bgTab))).ok === false);

// 4. visible: hold that background tab and make it paint.
const before = await run("eval", "document.getElementById('popover-box') ? 'mounted' : 'not mounted'", "--tab", String(bgTab));
const vis = await run("visible", "on", String(bgTab), "--paint");
check("visible on reports the probes it ran", vis.ok === true && vis.focusEmulation === "on", `visibilityState ${vis.visibilityState}, frames ${JSON.stringify(vis.frames)}`);
check("visible --paint really advances a frame", String(vis.frames).startsWith("frame after"), JSON.stringify(vis.frames));
await run("wait", "1500");
const after = await run("eval", "document.getElementById('popover-box') ? 'mounted' : 'not mounted'", "--tab", String(bgTab));
check("visible --paint lets the frame-only popover mount", String(after.value) === "mounted", `before ${before.value ?? before.error}, after ${after.value ?? after.error}`);
check("visible off releases the tab", (await run("visible", "off", String(bgTab))).ok === true);

// Cleanup: only the tabs and the window this check created.
await run("close", String(bgTab));
await run("close", String(openedTab));
const closed = await run("window", "close");
check("window close removes the automation window", closed.ok === true && closed.closed === win.window?.id, JSON.stringify(closed));

fs.rmSync(uploadDir, { recursive: true, force: true });
site.close();
console.log(failures ? `\nCommand check failed: ${failures} problem(s)` : "\nCommand check passed");
process.exit(failures ? 1 : 0);
