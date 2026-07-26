const POPULAR_PROVIDERS = [
  "drive",
  "dropbox",
  "onedrive",
  "s3",
  "b2",
  "local",
  "sftp",
  "webdav",
  "box",
  "mega",
  "pcloud",
  "ftp",
  "crypt",
];

const remoteManager = {
  dialog: document.getElementById("remote-manager-dialog"),
  configPath: document.getElementById("remote-manager-config-path"),
  list: document.getElementById("remote-list"),
  listEmpty: document.getElementById("remote-list-empty"),
  panelEmpty: document.getElementById("remote-panel-empty"),
  panelDetail: document.getElementById("remote-panel-detail"),
  panelAdd: document.getElementById("remote-panel-add"),
  detailName: document.getElementById("remote-detail-name"),
  detailType: document.getElementById("remote-detail-type"),
  detailConfig: document.getElementById("remote-detail-config"),
  createName: document.getElementById("remote-create-name"),
  providerSearch: document.getElementById("remote-provider-search"),
  providerSelect: document.getElementById("remote-provider-select"),
  providerDescription: document.getElementById("remote-provider-description"),
  providerForm: document.getElementById("remote-provider-form"),
  showAdvanced: document.getElementById("remote-show-advanced"),
  createError: document.getElementById("remote-create-error"),
  authorizeBtn: document.getElementById("remote-authorize-btn"),
  addBtn: document.getElementById("remote-add-btn"),
  refreshBtn: document.getElementById("remote-refresh-btn"),
  reconnectBtn: document.getElementById("remote-reconnect-btn"),
  deleteBtn: document.getElementById("remote-delete-btn"),
  createCancelBtn: document.getElementById("remote-create-cancel"),
  createSubmitBtn: document.getElementById("remote-create-submit"),
  openWizardBtn: document.getElementById("remote-open-wizard-btn"),
  closeBtn: document.getElementById("remote-manager-close"),
};

let remoteEntries = [];
let providers = [];
let selectedRemoteName = null;
let onRemotesChanged = null;
let busy = false;

function setBusy(nextBusy) {
  busy = nextBusy;
  const controls = [
    remoteManager.addBtn,
    remoteManager.refreshBtn,
    remoteManager.reconnectBtn,
    remoteManager.deleteBtn,
    remoteManager.createCancelBtn,
    remoteManager.createSubmitBtn,
    remoteManager.authorizeBtn,
    remoteManager.openWizardBtn,
  ];

  for (const control of controls) {
    if (control) {
      control.disabled = nextBusy;
    }
  }
}

function showCreateError(message = "") {
  if (!message) {
    remoteManager.createError.textContent = "";
    remoteManager.createError.classList.add("hidden");
    return;
  }

  remoteManager.createError.textContent = message;
  remoteManager.createError.classList.remove("hidden");
}

function showPanel(mode) {
  remoteManager.panelEmpty.classList.toggle("hidden", mode !== "empty");
  remoteManager.panelDetail.classList.toggle("hidden", mode !== "detail");
  remoteManager.panelAdd.classList.toggle("hidden", mode !== "add");
}

function renderRemoteList() {
  remoteManager.list.innerHTML = "";
  remoteManager.listEmpty.classList.toggle("hidden", remoteEntries.length > 0);

  for (const entry of remoteEntries) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `remote-list-item${entry.name === selectedRemoteName ? " is-selected" : ""}`;
    button.dataset.remoteName = entry.name;

    const name = document.createElement("span");
    name.className = "remote-list-item-name";
    name.textContent = entry.name;

    const type = document.createElement("span");
    type.className = "remote-type-badge";
    type.textContent = entry.type;

    button.append(name, type);
    button.addEventListener("click", () => {
      void selectRemote(entry.name);
    });

    item.appendChild(button);
    remoteManager.list.appendChild(item);
  }
}

