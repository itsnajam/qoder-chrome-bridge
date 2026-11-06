const POLL_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 30_000;
const DEFAULT_PORT = 8791;

// Nothing may hold the command loop open. Chrome can leave captureVisibleTab
// pending forever when the window is occluded or on another Space, and a pending
// extension API call keeps the service worker alive while polling stops, which
// looks exactly like a dead extension and cannot be woken from outside.
const COMMAND_DEADLINE_MS = 35_000;
const VISIBLE_CAPTURE_MS = 8_000;
const DEBUGGER_CAPTURE_MS = 20_000;

// A batch is one command that runs several, so it needs a longer deadline than a
// single step. The cap keeps a runaway list from holding the loop open forever.
const BATCH_MAX_STEPS = 16;
const BATCH_DEADLINE_MS = 170_000;

// Chrome only advances frames for the active tab of a window it is painting, so a
// background tab cannot mount popovers that measure themselves. A separate window
// created with focused:false paints its active tab without taking the user's focus.
const AUTOMATION_WINDOW_KEY = "qcbAutomationWindowId";
const AUTOMATION_WINDOW_SIZE = { width: 1280, height: 900 };

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

// The losing promise stays pending, which is fine: the point is that the loop
// moves on and keeps polling instead of waiting on a capture that never lands.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// A batch runs several steps inside one command, so it gets a longer deadline.
// Everything else keeps the single-command bound that stops a stuck capture from
// wedging the polling loop.
function deadlineFor(cmd) {
  if (cmd?.cmd !== "batch") return COMMAND_DEADLINE_MS;
  return Math.min(Math.max(Number(cmd.timeoutMs) || BATCH_DEADLINE_MS, COMMAND_DEADLINE_MS), BATCH_DEADLINE_MS);
}

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

