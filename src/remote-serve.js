const remoteServe = {
  section: document.getElementById("remote-serve"),
  status: document.getElementById("remote-serve-status"),
  protocol: document.getElementById("remote-serve-protocol"),
  port: document.getElementById("remote-serve-port"),
  folder: document.getElementById("remote-serve-folder"),
  user: document.getElementById("remote-serve-user"),
  pass: document.getElementById("remote-serve-pass"),
  cache: document.getElementById("remote-serve-cache"),
  readOnly: document.getElementById("remote-serve-readonly"),
  network: document.getElementById("remote-serve-network"),
  startBtn: document.getElementById("remote-serve-btn"),
  hint: document.getElementById("remote-serve-hint"),
  list: document.getElementById("remote-serve-list"),
};

const COPIED_FEEDBACK_MS = 1500;

let serveStatus = null;
let serveRemoteName = null;
let serveError = "";
let servePending = false;
let lastDefaultPort = "";

function serveIpcError(error, fallback) {
  const message = String(error?.message || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  return message || fallback;
}

function selectedProtocol() {
  return serveStatus?.protocols?.find((item) => item.id === remoteServe.protocol.value) || null;
}

function renderProtocolOptions() {
  const protocols = serveStatus?.protocols || [];
  if (remoteServe.protocol.options.length === protocols.length) {
    return;
  }

  const previous = remoteServe.protocol.value;
  remoteServe.protocol.innerHTML = "";
  for (const item of protocols) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    remoteServe.protocol.appendChild(option);
  }
  if (protocols.some((item) => item.id === previous)) {
    remoteServe.protocol.value = previous;
  }
  applyDefaultPort();
}

function applyDefaultPort() {
  const protocol = selectedProtocol();
  if (!protocol) {
    return;
  }

  const current = remoteServe.port.value.trim();
  const nextDefault = String(protocol.defaultPort);
  if (!current || current === lastDefaultPort) {
    remoteServe.port.value = nextDefault;
  }
  remoteServe.port.placeholder = nextDefault;
  lastDefaultPort = nextDefault;
}

function portProblem() {
  const text = remoteServe.port.value.trim();
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) {
    return "The port has to be a number between 1 and 65535.";
  }
  if ((serveStatus?.serves || []).some((serve) => serve.port === Number(text))) {
    return `Port ${text} is already used by another serve.`;
  }
  return "";
}

function credentialsProblem() {
  const protocol = selectedProtocol();
  const hasUser = Boolean(remoteServe.user.value.trim());
  const hasPass = Boolean(remoteServe.pass.value);
  if (protocol?.requiresAuth && !(hasUser && hasPass)) {
    return `${protocol.label} needs a username and password.`;
  }
  if (hasPass && !hasUser) {
    return "Add a username to go with the password.";
  }
  if (hasUser && !hasPass) {
    return "Add a password to go with the username.";
  }
  return "";
}

function folderProblem() {
  const parts = remoteServe.folder.value.replace(/\\/g, "/").split("/");
  return parts.includes("..") ? "The folder can't contain \"..\"." : "";
}

function formProblem() {
  return portProblem() || folderProblem() || credentialsProblem();
}

function describeAccess() {
  if (!remoteServe.network.checked) {
    return "Only this computer can connect. Tick the network box to let your phone, TV or other PCs in.";
  }

  const warnings = ["Other devices on your network can connect."];
  if (!remoteServe.user.value.trim()) {
    warnings.push("Without a username and password anyone on the network gets in.");
  }
  if (!remoteServe.readOnly.checked) {
    warnings.push("Read-only is off, so they can change and delete files too.");
  }
  return warnings.join(" ");
}

function serveTargetLabel(serve) {
  return serve.path ? `${serve.remote}:${serve.path}` : `${serve.remote}:`;
}

function serveMeta(serve) {
  return [
    serve.readOnly ? "read-only" : "read & write",
    serve.network ? "network" : "this computer only",
    serve.user ? `user ${serve.user}` : "no login",
    `${serve.cacheMode} cache`,
  ].join(" · ");
}

function createServeButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function copyServeUrl(serve, button) {
  try {
    await navigator.clipboard.writeText(serve.url);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy URL";
    }, COPIED_FEEDBACK_MS);
  } catch {
    serveError = "Could not copy the URL to the clipboard.";
    renderServePanel();
  }
}

async function openServe(serve) {
  try {
    await window.rcloneGui.openServe(serve.id);
  } catch (error) {
    serveError = serveIpcError(error, "Could not open the serve.");
    renderServePanel();
  }
}

async function stopServe(serve, button) {
  button.disabled = true;
  serveError = "";
  try {
    serveStatus = await window.rcloneGui.stopServe(serve.id);
  } catch (error) {
    serveError = serveIpcError(error, "Could not stop the serve.");
  }
  renderServePanel();
}