async function selectRemote(name) {
  selectedRemoteName = name;
  renderRemoteList();
  showPanel("detail");
  remoteManager.detailName.textContent = name;
  remoteManager.detailType.textContent = "…";
  remoteManager.detailConfig.textContent = "Loading remote settings…";

  try {
    const entry = remoteEntries.find((item) => item.name === name);
    remoteManager.detailType.textContent = entry?.type || "unknown";
    remoteManager.detailConfig.textContent = await window.rcloneGui.getRemoteRedacted(name);
  } catch (error) {
    remoteManager.detailConfig.textContent = error.message || "Could not load remote settings.";
  }
}

function sortProviders(items) {
  return [...items].sort((left, right) => {
    const leftPopular = POPULAR_PROVIDERS.indexOf(left.Name);
    const rightPopular = POPULAR_PROVIDERS.indexOf(right.Name);
    const leftRank = leftPopular === -1 ? Number.MAX_SAFE_INTEGER : leftPopular;
    const rightRank = rightPopular === -1 ? Number.MAX_SAFE_INTEGER : rightPopular;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.Name.localeCompare(right.Name);
  });
}

function getFilteredProviders() {
  const query = remoteManager.providerSearch.value.trim().toLowerCase();
  const sorted = sortProviders(providers);

  if (!query) {
    return sorted;
  }

  return sorted.filter((provider) => {
    const haystack = `${provider.Name} ${provider.Description || ""}`.toLowerCase();
    return haystack.includes(query);
  });
}

function renderProviderOptions() {
  const filtered = getFilteredProviders();
  const current = remoteManager.providerSelect.value;
  remoteManager.providerSelect.innerHTML = "";

  for (const provider of filtered) {
    const option = document.createElement("option");
    option.value = provider.Name;
    option.textContent = POPULAR_PROVIDERS.includes(provider.Name)
      ? `${provider.Name} — ${provider.Description || "Popular provider"}`
      : `${provider.Name} — ${provider.Description || "Remote provider"}`;
    remoteManager.providerSelect.appendChild(option);
  }

  if (filtered.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No providers match your search";
    remoteManager.providerSelect.appendChild(option);
  } else if (filtered.some((provider) => provider.Name === current)) {
    remoteManager.providerSelect.value = current;
  } else {
    remoteManager.providerSelect.selectedIndex = 0;
  }

  renderProviderForm();
}

function getSelectedProvider() {
  const name = remoteManager.providerSelect.value;
  return providers.find((provider) => provider.Name === name) || null;
}

function shouldShowOption(option) {
  if (!option || option.Hide) {
    return false;
  }

  if (option.Name === "type") {
    return false;
  }

  if (option.Required) {
    return true;
  }

  if (remoteManager.showAdvanced.checked) {
    return true;
  }

  return !option.Advanced;
}

function optionNeedsAuthorize(provider) {
  return provider?.Options?.some((option) => option.Name === "token") ?? false;
}

function renderProviderForm() {
  const provider = getSelectedProvider();
  remoteManager.providerForm.innerHTML = "";
  showCreateError("");

  if (!provider) {
    remoteManager.providerDescription.textContent = "";
    remoteManager.authorizeBtn.classList.add("hidden");
    return;
  }

  remoteManager.providerDescription.textContent = provider.Description || "";
  remoteManager.authorizeBtn.classList.toggle("hidden", !optionNeedsAuthorize(provider));

  for (const option of provider.Options || []) {
    if (!shouldShowOption(option)) {
      continue;
    }

    const field = document.createElement("label");
    field.className = "field remote-option-field";
    field.dataset.optionName = option.Name;

    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = option.Name.replace(/_/g, " ");
    if (option.Required) {
      label.textContent += " *";
    }
    field.appendChild(label);

    let input;
    if (option.Examples?.length) {
      input = document.createElement("select");
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = option.DefaultStr ? `Default (${option.DefaultStr})` : "Select…";
      input.appendChild(emptyOption);

      for (const example of option.Examples) {
        const exampleOption = document.createElement("option");
        exampleOption.value = example.Value;
        exampleOption.textContent = example.Help ? `${example.Value} — ${example.Help}` : example.Value;
        input.appendChild(exampleOption);
      }
    } else if (option.Type === "bool") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = option.Default === true || option.DefaultStr === "true";
    } else {
      input = document.createElement("input");
      input.type = option.IsPassword ? "password" : "text";
      if (option.DefaultStr) {
        input.placeholder = `Default: ${option.DefaultStr}`;
      }
    }

    input.id = `remote-option-${option.Name}`;
    input.name = option.Name;
    input.className = "remote-option-input";
    field.appendChild(input);

    if (option.Help) {
      const hint = document.createElement("span");
      hint.className = "remote-option-help";
      hint.textContent = option.Help.split("\n").join(" ");
      field.appendChild(hint);
    }

    remoteManager.providerForm.appendChild(field);
  }
}