// A tab that was just created reports status "complete" with an empty URL, and a
// tab that is being navigated keeps reporting the page it is leaving. Both look
// finished to a single poll, so a load is only accepted once the tab has a real
// URL that differs from the one it started on.
async function waitForLoad(tabId, timeout = 15_000, previousUrl) {
  const limit = Math.min(Math.max(Number(timeout) || 15_000, 1_000), MAX_WAIT_MS);
  const start = Date.now();
  while (Date.now() - start < limit) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("tab closed");
    const committed = tab.status === "complete" && tab.url && tab.url !== "about:blank" && tab.url !== previousUrl;
    if (committed) {
      await sleep(150);
      const again = await chrome.tabs.get(tabId).catch(() => tab);
      if (again.status === "complete" && again.url === tab.url) return again;
      continue;
    }
    await sleep(200);
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

function pageFocusTarget(ref, selector) {
  const el = selector ? document.querySelector(selector) : document.querySelector(`[data-qcb-ref="${ref}"]`);
  if (!el) return { ok: false, error: "element not found" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (typeof el.focus === "function") el.focus();
  return { ok: true, tag: el.tagName.toLowerCase() };
}

// Viewport centre of the target, in CSS pixels, ready for CDP Input.dispatch*MouseEvent.
function pageTargetPoint(ref, selector) {
  const el = selector ? document.querySelector(selector) : document.querySelector(`[data-qcb-ref="${ref}"]`);
  if (!el) return { ok: false, error: "element not found" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { ok: false, error: "element has no visible box" };
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
    return { ok: false, error: `element centre (${Math.round(x)}, ${Math.round(y)}) is outside the viewport` };
  }
  if (typeof el.focus === "function") el.focus();
  return {
    ok: true,
    x: Math.round(x),
    y: Math.round(y),
    tag: el.tagName.toLowerCase(),
    text: String(el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 120),
  };
}

const CDP_PROTOCOL = "1.3";

function attachError(e) {
  return String(e?.message || e);
}

// A sticky session keeps the debugger attached to one tab, so focus emulation and
// a forced frame stream survive between commands. Without it every click attaches,
// sends one event and detaches, and a background tab drops back to not painting.
const STICKY = new Map(); // tabId -> { paint, spoof, screencastSessionId, attachedAt }
const STICKY_KEY = "qcb-sticky";
const STICKY_MAX_MS = 30 * 60 * 1000;

const VISIBILITY_OVERRIDE = `(() => {
  try {
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  } catch (e) {}
})();`;

// Renderer frames only advance while the tab is on screen, so react portals that
// measure themselves in requestAnimationFrame never get a box in a hidden tab.
// A screencast forces the renderer to keep producing frames.
async function startPaint(tabId, send) {
  await send("Page.startScreencast", { format: "jpeg", quality: 5, maxWidth: 320, maxHeight: 240, everyNthFrame: 4 }).catch(() => {});
}

async function stopPaint(tabId, send) {
  await send("Page.stopScreencast").catch(() => {});
}

// Acks keep the frame stream alive; Chrome pauses after one unacknowledged frame.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Page.screenshotRequested" || source.tabId == null) return;
  if (!STICKY.has(source.tabId)) return;
  chrome.debugger.sendCommand({ tabId: source.tabId }, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
});

async function stickySend(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function releaseSticky(tabId) {
  const state = STICKY.get(tabId);
  STICKY.delete(tabId);
  await persistSticky();
  if (!state) return { ok: true, tabId, sticky: false };
  if (state.paint) await stickySend(tabId, "Page.stopScreencast").catch(() => {});
  if (state.overrideId) await stickySend(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier: state.overrideId }).catch(() => {});
  await stickySend(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
  await chrome.debugger.detach({ tabId }).catch(() => {});
  return { ok: true, tabId, sticky: false };
}

async function persistSticky() {
  const ids = [...STICKY.keys()];
  try {
    await chrome.storage.session.set({ [STICKY_KEY]: ids });
  } catch {}
}

async function readStickyIds() {
  try {
    const stored = await chrome.storage.session.get({ [STICKY_KEY]: [] });
    return Array.isArray(stored[STICKY_KEY]) ? stored[STICKY_KEY] : [];
  } catch {
    return [];
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId != null && STICKY.has(source.tabId)) {
    STICKY.delete(source.tabId);
    persistSticky();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => STICKY.delete(tabId));

// Re-arm sticky tabs after a service-worker restart or a dropped session, and drop
// any that have been held for too long. Cheap enough to run before each command.
async function refreshSticky() {
  const stored = await readStickyIds();
  for (const id of stored) {
    const tabId = Number(id);
    if (!Number.isFinite(tabId) || STICKY.has(tabId)) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      STICKY.delete(tabId);
      continue;
    }
    try {
      await chrome.debugger.attach({ tabId }, CDP_PROTOCOL);
    } catch {
      continue;
    }
    STICKY.set(tabId, { paint: false, spoof: false, screencastSessionId: "", overrideId: "", attachedAt: Date.now(), reattached: true });
  }
  for (const [tabId, state] of STICKY) {
    if (Date.now() - state.attachedAt > STICKY_MAX_MS) {
      await releaseSticky(tabId);
      continue;
    }
    const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p);
    await send("Page.enable").catch(() => {});
    await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    if (state.paint) await startPaint(tabId, send);
  }
  if (stored.length !== STICKY.size) await persistSticky();
}

// Real input events need chrome.debugger. DevTools open on the same tab, or a
// chrome:// page, blocks the attach; callers fall back to synthetic events then.
// A tab held by `visible` is already attached, so reuse that session.
async function withDebugger(tabId, fn) {
  const target = { tabId };
  const sticky = STICKY.has(tabId);
  let attachedHere = false;
  if (!sticky) {
    try {
      await chrome.debugger.attach(target, CDP_PROTOCOL);
      attachedHere = true;
    } catch (e) {
      const message = attachError(e);
      if (!message.includes("Already attached")) throw new Error(`debugger attach failed: ${message}`);
    }
  }
  try {
    return await fn((method, params) => chrome.debugger.sendCommand(target, method, params));
  } finally {
    if (attachedHere) await chrome.debugger.detach(target).catch(() => {});
  }
}

// Renderer-side capture, so a tab that is not on screen still produces a real
// frame. captureBeyondViewport forces a paint even when the tab was never shown.
async function captureThroughDebugger(tabId) {
  return withDebugger(tabId, async (send) => {
    let data;
    try {
      ({ data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true }));
    } catch {
      ({ data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true }));
    }
    if (!data) throw new Error("empty screenshot");
    return `data:image/png;base64,${data}`;
  });
}