function renderServeItem(serve) {
  const item = document.createElement("li");
  item.className = "remote-serve-item";

  const info = document.createElement("div");
  info.className = "remote-serve-item-info";

  const title = document.createElement("div");
  title.className = "remote-serve-item-title";
  const badge = document.createElement("span");
  badge.className = "remote-mount-badge remote-serve-badge";
  badge.textContent = serve.label;
  const target = document.createElement("span");
  target.className = "remote-serve-item-target";
  target.textContent = serveTargetLabel(serve);
  title.append(badge, target);

  const url = document.createElement("code");
  url.className = "remote-serve-item-url";
  url.textContent = serve.url;

  const meta = document.createElement("span");
  meta.className = "remote-serve-item-meta";
  meta.textContent = serveMeta(serve);

  info.append(title, url, meta);

  const actions = document.createElement("div");
  actions.className = "remote-serve-item-actions";
  const copyBtn = createServeButton("Copy URL", "secondary", () => {
    void copyServeUrl(serve, copyBtn);
  });
  actions.appendChild(copyBtn);
  if (serve.browsable) {
    actions.appendChild(createServeButton("Open", "secondary", () => {
      void openServe(serve);
    }));
  }
  const stopBtn = createServeButton("Stop", "danger", () => {
    void stopServe(serve, stopBtn);
  });
  actions.appendChild(stopBtn);

  item.append(info, actions);
  return item;
}

function renderServeList() {
  const running = serveStatus?.serves || [];
  remoteServe.list.innerHTML = "";
  remoteServe.list.classList.toggle("hidden", running.length === 0);
  for (const serve of running) {
    remoteServe.list.appendChild(renderServeItem(serve));
  }

  remoteServe.status.textContent = running.length ? `${running.length} running` : "";
  remoteServe.status.classList.toggle("is-mounted", running.length > 0);
}

function renderServePanel() {
  if (!serveRemoteName || !serveStatus) {
    remoteServe.section.classList.add("hidden");
    return;
  }

  remoteServe.section.classList.remove("hidden");
  renderProtocolOptions();
  renderServeList();
  renderServeForm();
}

function renderServeForm() {
  const problem = formProblem();
  const warning = serveError || problem;
  remoteServe.hint.textContent = warning || describeAccess();
  remoteServe.hint.classList.toggle("is-error", Boolean(warning));
  remoteServe.startBtn.textContent = servePending ? "Starting…" : "Start serving";
  remoteServe.startBtn.disabled = servePending || Boolean(problem);
}

async function refreshServeStatus() {
  if (!window.rcloneGui?.getServeStatus) {
    return;
  }

  try {
    serveStatus = await window.rcloneGui.getServeStatus();
  } catch {
    serveStatus = null;
  }
  renderServePanel();
}

async function startServeForRemote() {
  const problem = formProblem();
  if (!serveRemoteName || problem) {
    serveError = problem;
    renderServePanel();
    return;
  }

  serveError = "";
  servePending = true;
  renderServePanel();
  try {
    serveStatus = await window.rcloneGui.startServe({
      remote: serveRemoteName,
      folder: remoteServe.folder.value,
      protocol: remoteServe.protocol.value,
      port: remoteServe.port.value.trim(),
      network: remoteServe.network.checked,
      user: remoteServe.user.value.trim(),
      pass: remoteServe.pass.value,
      readOnly: remoteServe.readOnly.checked,
      cacheMode: remoteServe.cache.value,
    });
  } catch (error) {
    serveError = serveIpcError(error, "Could not start the serve.");
  } finally {
    servePending = false;
    renderServePanel();
  }
}

function showServePanel(name) {
  if (name !== serveRemoteName) {
    serveError = "";
    remoteServe.folder.value = "";
  }
  serveRemoteName = name;
  renderServePanel();
  void refreshServeStatus();
}

function hideServePanel() {
  serveRemoteName = null;
  serveError = "";
  remoteServe.pass.value = "";
  remoteServe.section.classList.add("hidden");
}

function isRemoteServed(name) {
  return (serveStatus?.serves || []).some((serve) => serve.remote === name);
}

const clearServeErrorAndRender = () => {
  serveError = "";
  renderServeForm();
};

remoteServe.protocol.addEventListener("change", () => {
  applyDefaultPort();
  clearServeErrorAndRender();
});
for (const input of [remoteServe.port, remoteServe.folder, remoteServe.user, remoteServe.pass]) {
  input.addEventListener("input", clearServeErrorAndRender);
}
for (const toggle of [remoteServe.readOnly, remoteServe.network]) {
  toggle.addEventListener("change", clearServeErrorAndRender);
}
remoteServe.startBtn.addEventListener("click", () => {
  void startServeForRemote();
});
remoteServe.folder.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    void startServeForRemote();
  }
});

window.rcloneGui?.onServesChanged?.((payload) => {
  if (serveStatus && Array.isArray(payload?.serves)) {
    serveStatus = { ...serveStatus, serves: payload.serves };
  }
  if (payload?.event?.unexpected) {
    serveError = `The ${payload.event.label} serve on port ${payload.event.port} stopped unexpectedly: ${payload.event.message}`;
  }
  if (serveRemoteName) {
    renderServePanel();
  }
});

window.RemoteServe = {
  show: showServePanel,
  hide: hideServePanel,
  isServing: isRemoteServed,
};