function collectCreateOptions() {
  const options = {};

  for (const field of remoteManager.providerForm.querySelectorAll(".remote-option-field")) {
    const name = field.dataset.optionName;
    const input = field.querySelector(".remote-option-input");
    if (!input || !name) {
      continue;
    }

    if (input.type === "checkbox") {
      options[name] = input.checked;
      continue;
    }

    const value = input.value.trim();
    if (value) {
      options[name] = value;
    }
  }

  return options;
}

function fillTokenField(tokenText) {
  const tokenInput = remoteManager.providerForm.querySelector('[name="token"]');
  if (tokenInput && tokenText) {
    tokenInput.value = tokenText.trim();
  }
}

async function refreshRemotes({ keepSelection = true } = {}) {
  setBusy(true);

  try {
    remoteEntries = await window.rcloneGui.listRemoteEntries();
    const previous = keepSelection ? selectedRemoteName : null;
    renderRemoteList();

    if (previous && remoteEntries.some((entry) => entry.name === previous)) {
      await selectRemote(previous);
    } else if (remoteEntries.length === 0) {
      selectedRemoteName = null;
      showPanel("empty");
    } else if (!remoteManager.panelAdd.classList.contains("hidden")) {
      showPanel("add");
    } else {
      selectedRemoteName = null;
      showPanel("empty");
    }

    if (typeof onRemotesChanged === "function") {
      await onRemotesChanged(remoteEntries.map((entry) => entry.name));
    }
  } finally {
    setBusy(false);
  }
}

async function loadProviders() {
  providers = await window.rcloneGui.getConfigProviders();
  renderProviderOptions();
}

async function openRemoteManager({ onChanged } = {}) {
  if (!window.rcloneGui) {
    return;
  }

  onRemotesChanged = onChanged || null;
  selectedRemoteName = null;
  showCreateError("");
  showPanel("empty");
  remoteManager.providerSearch.value = "";
  remoteManager.createName.value = "";
  remoteManager.showAdvanced.checked = false;
  remoteManager.dialog.classList.remove("hidden");
  remoteManager.dialog.setAttribute("aria-hidden", "false");
  remoteManager.addBtn.focus();

  setBusy(true);
  try {
    const [configPath] = await Promise.all([
      window.rcloneGui.getConfigFilePath(),
      loadProviders(),
      refreshRemotes({ keepSelection: false }),
    ]);
    remoteManager.configPath.textContent = configPath ? `Config: ${configPath}` : "";
  } catch (error) {
    remoteManager.configPath.textContent = error.message || "Could not load rclone config.";
  } finally {
    setBusy(false);
  }
}

function closeRemoteManager() {
  remoteManager.dialog.classList.add("hidden");
  remoteManager.dialog.setAttribute("aria-hidden", "true");
  showCreateError("");
  selectedRemoteName = null;
}

function beginAddRemote() {
  selectedRemoteName = null;
  renderRemoteList();
  showPanel("add");
  showCreateError("");
  remoteManager.createName.value = "";
  remoteManager.providerSearch.value = "";
  remoteManager.showAdvanced.checked = false;
  renderProviderOptions();
  remoteManager.createName.focus();
}