// A tab that is not on screen is treated as unfocused, and Chrome drops key and
// press/release input for it. Focus emulation makes the renderer accept them.
// Sticky `visible` tabs keep the emulation on, so this only turns it off for the
// one command when the tab is not held.
async function withInput(tabId, fn) {
  return withDebugger(tabId, async (send) => {
    await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    try {
      return await fn(send);
    } finally {
      if (!STICKY.has(tabId)) {
        await send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
      }
    }
  });
}

const MOUSE_STEPS = {
  move: [{ type: "mouseMoved", button: "none" }],
  down: [{ type: "mousePressed", button: "left", clickCount: 1, buttons: 1 }],
  up: [{ type: "mouseReleased", button: "left", clickCount: 1, buttons: 0 }],
  click: [
    { type: "mouseMoved", button: "none" },
    { type: "mousePressed", button: "left", clickCount: 1, buttons: 1 },
    { type: "mouseReleased", button: "left", clickCount: 1, buttons: 0 },
  ],
};

async function sendMouse(send, action, x, y) {
  const steps = MOUSE_STEPS[action];
  if (!steps) throw new Error(`unknown mouse action: ${action}`);
  for (const step of steps) await send("Input.dispatchMouseEvent", { ...step, x, y });
}

const NAMED_KEYS = {
  backspace: ["Backspace", "Backspace", 8],
  tab: ["Tab", "Tab", 9, "\t"],
  enter: ["Enter", "Enter", 13, "\r"],
  return: ["Enter", "Enter", 13, "\r"],
  escape: ["Escape", "Escape", 27],
  esc: ["Escape", "Escape", 27],
  space: [" ", "Space", 32, " "],
  spacebar: [" ", "Space", 32, " "],
  delete: ["Delete", "Delete", 46],
  del: ["Delete", "Delete", 46],
  insert: ["Insert", "Insert", 45],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
  up: ["ArrowUp", "ArrowUp", 38],
  arrowup: ["ArrowUp", "ArrowUp", 38],
  down: ["ArrowDown", "ArrowDown", 40],
  arrowdown: ["ArrowDown", "ArrowDown", 40],
  left: ["ArrowLeft", "ArrowLeft", 37],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  right: ["ArrowRight", "ArrowRight", 39],
  arrowright: ["ArrowRight", "ArrowRight", 39],
  capslock: ["CapsLock", "CapsLock", 20],
  control: ["Control", "ControlLeft", 17],
  ctrl: ["Control", "ControlLeft", 17],
  alt: ["Alt", "AltLeft", 18],
  option: ["Alt", "AltLeft", 18],
  shift: ["Shift", "ShiftLeft", 16],
  meta: ["Meta", "MetaLeft", 91],
  cmd: ["Meta", "MetaLeft", 91],
  command: ["Meta", "MetaLeft", 91],
};

// Shifted symbols carry their own virtual key code, so Gmail's "# delete" and
// similar shortcuts see the code they actually check.
const SHIFTED_KEYS = {
  "!": ["Digit1", 49],
  "@": ["Digit2", 50],
  "#": ["Digit3", 51],
  $: ["Digit4", 52],
  "%": ["Digit5", 53],
  "^": ["Digit6", 54],
  "&": ["Digit7", 55],
  "*": ["Digit8", 56],
  "(": ["Digit9", 57],
  ")": ["Digit0", 48],
  _: ["Minus", 189],
  "+": ["Equal", 187],
  "{": ["BracketLeft", 219],
  "}": ["BracketRight", 221],
  "|": ["Backslash", 220],
  ":": ["Semicolon", 186],
  '"': ["Quote", 222],
  "<": ["Comma", 188],
  ">": ["Period", 190],
  "?": ["Slash", 191],
  "~": ["Backquote", 192],
};

