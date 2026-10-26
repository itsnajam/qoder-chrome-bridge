import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokenFile = path.join(here, "token");
const PORT = Number(process.env.QCB_PORT || 8791);
const POLL_HOLD_MS = 25_000;
const CONNECTED_MS = POLL_HOLD_MS + 10_000;
const COMMAND_TIMEOUT_MS = 40_000;
const MAX_BODY = 25 * 1024 * 1024;

function loadToken() {
  if (process.env.QCB_TOKEN?.trim()) return process.env.QCB_TOKEN.trim();
  try {
    const existing = fs.readFileSync(tokenFile, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const created = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  fs.writeFileSync(tokenFile, created + "\n", { mode: 0o600 });
  console.log(`Created a pairing token at ${tokenFile}`);
  return created;
}

if (process.argv.includes("--token")) {
  console.log(loadToken());
  process.exit(0);
}

const TOKEN = loadToken();

let queue = [];
let waiter = null;
let pending = new Map();
let lastPoll = 0;
let lastDelivered = 0;

function allowedOrigin(origin) {
  if (!origin) return null;
  if (origin.startsWith("chrome-extension://")) return origin;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return origin;
  return false;
}

function cors(req, res) {
  const origin = allowedOrigin(req.headers.origin);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
}

function send(res, code, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function connected() {
  const seen = Math.max(lastPoll, lastDelivered);
  const window = pending.size ? COMMAND_TIMEOUT_MS + 15_000 : CONNECTED_MS;
  return Date.now() - seen < window;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req, url) {
  return url.searchParams.get("token") === TOKEN;
}

function deliver(command) {
  if (waiter) {
    const { res, timer } = waiter;
    waiter = null;
    clearTimeout(timer);
    lastDelivered = Date.now();
    send(res, 200, command);
    return true;
  }
  return false;
}

function finish(id, payload) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  cors(req, res);

  if (allowedOrigin(req.headers.origin) === false) {
    send(res, 403, { ok: false, error: "origin not allowed" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    send(res, 200, {
      ok: true,
      extensionConnected: connected(),
      busy: pending.size > 0,
      lastPoll: lastPoll ? new Date(lastPoll).toISOString() : null,
      lastDelivered: lastDelivered ? new Date(lastDelivered).toISOString() : null,
      queued: queue.length,
      pending: pending.size,
    });
    return;
  }

  if (!authorized(req, url)) {
    send(res, 401, { ok: false, error: "bad token" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/poll") {
    lastPoll = Date.now();
    if (queue.length) {
      lastDelivered = Date.now();
      send(res, 200, queue.shift());
      return;
    }
    if (waiter) {
      send(res, 204, { ok: true });
      return;
    }
    const timer = setTimeout(() => {
      if (waiter && waiter.res === res) {
        waiter = null;
        lastPoll = Date.now();
        send(res, 204, { ok: true });
      }
    }, POLL_HOLD_MS);
    waiter = { res, timer };
    req.on("close", () => {
      if (waiter && waiter.res === res) {
        waiter = null;
        clearTimeout(timer);
        lastPoll = Date.now();
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/result") {
    try {
      const body = await readBody(req);
      if (!body.id) {
        send(res, 400, { ok: false, error: "missing id" });
        return;
      }
      finish(body.id, body);
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/command") {
    try {
      const body = await readBody(req);
      if (!body.cmd) {
        send(res, 400, { ok: false, error: "missing cmd" });
        return;
      }
      const id = randomUUID();
      const command = { id, ...body };
      if (!connected()) {
        send(res, 503, {
          ok: false,
          error: "extension not connected",
          hint: "Open Chrome, load the Chrome Bridge extension, paste the token from `node server.mjs --token` into its popup, then retry.",
        });
        return;
      }
      const promise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: "command timed out", id, cmd: body.cmd });
        }, COMMAND_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
      });
      if (!deliver(command)) queue.push(command);
      const result = await promise;
      send(res, result.ok === false && result.error ? 502 : 200, result);
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  send(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Chrome Bridge for Qoder listening on http://127.0.0.1:${PORT}`);
  console.log(`Token file: ${path.join(here, "token")} (print it with: node server.mjs --token)`);
  console.log("Built by Muhammad Najam Ul Hassan. Need a website, an app or AI automation? https://najam.dev");
});