async function submitCreateRemote() {
  const provider = getSelectedProvider();
  const name = remoteManager.createName.value.trim();
  showCreateError("");

  if (!name) {
    showCreateError("Enter a name for the remote.");
    return;
  }

  if (!provider) {
    showCreateError("Select a provider.");
    return;
  }

  setBusy(true);
  try {
    remoteEntries = await window.rcloneGui.createRemote({
      name,
      type: provider.Name,
      options: collectCreateOptions(),
    });
    selectedRemoteName = name;
    renderRemoteList();
    showPanel("detail");
    await selectRemote(name);

    if (typeof onRemotesChanged === "function") {
      await onRemotesChanged(remoteEntries.map((entry) => entry.name));
    }
  } catch (error) {
    showCreateError(error.message || "Could not create remote.");
  } finally {
    setBusy(false);
  }
}

async function authorizeSelectedProvider() {
  const provider = getSelectedProvider();
  if (!provider) {
    showCreateError("Select a provider first.");
    return;
  }

  setBusy(true);
  showCreateError("");
  try {
    const token = await window.rcloneGui.authorizeProvider(provider.Name);
    fillTokenField(token);
  } catch (error) {
    showCreateError(error.message || "Authorization failed.");
  } finally {
    setBusy(false);
  }
}

async function deleteSelectedRemote() {
  if (!selectedRemoteName) {
    return;
  }

  const confirmed = window.confirm(`Delete remote "${selectedRemoteName}"? This cannot be undone.`);
  if (!confirmed) {
    return;
  }

  setBusy(true);
  try {
    remoteEntries = await window.rcloneGui.deleteRemote(selectedRemoteName);
    selectedRemoteName = null;
    renderRemoteList();
    showPanel("empty");

    if (typeof onRemotesChanged === "function") {
      await onRemotesChanged(remoteEntries.map((entry) => entry.name));
    }
  } catch (error) {
    window.alert(error.message || "Could not delete remote.");
  } finally {
    setBusy(false);
  }
}

async function reconnectSelectedRemote() {
  if (!selectedRemoteName) {
    return;
  }

  setBusy(true);
  try {
    await window.rcloneGui.reconnectRemote(selectedRemoteName);
    await selectRemote(selectedRemoteName);
  } catch (error) {
    window.alert(error.message || "Could not reconnect remote.");
  } finally {
    setBusy(false);
  }
}

remoteManager.addBtn.addEventListener("click", beginAddRemote);
remoteManager.refreshBtn.addEventListener("click", () => {
  void refreshRemotes();
});
remoteManager.createCancelBtn.addEventListener("click", () => {
  showCreateError("");
  if (selectedRemoteName) {
    void selectRemote(selectedRemoteName);
    return;
  }

  showPanel("empty");
});
remoteManager.createSubmitBtn.addEventListener("click", () => {
  void submitCreateRemote();
});
remoteManager.authorizeBtn.addEventListener("click", () => {
  void authorizeSelectedProvider();
});
remoteManager.deleteBtn.addEventListener("click", () => {
  void deleteSelectedRemote();
});
remoteManager.reconnectBtn.addEventListener("click", () => {
  void reconnectSelectedRemote();
});
remoteManager.openWizardBtn.addEventListener("click", () => {
  void window.rcloneGui.openRcloneConfig();
});
remoteManager.closeBtn.addEventListener("click", closeRemoteManager);
remoteManager.providerSearch.addEventListener("input", renderProviderOptions);
remoteManager.providerSelect.addEventListener("change", renderProviderForm);
remoteManager.showAdvanced.addEventListener("change", renderProviderForm);

for (const closer of remoteManager.dialog.querySelectorAll("[data-remote-manager-close]")) {
  closer.addEventListener("click", closeRemoteManager);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !remoteManager.dialog.classList.contains("hidden")) {
    closeRemoteManager();
  }
});

window.RemoteManager = {
  open: openRemoteManager,
  close: closeRemoteManager,
};
