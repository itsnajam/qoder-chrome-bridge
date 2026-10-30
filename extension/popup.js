const $ = (id) => document.getElementById(id);
const DEFAULT_PORT = 8791;

// Opening popup.html#reload restarts the extension, so an edited background.js
// takes effect without opening chrome://extensions. Useful while developing.
if (location.hash === "#reload") chrome.runtime.reload();

function render(state) {
  const on = !!state?.connected;
  $("dot").classList.toggle("on", on);
  if (!state?.paired) {
    $("label").textContent = "Not paired yet";
  } else if (on) {
    $("label").textContent = `Connected to ${state.bridge}`;
  } else {
    $("label").textContent = state.lastError ? "Bridge not reachable" : "Waiting for the bridge";
  }
  $("error").textContent = state?.lastError && !on ? `Last error: ${state.lastError}` : "";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, render);
}

async function load() {
  const { token = "", port = DEFAULT_PORT } = await chrome.storage.local.get({ token: "", port: DEFAULT_PORT });
  $("token").value = token;
  $("port").value = port;
}

$("save").addEventListener("click", async () => {
  const token = $("token").value.trim();
  const port = Number($("port").value) || DEFAULT_PORT;
  await chrome.storage.local.set({ token, port });
  $("saved").textContent = token ? "Saved. Connecting..." : "Saved, but the token is empty.";
  setTimeout(() => ($("saved").textContent = ""), 2500);
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600));
});

$("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 500));
});

load();
refresh();
setInterval(refresh, 2000);