const PLAIN_KEYS = {
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
  "`": ["Backquote", 192],
};

function keyDescriptor(name) {
  const raw = String(name ?? "");
  const named = NAMED_KEYS[raw.toLowerCase()];
  if (named) return { key: named[0], code: named[1], vk: named[2], text: named[3] };
  const fn = /^f([1-9]|1[0-2])$/.exec(raw.toLowerCase());
  if (fn) {
    const label = `F${fn[1]}`;
    return { key: label, code: label, vk: 111 + Number(fn[1]) };
  }
  if ([...raw].length !== 1) return null;
  if (/^[a-z]$/i.test(raw)) {
    const upper = raw.toUpperCase();
    return { key: raw, code: `Key${upper}`, vk: upper.charCodeAt(0), text: raw, shift: raw === upper };
  }
  if (/^[0-9]$/.test(raw)) return { key: raw, code: `Digit${raw}`, vk: 48 + Number(raw), text: raw };
  const shifted = SHIFTED_KEYS[raw];
  if (shifted) return { key: raw, code: shifted[0], vk: shifted[1], text: raw, shift: true };
  const plain = PLAIN_KEYS[raw];
  if (plain) return { key: raw, code: plain[0], vk: plain[1], text: raw };
  return null;
}

async function sendKey(send, desc) {
  const base = {
    key: desc.key,
    code: desc.code,
    windowsVirtualKeyCode: desc.vk,
    nativeVirtualKeyCode: desc.vk,
    modifiers: desc.shift ? 8 : 0,
  };
  await send("Input.dispatchKeyEvent", { ...base, type: "keyDown", ...(desc.text ? { text: desc.text } : {}) });
  await send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

async function targetPoint(tabId, cmd) {
  const [out] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageTargetPoint,
    args: [cmd.ref ?? null, cmd.selector ?? null],
  });
  return out?.result || { ok: false, error: "element lookup returned no result" };
}

// Chrome can hold a newly created tab at an empty URL for a long time when the
// window it belongs to is not being painted. Saying so beats returning a tab that
// looks fine and then hanging every later command aimed at it.
function loadNote(tab) {
  const committed = tab?.status === "complete" && tab?.url && tab.url !== "about:blank";
  return committed ? {} : { warning: `the page had not committed when the load wait ended (status ${tab?.status}, url ${tab?.url || "empty"}). Chrome defers tabs in windows it is not painting, so read the tab again or work in a tab that is already loaded` };
}

async function automationWindowId() {
  try {
    const stored = await chrome.storage.session.get({ [AUTOMATION_WINDOW_KEY]: null });
    const id = Number(stored[AUTOMATION_WINDOW_KEY]);
    if (!Number.isFinite(id) || id <= 0) return null;
    const win = await chrome.windows.get(id).catch(() => null);
    if (!win) {
      await chrome.storage.session.set({ [AUTOMATION_WINDOW_KEY]: null }).catch(() => {});
      return null;
    }
    return win.id;
  } catch {
    return null;
  }
}

async function rememberAutomationWindow(id) {
  try {
    await chrome.storage.session.set({ [AUTOMATION_WINDOW_KEY]: id ?? null });
  } catch {}
}

function automationWindowSize(value) {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(value ?? ""));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : AUTOMATION_WINDOW_SIZE;
}

