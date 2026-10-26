const POLL_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 30_000;
const DEFAULT_PORT = 8791;

// A local development build may ship config.local.js (gitignored) with
// { token, port } so the extension pairs without using the popup.
let LOCAL_CONFIG = null;
try {
  importScripts("config.local.js");
  LOCAL_CONFIG = self.QCB_LOCAL_CONFIG || null;
} catch {}

let looping = false;
let lastPollAt = 0;
let lastError = "";
let lastConfig = { token: "", port: DEFAULT_PORT };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setBadge(ok, text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: ok ? "#1f7a3d" : "#b42318" });
    await chrome.action.setBadgeText({ text: text ?? (ok ? "on" : "off") });
  } catch {}
}

async function getConfig() {
  const stored = await chrome.storage.local.get({ token: "", port: DEFAULT_PORT }).catch(() => ({}));
  const token = String(stored.token || LOCAL_CONFIG?.token || "").trim();
  const port = Number(stored.port || LOCAL_CONFIG?.port || DEFAULT_PORT);
  return { token, port: Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT };
}

const bridgeUrl = (config, path) => `http://127.0.0.1:${config.port}${path}`;

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab.id;
  const [any] = await chrome.tabs.query({ active: true });
  return any ? any.id : null;
}

async function waitForLoad(tabId, timeout = 15_000) {
  const limit = Math.min(Math.max(Number(timeout) || 15_000, 1_000), MAX_WAIT_MS);
  const start = Date.now();
  while (Date.now() - start < limit) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("tab closed");
    if (tab.status === "complete") return tab;
    await sleep(250);
  }
  return chrome.tabs.get(tabId);
}

function pageSnapshot(max) {
  const selector =
    'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
  const all = Array.from(document.querySelectorAll(selector));
  document.querySelectorAll("[data-qcb-ref]").forEach((el) => el.removeAttribute("data-qcb-ref"));
  const visible = all
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.visibility !== "hidden" &&
        s.display !== "none" &&
        r.bottom >= -80 &&
        r.top <= window.innerHeight + 80
      );
    })
    .slice(0, max);
  const elements = visible.map((el, i) => {
    const ref = i + 1;
    el.setAttribute("data-qcb-ref", String(ref));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const raw = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || el.value || el.getAttribute("name") || "";
    const name = String(raw).replace(/\s+/g, " ").trim().slice(0, 140);
    let extra = "";
    if (tag === "a") extra = " -> " + String(el.getAttribute("href") || "").slice(0, 140);
    if (tag === "input" || tag === "textarea" || tag === "select") {
      extra += ` [${el.type || tag}${el.value ? ": " + String(el.value).slice(0, 40) : ""}]`;
    }
    return `[${ref}] <${tag}${role ? " role=" + role : ""}> ${name}${extra}`;
  });
  const text = document.body ? document.body.innerText.replace(/\n{3,}/g, "\n\n").trim().slice(0, 2500) : "";
  return {
    url: location.href,
    title: document.title,
    shown: elements.length,
    total: all.length,
    elements,
    text,
    scrollY: Math.round(window.scrollY),
  };
}

function pageClick(ref, selector) {
  const el = selector ? document.querySelector(selector) : document.querySelector(`[data-qcb-ref="${ref}"]`);
  if (!el) return { ok: false, error: "element not found" };
  el.scrollIntoView({ block: "center", inline: "center" });
  if (typeof el.focus === "function") el.focus();
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), text: String(el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 120) };
}

function pageType(ref, selector, text, submit) {
  const el = selector ? document.querySelector(selector) : document.querySelector(`[data-qcb-ref="${ref}"]`);
  if (!el) return { ok: false, error: "element not found" };
  el.scrollIntoView({ block: "center" });
  el.focus();
  const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  if (isField) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
  } else if (el.isContentEditable) {
    el.textContent = text;
  } else {
    return { ok: false, error: "element is not editable" };
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) {
    const form = el.closest("form");
    if (form) form.requestSubmit();
  }
  return { ok: true, tag: el.tagName.toLowerCase() };
}

