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

// Mirrors rclone's matchProvider(), with one UI tweak: options gated on a nested
// provider stay hidden until that provider is chosen (avoids triple password fields).
function matchProvider(providerConfig, nestedProvider) {
  if (!providerConfig) {
    return true;
  }

  if (!nestedProvider) {
    return false;
  }

  let config = String(providerConfig);
  let negate = false;
  if (config.startsWith("!")) {
    negate = true;
    config = config.slice(1);
  }

  const matched = config
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(nestedProvider);

  return negate ? !matched : matched;
}

function getNestedProviderValue(provider, previousValues = {}) {
  if (Object.prototype.hasOwnProperty.call(previousValues, "provider")) {
    return String(previousValues.provider || "");
  }

  const existing = remoteManager.providerForm.querySelector('[name="provider"]');
  if (existing?.value) {
    return existing.value;
  }

  const providerOption = (provider?.Options || []).find((option) => option.Name === "provider");
  if (!providerOption) {
    return "";
  }

  if (providerOption.DefaultStr) {
    return providerOption.DefaultStr;
  }

  const firstExample = (providerOption.Examples || []).find((example) => example.Value);
  return firstExample?.Value || "";
}

function endpointFromProviderHelp(provider, nestedProvider) {
  const providerOption = (provider?.Options || []).find((option) => option.Name === "provider");
  const example = (providerOption?.Examples || []).find((item) => item.Value === nestedProvider);
  if (!example?.Help) {
    return "";
  }

  const match = String(example.Help).match(/https?:\/\/[^\s,)]+/i);
  return match ? match[0] : "";
}

function shouldShowOption(option, nestedProvider) {
  if (!option || option.Hide) {
    return false;
  }

  if (option.Name === "type") {
    return false;
  }

  if (!matchProvider(option.Provider, nestedProvider)) {
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

function hasToggleableAdvancedOptions(provider, nestedProvider) {
  return (provider?.Options || []).some((option) => {
    if (!option || option.Hide || option.Name === "type") {
      return false;
    }
    if (!option.Advanced || option.Required) {
      return false;
    }
    return matchProvider(option.Provider, nestedProvider);
  });
}

function createOptionInput(option, nestedProvider, previousValues) {
  let input;
  const previous = previousValues[option.Name];

  if (option.Examples?.length) {
    input = document.createElement("select");
    const examples = option.Examples.filter((example) => matchProvider(example.Provider, nestedProvider));

    if (!option.Exclusive && !option.Required) {
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = option.DefaultStr ? `Default (${option.DefaultStr})` : "Select…";
      input.appendChild(emptyOption);
    }

    for (const example of examples) {
      const exampleOption = document.createElement("option");
      exampleOption.value = example.Value;
      exampleOption.textContent = example.Help ? `${example.Value} — ${example.Help}` : example.Value;
      input.appendChild(exampleOption);
    }

    if (previous != null && previous !== "") {
      input.value = String(previous);
    } else if (option.Name === "provider" && nestedProvider) {
      input.value = nestedProvider;
    } else if (option.DefaultStr) {
      input.value = option.DefaultStr;
    } else if (option.Exclusive || option.Required) {
      const first = examples.find((example) => example.Value);
      if (first) {
        input.value = first.Value;
      }
    }
  } else if (option.Type === "bool") {
    input = document.createElement("input");
    input.type = "checkbox";
    if (typeof previous === "boolean") {
      input.checked = previous;
    } else {
      input.checked = option.Default === true || option.DefaultStr === "true";
    }
  } else {
    input = document.createElement("input");
    input.type = option.IsPassword ? "password" : option.Type === "string" && option.Name === "endpoint" ? "url" : "text";
    if (previous != null && previous !== "" && !option.IsPassword) {
      input.value = String(previous);
    } else if (option.DefaultStr && !option.IsPassword) {
      input.value = option.DefaultStr;
    } else if (option.DefaultStr) {
      input.placeholder = `Default: ${option.DefaultStr}`;
    }
  }

  input.id = `remote-option-${option.Name}`;
  input.name = option.Name;
  input.className = "remote-option-input";
  if (option.Name === "provider") {
    input.addEventListener("change", () => renderProviderForm());
  }

  return input;
}

function renderProviderForm() {
  const provider = getSelectedProvider();
  const previousValues = collectCreateOptions();
  remoteManager.providerForm.innerHTML = "";
  showCreateError("");

  if (!provider) {
    remoteManager.providerDescription.textContent = "";
    remoteManager.authorizeBtn.classList.add("hidden");
    remoteManager.showAdvanced?.closest(".remote-advanced-toggle")?.classList.add("hidden");
    return;
  }

  const nestedProvider = getNestedProviderValue(provider, previousValues);
  remoteManager.providerDescription.textContent = provider.Description || "";
  remoteManager.authorizeBtn.classList.toggle("hidden", !optionNeedsAuthorize(provider));

  const advancedToggle = remoteManager.showAdvanced?.closest(".remote-advanced-toggle");
  const showAdvancedToggle = hasToggleableAdvancedOptions(provider, nestedProvider);
  advancedToggle?.classList.toggle("hidden", !showAdvancedToggle);
  if (!showAdvancedToggle && remoteManager.showAdvanced) {
    remoteManager.showAdvanced.checked = false;
  }

  for (const option of provider.Options || []) {
    if (!shouldShowOption(option, nestedProvider)) {
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

    const input = createOptionInput(option, nestedProvider, previousValues);
    field.appendChild(input);

    if (option.Help) {
      const hint = document.createElement("span");
      hint.className = "remote-option-help";
      hint.textContent = option.Help.split("\n").join(" ");
      field.appendChild(hint);
    }

    remoteManager.providerForm.appendChild(field);
  }

  // Show the implied endpoint for providers like koofr/digistorage where rclone
  // fills it automatically and the endpoint option is hidden (Provider: other).
  const hasEndpointField = Boolean(remoteManager.providerForm.querySelector('[name="endpoint"]'));
  const impliedEndpoint = endpointFromProviderHelp(provider, nestedProvider);
  if (!hasEndpointField && impliedEndpoint) {
    const field = document.createElement("label");
    field.className = "field remote-option-field";
    field.dataset.optionName = "endpoint-display";

    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = "endpoint";
    field.appendChild(label);

    const input = document.createElement("input");
    input.type = "url";
    input.className = "remote-option-input";
    input.value = impliedEndpoint;
    input.disabled = true;
    input.readOnly = true;
    field.appendChild(input);

    const hint = document.createElement("span");
    hint.className = "remote-option-help";
    hint.textContent = "Filled automatically for this provider.";
    field.appendChild(hint);

    const providerField = remoteManager.providerForm.querySelector('[data-option-name="provider"]');
    if (providerField?.nextSibling) {
      remoteManager.providerForm.insertBefore(field, providerField.nextSibling);
    } else if (providerField) {
      providerField.after(field);
    } else {
      remoteManager.providerForm.prepend(field);
    }
  }
}

function collectCreateOptions() {
  const options = {};

  for (const field of remoteManager.providerForm.querySelectorAll(".remote-option-field")) {
    const name = field.dataset.optionName;
    const input = field.querySelector(".remote-option-input");
    if (!input || !name || input.disabled || name.endsWith("-display")) {
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