async function openInAutomationWindow(cmd) {
  const size = automationWindowSize(cmd.window);
  const existing = await automationWindowId();
  let win;
  let tab;
  let stoleFocus = false;
  if (existing) {
    win = await chrome.windows.get(existing);
    tab = await chrome.tabs.create({ url: cmd.url, windowId: existing, active: true });
  } else {
    win = await chrome.windows.create({ url: cmd.url, focused: false, type: "normal", ...size });
    // On macOS a new window inherits the current Space's fullscreen state and can
    // come up focused even when asked not to, which is the one thing this option
    // must never do. Normalise it and say so if it had to be corrected.
    stoleFocus = !!win.focused || win.state === "fullscreen" || win.state === "maximized";
    if (stoleFocus) {
      await chrome.windows.update(win.id, { state: "normal", ...size }).catch(() => {});
      win = await chrome.windows.get(win.id).catch(() => win);
    }
    await rememberAutomationWindow(win.id);
    [tab] = await chrome.tabs.query({ windowId: win.id });
    if (!tab) return { ok: false, error: "the automation window opened without a tab" };
  }
  const loaded = await waitForLoad(tab.id, cmd.timeout);
  const after = await chrome.windows.get(win.id).catch(() => win);
  const tabs = await chrome.tabs.query({ windowId: win.id });
  return {
    ok: true,
    tab: { id: loaded.id, url: loaded.url, title: loaded.title, status: loaded.status, windowId: win.id, active: loaded.active, visibility: loaded.visible ? "visible" : "hidden" },
    ...loadNote(loaded),
    ...(loaded.visible ? {} : { windowWarning: "Chrome reports this window as covered, so its tab is neither painting nor loading. The window only helps while some part of it is on screen; otherwise use visible on <tabId> --paint." }),
    window: {
      id: win.id,
      reused: !!existing,
      focused: !!after.focused,
      state: after.state,
      width: after.width,
      height: after.height,
      tabs: tabs.length,
      ...(stoleFocus ? { correctedAfter: "Chrome opened this window focused or fullscreen, so the bridge set it back to normal and unfocused" } : {}),
    },
  };
}

async function describeAutomationWindow(cmd) {
  const id = await automationWindowId();
  if (!id) return { ok: true, exists: false };
  const win = await chrome.windows.get(id).catch(() => null);
  if (!win) {
    await rememberAutomationWindow(null);
    return { ok: true, exists: false, stale: true };
  }
  if (cmd.close === true) {
    await chrome.windows.remove(id);
    await rememberAutomationWindow(null);
    return { ok: true, closed: id };
  }
  const tabs = await chrome.tabs.query({ windowId: id });
  return {
    ok: true,
    exists: true,
    window: { id, focused: !!win.focused, state: win.state, width: win.width, height: win.height },
    tabs: tabs.map((t) => ({ id: t.id, url: t.url, active: t.active, visible: t.visible })),
  };
}