function pagePress(ref, selector, key) {
  const el = selector ? document.querySelector(selector) : ref ? document.querySelector(`[data-qcb-ref="${ref}"]`) : document.activeElement;
  if (!el) return { ok: false, error: "element not found" };
  el.focus?.();
  const opts = { key, code: key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
  if (key === "Enter" && el.form) el.form.requestSubmit();
  return { ok: true, key, tag: el.tagName.toLowerCase() };
}

function pageScroll(y, ref) {
  const el = ref ? document.querySelector(`[data-qcb-ref="${ref}"]`) : null;
  if (el) el.scrollIntoView({ block: "center" });
  else window.scrollBy({ top: y, behavior: "instant" });
  return { ok: true, scrollY: Math.round(window.scrollY) };
}

async function run(cmd) {
  const tabId = cmd.tabId ?? (await activeTabId());
  switch (cmd.cmd) {
    case "ping":
      return { ok: true, pong: true, tabs: (await chrome.tabs.query({})).length, extensionId: chrome.runtime.id };
    case "tabs": {
      const tabs = await chrome.tabs.query({});
      return {
        ok: true,
        tabs: tabs.map((t) => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url })),
      };
    }
    case "open": {
      if (!cmd.url) throw new Error("url required");
      const tab = await chrome.tabs.create({ url: cmd.url, active: cmd.active !== false });
      const loaded = await waitForLoad(tab.id, cmd.timeout);
      return { ok: true, tab: { id: loaded.id, url: loaded.url, title: loaded.title, status: loaded.status } };
    }
    case "goto": {
      if (!tabId) throw new Error("no tab");
      if (!cmd.url) throw new Error("url required");
      await chrome.tabs.update(tabId, { url: cmd.url });
      const loaded = await waitForLoad(tabId, cmd.timeout);
      return { ok: true, tab: { id: loaded.id, url: loaded.url, title: loaded.title, status: loaded.status } };
    }
    case "activate": {
      if (!tabId) throw new Error("no tab");
      const tab = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title } };
    }
    case "close": {
      if (!tabId) throw new Error("no tab");
      await chrome.tabs.remove(tabId);
      return { ok: true };
    }
    case "snapshot": {
      if (!tabId) throw new Error("no tab");
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageSnapshot,
        args: [cmd.max ?? 250],
      });
      return { ok: true, tabId, ...out.result };
    }
    case "click": {
      if (!tabId) throw new Error("no tab");
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageClick,
        args: [cmd.ref ?? null, cmd.selector ?? null],
      });
      return { ...out.result, tabId };
    }
    case "type": {
      if (!tabId) throw new Error("no tab");
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageType,
        args: [cmd.ref ?? null, cmd.selector ?? null, String(cmd.text ?? ""), !!cmd.submit],
      });
      return { ...out.result, tabId };
    }
    case "press": {
      if (!tabId) throw new Error("no tab");
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pagePress,
        args: [cmd.ref ?? null, cmd.selector ?? null, cmd.key || "Enter"],
      });
      return { ...out.result, tabId };
    }
    case "scroll": {
      if (!tabId) throw new Error("no tab");
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageScroll,
        args: [cmd.y ?? 600, cmd.ref ?? null],
      });
      return { ...out.result, tabId };
    }
    case "wait": {
      if (cmd.selector) {
        if (!tabId) throw new Error("no tab");
        const timeout = Math.min(Math.max(Number(cmd.timeout) || 15_000, 500), MAX_WAIT_MS);
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const [out] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (sel) => !!document.querySelector(sel),
            args: [cmd.selector],
          });
          if (out.result) return { ok: true, selector: cmd.selector };
          await sleep(300);
        }
        return { ok: false, error: `selector not found: ${cmd.selector}` };
      }
      await sleep(Math.min(Math.max(Number(cmd.ms) || 1_000, 0), MAX_WAIT_MS));
      return { ok: true };
    }
    case "eval": {
      if (!tabId) throw new Error("no tab");
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (code) => {
          try {
            const value = (0, eval)(code);
            return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        args: [String(cmd.code ?? "")],
      });
      return { ...out.result, tabId };
    }
    case "screenshot": {
      if (!tabId) throw new Error("no tab");
      const tab = await chrome.tabs.get(tabId);
      if (!tab.active) await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleep(200);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { ok: true, tabId, dataUrl };
    }
    default:
      return { ok: false, error: `unknown command: ${cmd.cmd}` };
  }
}

async function pollOnce(config) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POLL_TIMEOUT_MS + 5_000);
  const token = encodeURIComponent(config.token);
  try {
    const res = await fetch(`${bridgeUrl(config, "/poll")}?token=${token}`, { cache: "no-store", signal: ctrl.signal });
    if (res.status === 204) {
      lastPollAt = Date.now();
      lastError = "";
      await setBadge(true);
      return;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("the bridge rejected the token. Paste the current one from `node server.mjs --token`.");
    }
    if (!res.ok) throw new Error(`poll ${res.status}`);
    lastPollAt = Date.now();
    lastError = "";
    const cmd = await res.json();
    let payload;
    try {
      payload = await run(cmd);
    } catch (e) {
      payload = { ok: false, error: String(e?.message || e) };
    }
    await fetch(`${bridgeUrl(config, "/result")}?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, id: cmd.id }),
    });
    await setBadge(true);
  } catch (e) {
    lastError = String(e?.message || e);
    await setBadge(false, "!");
    await sleep(1500);
  } finally {
    clearTimeout(timer);
  }
}

async function loop() {
  if (looping) return;
  looping = true;
  try {
    while (true) {
      const config = await getConfig();
      lastConfig = config;
      if (!config.token) {
        lastError = "Not paired yet. Open the extension popup and paste the bridge token.";
        await setBadge(false, "set");
        await sleep(2_000);
        continue;
      }
      await pollOnce(config);
      await sleep(50);
    }
  } finally {
    looping = false;
  }
}

chrome.alarms.create("qcb-keepalive", { periodInMinutes: 0.2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "qcb-keepalive") loop();
});
chrome.runtime.onStartup.addListener(() => loop());
chrome.runtime.onInstalled.addListener(() => loop());
chrome.storage.onChanged.addListener(() => loop());
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "status") {
    getConfig().then((config) => {
      sendResponse({
        paired: !!config.token,
        bridge: `127.0.0.1:${config.port}`,
        connected: Date.now() - lastPollAt < 35_000,
        lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
        lastError,
      });
    });
    return true;
  }
  if (msg?.type === "reconnect") {
    loop();
    sendResponse({ ok: true });
  }
  return true;
});

loop();
