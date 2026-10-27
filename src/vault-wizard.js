(() => {
  const LOCAL = "__local__";
  const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
  const STRENGTH_LABELS = ["Too short", "Weak", "Okay", "Good", "Strong"];
  const GENERATED_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%+=";

  let state = null;
  let hooks = {};
  let container = null;
  let inspectTimer = null;
  let inspectToken = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text != null) {
      node.textContent = text;
    }
    return node;
  }

  function button(label, className, onClick) {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  function field(label, control, hint) {
    const wrap = el("label", "field vault-field");
    wrap.append(el("span", null, label), control);
    if (hint) {
      wrap.appendChild(el("small", "vault-hint", hint));
    }
    return wrap;
  }

  function cleanError(error, fallback) {
    return String(error?.message || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || fallback;
  }

  function existingNames() {
    return new Set((hooks.remotes || []).map((entry) => entry.name));
  }

  function storageRemotes() {
    return (hooks.remotes || []).filter((entry) => entry.type !== "crypt");
  }

  function suggestName() {
    const base = state.local ? "vault" : `${state.remote}-vault`.replace(/[^a-zA-Z0-9_-]/g, "-");
    const taken = existingNames();
    let candidate = base;
    for (let index = 2; taken.has(candidate); index += 1) {
      candidate = `${base}-${index}`;
    }
    return candidate;
  }

  function nameProblem() {
    if (!state.name) {
      return "Give the vault a name.";
    }
    if (!NAME_PATTERN.test(state.name)) {
      return "Use letters, numbers, _ or -, starting with a letter or number.";
    }
    if (existingNames().has(state.name)) {
      return `There's already a remote called "${state.name}".`;
    }
    return "";
  }

  function targetPayload() {
    return state.local ? { local: true, folder: state.folder } : { remote: state.remote, folder: state.folder };
  }

  function targetLabel() {
    if (state.local) {
      return state.folder || "a folder on this computer";
    }
    return `${state.remote}:${state.folder.replace(/^\/+|\/+$/g, "")}`;
  }

  function isExisting() {
    return Boolean(state.inspect.result?.looksLikeVault);
  }

  function strengthOf(password) {
    if (password.length < 8) {
      return 0;
    }
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((pattern) => pattern.test(password)).length;
    let score = 1;
    if (password.length >= 12) {
      score += 1;
    }
    if (password.length >= 16) {
      score += 1;
    }
    if (classes >= 3 || password.length >= 24) {
      score += 1;
    }
    if (/^(.)\1+$/.test(password) || /^(?:password|qwerty|12345678)/i.test(password)) {
      score = 1;
    }
    return Math.min(4, score);
  }

  function generatePassword() {
    const bytes = new Uint32Array(22);
    crypto.getRandomValues(bytes);
    return [...bytes].map((value) => GENERATED_CHARS[value % GENERATED_CHARS.length]).join("");
  }

  function scheduleInspect() {
    clearTimeout(inspectTimer);
    const token = ++inspectToken;
    if (state.local && !state.folder) {
      state.inspect = { status: "idle", result: null, error: "" };
      renderTargetNote();
      return;
    }
    state.inspect = { status: "checking", result: null, error: "" };
    renderTargetNote();
    inspectTimer = setTimeout(async () => {
      try {
        const result = await window.rcloneGui.inspectVaultTarget(targetPayload());
        if (token === inspectToken) {
          state.inspect = { status: "done", result, error: "" };
        }
      } catch (error) {
        if (token === inspectToken) {
          state.inspect = { status: "error", result: null, error: cleanError(error, "Couldn't check that folder.") };
        }
      }
      if (token === inspectToken) {
        renderTargetNote();
      }
    }, 450);
  }

  function renderStepper() {
    const list = el("ol", "vault-steps");
    ["Location", "Password", isExisting() ? "Unlock" : "Create"].forEach((label, index) => {
      const item = el("li", `vault-step${index === state.step ? " is-active" : index < state.step ? " is-done" : ""}`);
      item.append(el("span", "vault-step-number", index < state.step ? "✓" : String(index + 1)), el("span", "vault-step-label", label));
      if (index === state.step) {
        item.setAttribute("aria-current", "step");
      }
      list.appendChild(item);
    });
    return list;
  }

  function nav(back, next) {
    const row = el("div", "remote-add-actions vault-nav");
    state.refs.error = el("p", "remote-create-error hidden");
    row.append(...[back, next].filter(Boolean));
    return [state.refs.error, row];
  }

  function showError(message) {
    const node = state.refs.error;
    if (node) {
      node.textContent = message || "";
      node.classList.toggle("hidden", !message);
    }
  }

  function render() {
    state.refs = {};
    const title = el("h3", "remote-add-title vault-title", state.step === 3 ? "Vault ready" : isExisting() && state.step > 0 ? "Unlock an existing vault" : "New private vault");
    const body = [title];
    if (state.step < 3) {
      body.push(renderStepper());
    }
    body.push(...[locationStep, passwordStep, reviewStep, doneStep][state.step]());
    container.replaceChildren(...body);
    container.scrollTop = 0;
    updateNav();
  }

  function locationStep() {
    const intro = el(
      "p",
      "vault-intro",
      "A vault encrypts your files on this PC before they leave it, so the storage provider only ever sees scrambled data. It shows up as its own remote you can browse, sync and mount like any other.",
    );

    const location = el("select");
    for (const entry of storageRemotes()) {
      const option = el("option", null, `${entry.name} (${entry.type})`);
      option.value = entry.name;
      location.appendChild(option);
    }
    const local = el("option", null, "This computer");
    local.value = LOCAL;
    location.appendChild(local);
    location.value = state.local ? LOCAL : state.remote;
    location.addEventListener("change", () => {
      state.local = location.value === LOCAL;
      state.remote = state.local ? state.remote : location.value;
      state.folder = state.local ? "" : "vault";
      if (!state.nameTouched) {
        state.name = suggestName();
      }
      render();
      scheduleInspect();
    });

    let folderField;
    if (state.local) {
      const row = el("div", "vault-input-row");
      const input = el("input");
      input.type = "text";
      input.readOnly = true;
      input.placeholder = "No folder picked yet";
      input.value = state.folder;
      const pick = async () => {
        const folder = await window.rcloneGui.pickFolder();
        if (folder) {
          state.folder = folder;
          input.value = folder;
          scheduleInspect();
          updateNav();
        }
      };
      input.addEventListener("click", () => void pick());
      row.append(input, button("Browse", "secondary", () => void pick()));
      folderField = field("Folder", row, "The encrypted files go straight into this folder. An empty or new one works best.");
    } else {
      const input = el("input");
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "vault";
      input.value = state.folder;
      input.addEventListener("input", () => {
        state.folder = input.value.trim();
        scheduleInspect();
        updateNav();
      });
      folderField = field("Folder", input, `Where on ${state.remote} the encrypted files are kept. It's created if it doesn't exist yet.`);
    }

    const name = el("input");
    name.type = "text";
    name.autocomplete = "off";
    name.spellcheck = false;
    name.value = state.name;
    name.addEventListener("input", () => {
      state.name = name.value.trim();
      state.nameTouched = true;
      updateNav();
    });
    state.refs.nameHint = el("small", "vault-hint");
    const nameField = field("Vault name", name);
    nameField.appendChild(state.refs.nameHint);

    state.refs.targetNote = el("div", "vault-note");
    state.refs.targetNote.setAttribute("aria-live", "polite");
    renderTargetNote();

    state.refs.next = button("Next", "primary", () => {
      state.step = 1;
      render();
      state.refs.focus?.focus();
    });
    return [intro, field("Store it on", location), folderField, nameField, state.refs.targetNote, ...nav(button("Cancel", "secondary", cancel), state.refs.next)];
  }

  function renderTargetNote() {
    const note = state.refs?.targetNote;
    if (!note) {
      updateNav();
      return;
    }
    const { status, result, error } = state.inspect;
    let tone = "is-info";
    let text = "";
    if (status === "checking") {
      text = `Checking ${targetLabel()}…`;
    } else if (status === "error") {
      tone = "is-bad";
      text = error;
    } else if (status === "done" && result.state === "missing") {
      tone = "is-good";
      text = "This folder doesn't exist yet, it gets created for you.";
    } else if (status === "done" && result.state === "empty") {
      tone = "is-good";
      text = "This folder is empty. Good to go.";
    } else if (status === "done" && result.looksLikeVault) {
      text = "This folder already looks like a vault. Use the same passwords and settings you used when you made it, and it'll unlock.";
    } else if (status === "done") {
      tone = "is-warn";
      text = `This folder already has ${result.count} regular item${result.count === 1 ? "" : "s"}. Those stay unencrypted and won't show up inside the vault, so a new folder is usually the better pick.`;
    }
    note.className = `vault-note ${tone}${text ? "" : " hidden"}`;
    note.textContent = text;
    updateNav();
  }

  function passwordStep() {
    const existing = isExisting();
    const row = el("div", "vault-input-row");
    const password = el("input");
    password.type = state.reveal ? "text" : "password";
    password.autocomplete = "new-password";
    password.value = state.password;
    const reveal = button(state.reveal ? "Hide" : "Show", "secondary vault-small-btn", () => {
      state.reveal = !state.reveal;
      for (const input of [password, confirm, salt]) {
        input.type = state.reveal ? "text" : "password";
      }
      reveal.textContent = state.reveal ? "Hide" : "Show";
    });
    row.append(password, reveal);
    if (!existing) {
      row.appendChild(button("Generate", "secondary vault-small-btn", () => {
        state.password = generatePassword();
        state.confirm = state.password;
        state.reveal = true;
        render();
        state.refs.copy?.classList.remove("hidden");
      }));
      state.refs.copy = button("Copy", "secondary vault-small-btn hidden", async () => {
        try {
          await navigator.clipboard.writeText(state.password);
          state.refs.copy.textContent = "Copied";
          setTimeout(() => {
            if (state.refs.copy) {
              state.refs.copy.textContent = "Copy";
            }
          }, 1500);
        } catch {}
      });
      row.appendChild(state.refs.copy);
    }
    state.refs.focus = password;

    const meter = el("div", "vault-strength");
    const bars = el("div", "vault-strength-bars");
    bars.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 4; index += 1) {
      bars.appendChild(el("span", "vault-strength-bar"));
    }
    const strengthLabel = el("span", "vault-strength-label");
    meter.append(bars, strengthLabel);
    const paintStrength = () => {
      const score = strengthOf(state.password);
      meter.dataset.score = String(score);
      strengthLabel.textContent = state.password ? STRENGTH_LABELS[score] : "At least 8 characters";
    };
    paintStrength();

    const confirm = el("input");
    confirm.type = password.type;
    confirm.autocomplete = "new-password";
    confirm.value = state.confirm;
    state.refs.confirmHint = el("small", "vault-hint");
    const confirmField = field("Type it again", confirm);
    confirmField.appendChild(state.refs.confirmHint);

    password.addEventListener("input", () => {
      state.password = password.value;
      paintStrength();
      updateNav();
    });
    confirm.addEventListener("input", () => {
      state.confirm = confirm.value;
      updateNav();
    });

    const salt = el("input");
    salt.type = password.type;
    salt.autocomplete = "new-password";
    salt.value = state.password2;
    salt.addEventListener("input", () => {
      state.password2 = salt.value;
    });

    const hide = el("input");
    hide.type = "checkbox";
    hide.checked = state.hideNames;
    hide.addEventListener("change", () => {
      state.hideNames = hide.checked;
    });
    const hideLabel = el("label", "checkbox vault-check");
    hideLabel.append(hide, document.createTextNode("Hide file and folder names"));

    const more = el("details", "vault-more");
    if (existing || state.password2 || !state.hideNames) {
      more.open = true;
    }
    more.append(
      el("summary", null, existing ? "Vault settings" : "More options"),
      field(
        "Second password (optional)",
        salt,
        existing ? "Only if you set one when you made the vault." : "Rclone calls this a salt. It makes the vault harder to crack, but you'll need both passwords to get back in.",
      ),
      hideLabel,
      el("small", "vault-hint", existing
        ? "Match what you picked when you made the vault."
        : "Leave this on unless you need the real names visible on the provider. File contents are encrypted either way."),
    );

    const passwordField = field(existing ? "Vault password" : "Password", row);
    if (!existing) {
      passwordField.appendChild(meter);
    }

    state.refs.next = button("Next", "primary", () => {
      state.step = 2;
      render();
    });
    const parts = [passwordField];
    if (!existing) {
      parts.push(confirmField);
    }
    parts.push(more);
    return [...parts, ...nav(button("Back", "secondary", () => {
      state.step = 0;
      render();
    }), state.refs.next)];
  }

  function reviewStep() {
    const existing = isExisting();
    const summary = el("dl", "vault-summary");
    const rows = [
      ["Name", state.name],
      ["Encrypted files go to", targetLabel()],
      ["File names", state.hideNames ? "Hidden" : "Visible"],
      ["Second password", state.password2 ? "Set" : "Not set"],
    ];
    for (const [label, value] of rows) {
      const row = el("div", "vault-summary-row");
      row.append(el("dt", null, label), el("dd", null, value));
      summary.appendChild(row);
    }

    const parts = [summary];
    if (!existing) {
      const warning = el("div", "vault-note is-warn vault-warning");
      warning.append(
        el("strong", null, "There's no password reset."),
        document.createTextNode(" If you forget the password and lose this PC's rclone config, nobody can get these files back, not even rclone. Put it in a password manager now."),
      );
      const ack = el("input");
      ack.type = "checkbox";
      ack.checked = state.acknowledged;
      ack.addEventListener("change", () => {
        state.acknowledged = ack.checked;
        updateNav();
      });
      const ackLabel = el("label", "checkbox vault-check");
      ackLabel.append(ack, document.createTextNode("I've saved my password somewhere safe"));
      parts.push(warning, ackLabel);
    }

    state.refs.next = button(existing ? "Unlock vault" : "Create vault", "primary", () => void create());
    return [...parts, ...nav(button("Back", "secondary", () => {
      state.step = 1;
      render();
    }), state.refs.next)];
  }

  function doneStep() {
    const icon = el("div", "vault-done-icon", "🔒");
    icon.setAttribute("aria-hidden", "true");
    const text = el(
      "p",
      "vault-intro",
      `Anything you put in ${state.name} gets encrypted on the way in. Use it in jobs, browse it, or mount it as a drive from its settings.`,
    );
    const actions = el("div", "remote-add-actions vault-nav vault-done-actions");
    actions.append(
      button("Open settings", "secondary", () => hooks.onOpen?.(state.name)),
      button("Browse files", "primary", () => hooks.onBrowse?.(state.name)),
    );
    const done = el("div", "vault-done");
    done.append(icon, text);
    return [done, actions];
  }

  function updateNav() {
    if (!state?.refs) {
      return;
    }
    const next = state.refs.next;
    if (state.step === 0) {
      const problem = nameProblem();
      if (state.refs.nameHint) {
        state.refs.nameHint.textContent = problem && state.name ? problem : "This is what it's called in your remote list.";
        state.refs.nameHint.classList.toggle("is-bad", Boolean(problem && state.name));
      }
      const ready = !problem && state.inspect.status === "done" && (!state.local || state.folder);
      if (next) {
        next.disabled = state.busy || !ready;
      }
    } else if (state.step === 1) {
      const existing = isExisting();
      const mismatch = !existing && state.confirm && state.confirm !== state.password;
      if (state.refs.confirmHint) {
        state.refs.confirmHint.textContent = mismatch ? "The passwords don't match yet." : "";
        state.refs.confirmHint.classList.toggle("is-bad", Boolean(mismatch));
      }
      if (next) {
        next.disabled = state.password.length < 8 || (!existing && state.confirm !== state.password);
      }
    } else if (state.step === 2 && next) {
      next.disabled = state.busy || (!isExisting() && !state.acknowledged);
      next.textContent = state.busy ? (isExisting() ? "Unlocking…" : "Creating…") : isExisting() ? "Unlock vault" : "Create vault";
    }
  }

  async function create() {
    state.busy = true;
    showError("");
    updateNav();
    try {
      const result = await window.rcloneGui.createVault({
        ...targetPayload(),
        name: state.name,
        password: state.password,
        password2: state.password2,
        hideNames: state.hideNames,
      });
      state.password = "";
      state.confirm = "";
      state.password2 = "";
      state.busy = false;
      state.step = 3;
      render();
      await hooks.onCreated?.(result);
    } catch (error) {
      state.busy = false;
      showError(cleanError(error, "Couldn't create the vault."));
      updateNav();
    }
  }

  function cancel() {
    clearTimeout(inspectTimer);
    inspectToken += 1;
    state = null;
    hooks.onCancel?.();
  }

  function begin(options) {
    hooks = options || {};
    container = hooks.container;
    clearTimeout(inspectTimer);
    const first = storageRemotes()[0];
    state = {
      step: 0,
      local: !first,
      remote: first?.name || "",
      folder: first ? "vault" : "",
      name: "",
      nameTouched: false,
      password: "",
      confirm: "",
      password2: "",
      hideNames: true,
      reveal: false,
      acknowledged: false,
      busy: false,
      inspect: { status: "idle", result: null, error: "" },
      refs: {},
    };
    state.name = suggestName();
    render();
    scheduleInspect();
  }

  function reset() {
    clearTimeout(inspectTimer);
    inspectToken += 1;
    if (state) {
      state.password = "";
      state.confirm = "";
      state.password2 = "";
    }
    state = null;
  }

  window.VaultWizard = { begin, reset };
})();