async function run(cmd) {
  const tabId = cmd.tabId ?? (await activeTabId());
  if (cmd.cmd !== "visible") {
    const held = STICKY.size || (await readStickyIds()).length;
    if (held) await refreshSticky().catch(() => {});
  }
  switch (cmd.cmd) {
    case "ping":
      return {
        ok: true,
        pong: true,
        tabs: (await chrome.tabs.query({})).length,
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
        sticky: [...STICKY.keys()],
      };
    case "reload": {
      // Editing these files only takes effect after the extension reloads, and the
      // reload button lives on chrome://extensions, which no command can reach.
      // The result is posted before the worker dies, so the CLI sees success.
      setTimeout(() => chrome.runtime.reload(), 400);
      return { ok: true, reloading: true, note: "the worker restarts; sticky tabs are dropped and re-attached on the next command" };
    }
    case "tabs": {
      const tabs = await chrome.tabs.query({});
      return {
        ok: true,
        tabs: tabs.map((t) => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url })),
      };
    }
    case "open": {
      if (!cmd.url) throw new Error("url required");
      if (cmd.window) return await openInAutomationWindow(cmd);
      // Background by default: an agent opening pages should not pull the user
      // away from whatever they are doing. Pass active:true to bring it forward.
      const tab = await chrome.tabs.create({ url: cmd.url, active: cmd.active === true });
      const loaded = await waitForLoad(tab.id, cmd.timeout);
      return { ok: true, tab: { id: loaded.id, url: loaded.url, title: loaded.title, status: loaded.status }, ...loadNote(loaded) };
    }
    case "window":
      return await describeAutomationWindow(cmd);
    case "batch": {
      const steps = Array.isArray(cmd.commands) ? cmd.commands : null;
      if (!steps || !steps.length) return { ok: false, error: "batch needs commands: an array of at least one command" };
      if (steps.length > BATCH_MAX_STEPS) return { ok: false, error: `batch takes at most ${BATCH_MAX_STEPS} commands`, steps: steps.length };
      const badAt = steps.findIndex((s) => !s || typeof s !== "object" || typeof s.cmd !== "string" || s.cmd === "batch" || s.cmd === "reload" || s.cmd === "health");
      if (badAt >= 0) {
        return { ok: false, error: `batch step ${badAt} is not usable: every entry needs a cmd, and batch, reload and health cannot nest` };
      }
      const results = [];
      const until = Date.now() + deadlineFor(cmd) - 3_000;
      // A batch is scoped to one tab. If the caller did not name one and a step
      // opens a tab, that tab becomes the batch's tab, so a list starting with
      // open does not go on to act on whatever the user happens to be looking at.
      let batchTab = tabId ?? null;
      for (let i = 0; i < steps.length; i++) {
        if (Date.now() > until) {
          return { ok: false, error: `batch ran out of time before step ${i} (${steps[i].cmd})`, ran: results.length, stoppedAt: i, results };
        }
        const step = { ...steps[i] };
        if (step.tabId == null && batchTab != null) step.tabId = batchTab;
        let out;
        try {
          out = await run(step);
        } catch (e) {
          out = { ok: false, error: String(e?.message || e) };
        }
        results.push({ step: i, cmd: step.cmd, ...out });
        if (cmd.tabId == null && out?.tab?.id != null) batchTab = out.tab.id;
        if (out?.ok !== true) {
          return { ok: false, error: `step ${i} (${step.cmd}) failed: ${out?.error || "it reported no error"}`, ran: results.length, stoppedAt: i, results };
        }
      }
      return { ok: true, tabId: batchTab, ran: results.length, results };
    }
    case "goto": {
      if (!tabId) throw new Error("no tab");
      if (!cmd.url) throw new Error("url required");
      const before = await chrome.tabs.get(tabId).catch(() => null);
      await chrome.tabs.update(tabId, { url: cmd.url });
      const loaded = await waitForLoad(tabId, cmd.timeout, before?.url);
      return { ok: true, tab: { id: loaded.id, url: loaded.url, title: loaded.title, status: loaded.status }, ...loadNote(loaded) };
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
      const point = await targetPoint(tabId, cmd);
      if (!point.ok) return { ...point, tabId };
      try {
        await withInput(tabId, (send) => sendMouse(send, "click", point.x, point.y));
        return { ok: true, mode: "trusted", tabId, ...point };
      } catch (e) {
        const [out] = await chrome.scripting.executeScript({
          target: { tabId },
          func: pageClick,
          args: [cmd.ref ?? null, cmd.selector ?? null],
        });
        return { ...out.result, tabId, mode: "synthetic", warning: `${attachError(e)}; used el.click() instead` };
      }
    }
    case "mouse": {
      if (!tabId) throw new Error("no tab");
      const action = cmd.action ?? "click";
      if (!MOUSE_STEPS[action]) return { ok: false, error: `unknown mouse action: ${action}`, tabId };
      let { x, y } = cmd;
      let detail = {};
      if (cmd.ref != null || cmd.selector) {
        const point = await targetPoint(tabId, cmd);
        if (!point.ok) return { ...point, tabId };
        x = point.x;
        y = point.y;
        detail = { tag: point.tag, text: point.text };
      }
      x = Math.round(Number(x));
      y = Math.round(Number(y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("mouse needs x and y, or a ref/selector");
      await withInput(tabId, (send) => sendMouse(send, action, x, y));
      return { ok: true, mode: "trusted", tabId, action, x, y, ...detail };
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
      const key = cmd.key || "Enter";
      const desc = keyDescriptor(key);
      if (!desc) return { ok: false, error: `unknown key: ${key}`, tabId };
      let focused;
      if (cmd.ref != null || cmd.selector) {
        const [out] = await chrome.scripting.executeScript({
          target: { tabId },
          func: pageFocusTarget,
          args: [cmd.ref ?? null, cmd.selector ?? null],
        });
        if (!out?.result?.ok) return { ...(out?.result || { ok: false, error: "element lookup returned no result" }), tabId };
        focused = { tag: out.result.tag };
      }
      try {
        await withInput(tabId, (send) => sendKey(send, desc));
        return { ok: true, mode: "trusted", tabId, key, code: desc.code, keyCode: desc.vk, ...focused };
      } catch (e) {
        const [out] = await chrome.scripting.executeScript({
          target: { tabId },
          func: pagePress,
          args: [cmd.ref ?? null, cmd.selector ?? null, key],
        });
        return { ...out.result, tabId, mode: "synthetic", warning: `${attachError(e)}; used a synthetic KeyboardEvent instead` };
      }
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

      // captureVisibleTab already covers the common case and avoids the debugger
      // infobar. It never focuses the window, and it is bounded because Chrome can
      // leave it pending when the window is occluded or on another Space.
      if (tab.active) {
        try {
          const dataUrl = await withTimeout(
            chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }),
            VISIBLE_CAPTURE_MS,
            "captureVisibleTab",
          );
          return { ok: true, tabId, dataUrl, mode: "visible" };
        } catch {}
      }

      // A background tab has no visible surface, so capture it through the
      // debugger. This is what keeps the user's screen where it is.
      try {
        const dataUrl = await withTimeout(captureThroughDebugger(tabId), DEBUGGER_CAPTURE_MS, "debugger capture");
        return { ok: true, tabId, dataUrl, mode: "background" };
      } catch {}

      // Bringing the tab on screen is the only way left, and it changes what the
      // user is looking at, so it never happens unless the caller asks for it.
      if (cmd.focus !== true) {
        return {
          ok: false,
          error: `no capturable surface for tab ${tabId} (window minimized or hidden). Resend with "focus": true to raise it, or use snapshot.`,
          tabId,
        };
      }
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleep(200);
      const dataUrl = await withTimeout(
        chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }),
        VISIBLE_CAPTURE_MS,
        "captureVisibleTab",
      );
      return { ok: true, tabId, dataUrl, mode: "focused" };
    }
    case "upload": {
      if (!tabId) throw new Error("no tab");
      const files = Array.isArray(cmd.files) ? cmd.files.map(String) : [];
      if (!files.length) return { ok: false, error: "upload needs files: an array of absolute paths", tabId };
      if (files.some((f) => !f.startsWith("/"))) return { ok: false, error: "upload needs absolute paths", tabId };
      const selector = cmd.selector || (cmd.ref != null ? `[data-qcb-ref="${cmd.ref}"]` : "");
      if (!selector) return { ok: false, error: "upload needs a selector or ref", tabId };
      const readBack = `(function(){var e=document.querySelector(${JSON.stringify(selector)});
        if(!e) return {missing:true};
        return {tag:e.tagName, type:e.type, files:(e.files||[]).length, names:Array.from(e.files||[]).map(function(f){return f.name+":"+f.size}), visible:!!(e.getBoundingClientRect().width||e.getBoundingClientRect().height)};})()`;
      try {
        return await withDebugger(tabId, async (send) => {
          await send("Page.enable").catch(() => {});
          await send("DOM.enable").catch(() => {});
          const before = await send("Runtime.evaluate", { expression: readBack, returnByValue: true });
          const info = before?.result?.value || {};
          if (info.missing) return { ok: false, error: `no element for selector: ${selector}`, tabId };
          if (String(info.tag).toLowerCase() !== "input" || String(info.type) !== "file") {
            return { ok: false, error: `${selector} is not an input[type=file] (it is ${info.tag || "?"}${info.type ? "[type=" + info.type + "]" : ""})`, tabId };
          }
          // A node id from the DOM domain is what setFileInputFiles wants. Going
          // through Runtime.evaluate and DOM.requestNode fails on a tab whose DOM
          // agent has not pushed the node yet, which is most background tabs, so
          // the document tree is asked for directly and the object path is only
          // the fallback.
          let target = {};
          const doc = await send("DOM.getDocument", { depth: -1, pierce: true }).catch(() => null);
          if (doc?.root?.nodeId) {
            const found = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector }).catch(() => null);
            if (found?.nodeId) target = { nodeId: found.nodeId };
          }
          if (!target.nodeId) {
            const object = await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` });
            if (object?.result?.objectId) {
              const node = await send("DOM.requestNode", { objectId: object.result.objectId }).catch(() => null);
              if (node?.nodeId) target = { nodeId: node.nodeId };
            }
          }
          if (!target.nodeId) {
            const described = await send("Runtime.evaluate", { expression: readBack, returnByValue: true });
            return { ok: false, error: "the debugger found the input but could not hand it a node, so the file was not set", tabId, selector, input: described?.result?.value };
          }
          const pushed = await send("DOM.setFileInputFiles", { files, ...target }).catch((e) => ({ error: String(e?.message || e) }));
          if (pushed?.error) return { ok: false, error: `setFileInputFiles failed: ${pushed.error}`, tabId, selector };
          const after = await send("Runtime.evaluate", { expression: readBack, returnByValue: true });
          const set = after?.result?.value || {};
          return { ok: set.files > 0, tabId, selector, files: files.length, accepted: set.files || 0, names: set.names, inputWasHidden: info.visible === false, via: target.backendNodeId ? "backendNodeId" : "nodeId" };
        });
      } catch (e) {
        return { ok: false, error: attachError(e), tabId };
      }
    }
    case "visible": {
      if (!tabId) throw new Error("no tab");
      if (cmd.on === false) return await releaseSticky(tabId);
      let state = STICKY.get(tabId);
      if (!state) {
        try {
          await chrome.debugger.attach({ tabId }, CDP_PROTOCOL);
        } catch (e) {
          const message = attachError(e);
          if (!message.includes("Already attached")) return { ok: false, error: `visible could not attach: ${message}`, tabId };
        }
        state = { paint: false, spoof: false, overrideId: "", attachedAt: Date.now() };
        STICKY.set(tabId, state);
      }
      const send = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
      const probe = {};
      await send("Page.enable").catch((e) => (probe.pageEnable = attachError(e)));
      probe.focusEmulation = await send("Emulation.setFocusEmulationEnabled", { enabled: true })
        .then(() => "on")
        .catch((e) => attachError(e));
      probe.lifecycle = await send("Page.setWebLifecycleState", { state: "active" })
        .then(() => "active")
        .catch((e) => attachError(e));
      if (cmd.paint) {
        await startPaint(tabId, send);
        state.paint = true;
      }
      probe.paint = state.paint ? "screencast" : "off";
      if (cmd.spoof) {
        if (!state.overrideId) {
          const registered = await send("Page.addScriptToEvaluateOnNewDocument", { source: VISIBILITY_OVERRIDE }).catch((e) => ({ error: attachError(e) }));
          if (registered?.identifier) {
            state.overrideId = registered.identifier;
            state.spoof = true;
            probe.override = "registered for the next navigation";
          } else probe.override = registered.error || "failed";
        } else probe.override = "already registered";
        await send("Runtime.evaluate", { expression: VISIBILITY_OVERRIDE }).catch((e) => (probe.override = attachError(e)));
      }
      probe.visibilityState = await send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true })
        .then((r) => r?.result?.value)
        .catch((e) => attachError(e));
      probe.hasFocus = await send("Runtime.evaluate", { expression: "document.hasFocus()", returnByValue: true })
        .then((r) => r?.result?.value)
        .catch((e) => attachError(e));
      // Portals that measure themselves in a frame only mount when frames advance,
      // so this is the number that decides whether the tab behaves as visible.
      probe.frames = await send("Runtime.evaluate", {
        expression: `(function(){return new Promise(function(res){var t=Date.now();requestAnimationFrame(function(){res("frame after "+(Date.now()-t)+"ms")});setTimeout(function(){res("no frame in 900ms")},900)})})()`,
        awaitPromise: true,
        returnByValue: true,
      })
        .then((r) => r?.result?.value)
        .catch((e) => attachError(e));
      await persistSticky();
      return { ok: true, tabId, sticky: true, heldFor: Math.round((Date.now() - state.attachedAt) / 1000), ...probe };
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
      payload = await withTimeout(run(cmd), deadlineFor(cmd), `the ${cmd.cmd} command`);
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
