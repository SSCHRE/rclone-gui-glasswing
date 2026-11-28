(() => {
  const NATIVE_CLASS = "cs-native";
  const TRIGGER_CLASS = "cs-trigger";
  const POPUP_MAX_HEIGHT = 320;
  const EDGE_GAP = 8;
  const TYPE_AHEAD_MS = 700;

  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  const indexDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");
  const optionSelectedDescriptor = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, "selected");

  const byTrigger = new WeakMap();
  const bySelect = new WeakMap();
  let uid = 0;
  let current = null;
  let typeBuffer = "";
  let typeTimer = 0;

  function eligible(select) {
    if (select.multiple) {
      return false;
    }
    const size = Number(select.getAttribute("size"));
    if (size > 1) {
      return false;
    }
    return !select.classList.contains("op-select") && select.dataset.nativeSelect === undefined;
  }

  function labelIds(select) {
    const ids = [];
    for (const label of select.labels || []) {
      if (!label.id) {
        label.id = `cs-label-${++uid}`;
      }
      ids.push(label.id);
    }
    return ids;
  }

  function selectedLabel(select) {
    const option = select.options[select.selectedIndex];
    return option ? option.label : "";
  }

  function syncTrigger(inst) {
    const { select, trigger } = inst;
    const className = [...select.classList].filter((name) => name !== NATIVE_CLASS).join(" ");
    const wanted = `${className} ${TRIGGER_CLASS}`.trim();
    if (trigger.className !== wanted) {
      trigger.className = wanted;
    }
    const styleText = select.style.cssText;
    if (trigger.style.cssText !== styleText) {
      trigger.style.cssText = styleText;
    }
    trigger.hidden = select.hidden;
    trigger.disabled = select.matches(":disabled");

    const text = selectedLabel(select);
    if (inst.text.textContent !== text) {
      inst.text.textContent = text;
    }
    const tooltip = select.title || text;
    if (trigger.title !== tooltip) {
      trigger.title = tooltip;
    }

    const ariaLabel = select.getAttribute("aria-label");
    const ariaLabelledBy = select.getAttribute("aria-labelledby");
    const ids = ariaLabelledBy ? [ariaLabelledBy] : labelIds(select);
    if (ariaLabel && !ariaLabelledBy) {
      trigger.setAttribute("aria-label", ariaLabel);
      trigger.removeAttribute("aria-labelledby");
    } else if (ids.length) {
      trigger.removeAttribute("aria-label");
      trigger.setAttribute("aria-labelledby", `${ids.join(" ")} ${trigger.id}`);
    }

    if (current && current.inst === inst) {
      if (trigger.disabled || trigger.hidden || !trigger.isConnected) {
        closePopup(false);
      } else {
        renderOptions(current);
      }
    }
  }

  function observe(inst) {
    inst.observer.observe(inst.select, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function enhance(select) {
    if (bySelect.has(select)) {
      const inst = bySelect.get(select);
      if (!inst.trigger.isConnected) {
        select.after(inst.trigger);
      }
      observe(inst);
      syncTrigger(inst);
      return;
    }
    if (!eligible(select)) {
      return;
    }

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.id = `cs-trigger-${++uid}`;
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const text = document.createElement("span");
    text.className = "cs-trigger-text";
    trigger.append(text);

    const inst = { select, trigger, text, observer: null };
    bySelect.set(select, inst);
    byTrigger.set(trigger, inst);

    select.classList.add(NATIVE_CLASS);
    select.tabIndex = -1;
    select.after(trigger);

    Object.defineProperty(select, "value", {
      configurable: true,
      get() {
        return valueDescriptor.get.call(this);
      },
      set(next) {
        valueDescriptor.set.call(this, next);
        syncTrigger(inst);
      },
    });
    Object.defineProperty(select, "selectedIndex", {
      configurable: true,
      get() {
        return indexDescriptor.get.call(this);
      },
      set(next) {
        indexDescriptor.set.call(this, next);
        syncTrigger(inst);
      },
    });
    select.focus = (options) => trigger.focus(options);

    inst.observer = new MutationObserver(() => syncTrigger(inst));
    observe(inst);

    trigger.addEventListener("blur", () => {
      if (current && current.inst === inst) {
        closePopup(false);
      }
    });

    trigger.addEventListener("click", (event) => {
      if (event.detail === 0) {
        return;
      }
      if (current && current.inst === inst) {
        closePopup(true);
      } else {
        openPopup(inst);
      }
    });

    syncTrigger(inst);
  }

  Object.defineProperty(HTMLOptionElement.prototype, "selected", {
    configurable: true,
    get() {
      return optionSelectedDescriptor.get.call(this);
    },
    set(next) {
      optionSelectedDescriptor.set.call(this, next);
      const select = this.closest("select");
      const inst = select && bySelect.get(select);
      if (inst) {
        syncTrigger(inst);
      }
    },
  });

  function scan(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) {
      return;
    }
    if (root.nodeType === 1 && root.tagName === "SELECT") {
      enhance(root);
    }
    root.querySelectorAll?.("select").forEach(enhance);
  }

  function release(root) {
    if (root.nodeType !== 1) {
      return;
    }
    const selects = root.tagName === "SELECT" ? [root] : [...root.querySelectorAll("select")];
    for (const select of selects) {
      const inst = bySelect.get(select);
      if (inst && !select.isConnected) {
        if (current && current.inst === inst) {
          closePopup(false);
        }
        inst.observer.disconnect();
        inst.trigger.remove();
      }
    }
  }

  function buildItems(select) {
    const options = [...select.options];
    const rows = [];
    const add = (option, groupDisabled) => {
      if (!option.hidden) {
        rows.push({ option, index: options.indexOf(option), disabled: option.disabled || groupDisabled });
      }
    };
    for (const child of select.children) {
      if (child.tagName === "OPTGROUP") {
        rows.push({ group: child.label });
        for (const option of child.children) {
          if (option.tagName === "OPTION") {
            add(option, child.disabled);
          }
        }
      } else if (child.tagName === "OPTION") {
        add(child, false);
      }
    }
    return rows;
  }

  function renderOptions(state) {
    const { inst, popup } = state;
    const previousOption = state.items[state.active]?.option;
    const rows = buildItems(inst.select);
    popup.replaceChildren();
    state.items = [];
    state.elements = [];
    const selectedIndex = inst.select.selectedIndex;
    let group = null;

    for (const row of rows) {
      if (row.group !== undefined) {
        const label = document.createElement("div");
        label.className = "cs-group-label";
        label.setAttribute("role", "presentation");
        label.textContent = row.group;
        popup.append(label);
        group = label;
        continue;
      }
      const element = document.createElement("div");
      element.className = "cs-option context-menu-item";
      element.id = `${popup.id}-opt-${state.items.length}`;
      element.setAttribute("role", "option");
      const selected = row.index === selectedIndex;
      element.setAttribute("aria-selected", selected ? "true" : "false");
      if (row.disabled) {
        element.setAttribute("aria-disabled", "true");
      }
      if (group) {
        element.classList.add("cs-in-group");
      }
      const check = document.createElement("span");
      check.className = "cs-check";
      check.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "cs-option-text";
      label.textContent = row.option.label || " ";
      element.title = row.option.label;
      element.append(check, label);
      element.dataset.csIndex = String(state.items.length);
      popup.append(element);
      state.items.push(row);
      state.elements.push(element);
    }

    let next = previousOption ? state.items.findIndex((item) => item.option === previousOption) : -1;
    if (next === -1) {
      next = state.items.findIndex((item) => item.index === selectedIndex);
    }
    if (next === -1 || state.items[next].disabled) {
      next = state.items.findIndex((item) => !item.disabled);
    }
    setActive(state, next, false);
    positionPopup(state);
  }

  function setActive(state, index, scroll) {
    state.elements.forEach((element, i) => element.classList.toggle("is-active", i === index));
    state.active = index;
    const element = state.elements[index];
    if (element) {
      state.inst.trigger.setAttribute("aria-activedescendant", element.id);
      if (scroll) {
        element.scrollIntoView({ block: "nearest" });
      }
    } else {
      state.inst.trigger.removeAttribute("aria-activedescendant");
    }
  }

  function positionPopup(state) {
    const { popup, inst } = state;
    const rect = inst.trigger.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = document.documentElement.clientHeight;

    popup.style.maxHeight = "none";
    popup.style.minWidth = `${Math.round(rect.width)}px`;
    popup.style.maxWidth = `${Math.max(viewWidth - EDGE_GAP * 2, 120)}px`;
    popup.style.left = "0px";
    popup.style.top = "0px";
    const naturalHeight = popup.offsetHeight;
    const width = popup.offsetWidth;

    const below = viewHeight - rect.bottom - EDGE_GAP - 4;
    const above = rect.top - EDGE_GAP - 4;
    const wanted = Math.min(naturalHeight, POPUP_MAX_HEIGHT);
    const openUp = below < wanted && above > below;
    const available = Math.max(openUp ? above : below, 80);
    const height = Math.min(wanted, available);

    popup.style.maxHeight = `${height}px`;
    popup.classList.toggle("is-above", openUp);
    const top = openUp ? rect.top - 4 - height : rect.bottom + 4;
    const left = Math.min(Math.max(rect.left, EDGE_GAP), Math.max(viewWidth - width - EDGE_GAP, EDGE_GAP));
    popup.style.top = `${Math.round(top)}px`;
    popup.style.left = `${Math.round(left)}px`;
    popup.style.transformOrigin = openUp ? "bottom left" : "top left";
    state.elements[state.active]?.scrollIntoView({ block: "nearest" });
  }

  function openPopup(inst) {
    syncTrigger(inst);
    if (inst.trigger.disabled || inst.trigger.hidden) {
      return;
    }
    closePopup(false);
    const popup = document.createElement("div");
    popup.className = "cs-popup context-menu-card";
    popup.id = `cs-popup-${++uid}`;
    popup.setAttribute("role", "listbox");
    const ids = inst.trigger.getAttribute("aria-labelledby");
    if (ids) {
      popup.setAttribute("aria-labelledby", ids);
    } else if (inst.trigger.getAttribute("aria-label")) {
      popup.setAttribute("aria-label", inst.trigger.getAttribute("aria-label"));
    }
    const state = { inst, popup, items: [], elements: [], active: -1 };
    current = state;
    typeBuffer = "";
    document.body.append(popup);
    inst.trigger.setAttribute("aria-controls", popup.id);
    inst.trigger.setAttribute("aria-expanded", "true");
    renderOptions(state);

    popup.addEventListener("mousedown", (event) => event.preventDefault());
    popup.addEventListener("click", (event) => {
      const element = event.target.closest(".cs-option");
      if (!element || !popup.contains(element)) {
        return;
      }
      const item = state.items[Number(element.dataset.csIndex)];
      if (item && !item.disabled) {
        choose(state, item);
      }
    });
    popup.addEventListener("mouseover", (event) => {
      const element = event.target.closest(".cs-option");
      if (!element || element.getAttribute("aria-disabled") === "true") {
        return;
      }
      const index = Number(element.dataset.csIndex);
      if (index !== state.active) {
        setActive(state, index, false);
      }
    });
  }

  function closePopup(restoreFocus) {
    if (!current) {
      return;
    }
    const { inst, popup } = current;
    current = null;
    popup.remove();
    inst.trigger.setAttribute("aria-expanded", "false");
    inst.trigger.removeAttribute("aria-controls");
    inst.trigger.removeAttribute("aria-activedescendant");
    if (restoreFocus) {
      inst.trigger.focus({ preventScroll: true });
    }
  }

  function commit(inst, index) {
    const { select } = inst;
    if (index === select.selectedIndex) {
      return;
    }
    indexDescriptor.set.call(select, index);
    syncTrigger(inst);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function choose(state, item) {
    const { inst } = state;
    closePopup(true);
    commit(inst, item.index);
  }

  function move(state, from, step) {
    const count = state.items.length;
    let index = from;
    for (let i = 0; i < count; i += 1) {
      index += step;
      if (index < 0 || index >= count) {
        return from;
      }
      if (!state.items[index].disabled) {
        return index;
      }
    }
    return from;
  }

  function edge(state, last) {
    const order = state.items.map((_, i) => i);
    if (last) {
      order.reverse();
    }
    const found = order.find((i) => !state.items[i].disabled);
    return found === undefined ? state.active : found;
  }

  function typeAhead(key, entries, startIndex) {
    window.clearTimeout(typeTimer);
    typeTimer = window.setTimeout(() => {
      typeBuffer = "";
    }, TYPE_AHEAD_MS);
    typeBuffer += key.toLowerCase();
    const cycle = typeBuffer.length === 1 || [...typeBuffer].every((ch) => ch === typeBuffer[0]);
    const needle = cycle ? typeBuffer[0] : typeBuffer;
    const total = entries.length;
    const offset = cycle ? 1 : 0;
    for (let i = 0; i < total; i += 1) {
      const index = (startIndex + offset + i + total) % total;
      const entry = entries[index];
      if (!entry.disabled && entry.text.toLowerCase().startsWith(needle)) {
        return index;
      }
    }
    return -1;
  }

  function onKeydown(event) {
    const target = event.target;
    let inst = current ? current.inst : null;
    if (!inst && target instanceof Element) {
      inst = byTrigger.get(target.closest(`.${TRIGGER_CLASS}`));
    }
    if (!inst || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const key = event.key;
    const swallow = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    if (!current) {
      if (inst.trigger.disabled) {
        return;
      }
      if (key === "Enter" || key === " " || key === "ArrowDown" || key === "ArrowUp") {
        swallow();
        openPopup(inst);
      } else if (key.length === 1) {
        const entries = [...inst.select.options].map((option) => ({
          text: option.label,
          disabled: option.disabled || option.hidden,
        }));
        const index = typeAhead(key, entries, inst.select.selectedIndex);
        if (index !== -1) {
          swallow();
          commit(inst, index);
        }
      }
      return;
    }

    const state = current;
    if (key === "Escape") {
      swallow();
      closePopup(true);
    } else if (key === "Tab") {
      closePopup(false);
    } else if (key === "ArrowDown") {
      swallow();
      setActive(state, move(state, state.active, 1), true);
    } else if (key === "ArrowUp") {
      swallow();
      setActive(state, move(state, state.active, -1), true);
    } else if (key === "Home") {
      swallow();
      setActive(state, edge(state, false), true);
    } else if (key === "End") {
      swallow();
      setActive(state, edge(state, true), true);
    } else if (key === "PageDown" || key === "PageUp") {
      swallow();
      let index = state.active;
      for (let i = 0; i < 8; i += 1) {
        index = move(state, index, key === "PageDown" ? 1 : -1);
      }
      setActive(state, index, true);
    } else if (key === "Enter" || (key === " " && !typeBuffer)) {
      swallow();
      const item = state.items[state.active];
      if (item && !item.disabled) {
        choose(state, item);
      } else {
        closePopup(true);
      }
    } else if (key.length === 1) {
      swallow();
      const entries = state.items.map((item) => ({ text: item.option.label, disabled: item.disabled }));
      const index = typeAhead(key, entries, state.active);
      if (index !== -1) {
        setActive(state, index, true);
      }
    }
  }

  document.addEventListener("keydown", onKeydown, true);

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!current) {
        return;
      }
      const target = event.target;
      if (current.popup.contains(target) || current.inst.trigger.contains(target)) {
        return;
      }
      closePopup(false);
    },
    true
  );

  document.addEventListener("click", (event) => {
    const label = event.target instanceof Element ? event.target.closest("label") : null;
    const control = label && label.control;
    const inst = control && bySelect.get(control);
    if (inst && !inst.trigger.contains(event.target)) {
      event.preventDefault();
      inst.trigger.focus();
    }
  });

  function refreshPopupPosition() {
    if (!current) {
      return;
    }
    const rect = current.inst.trigger.getBoundingClientRect();
    const viewHeight = document.documentElement.clientHeight;
    if (rect.bottom < 0 || rect.top > viewHeight || !current.inst.trigger.checkVisibility()) {
      closePopup(false);
    } else {
      positionPopup(current);
    }
  }

  window.addEventListener(
    "scroll",
    (event) => {
      if (!current || current.popup.contains(event.target)) {
        return;
      }
      const scroller = event.target;
      if (scroller === document || (scroller instanceof Node && scroller.contains(current.inst.trigger))) {
        refreshPopupPosition();
      }
    },
    true
  );
  window.addEventListener("resize", refreshPopupPosition);
  window.addEventListener("blur", () => closePopup(false));

  scan(document);
  new MutationObserver((records) => {
    for (const record of records) {
      record.removedNodes.forEach(release);
      record.addedNodes.forEach(scan);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
