(() => {
const THEMES = {
  glass: { label: "Glass" },
  bootstrap: { label: "Bootstrap 5" },
  pico: { label: "Pico CSS" },
  catppuccin: { label: "Catppuccin" },
};
const root = document.documentElement;

function currentTheme() {
  return Object.hasOwn(THEMES, root.dataset.theme) ? root.dataset.theme : "glass";
}

function applyTheme(theme) {
  root.dataset.theme = Object.hasOwn(THEMES, theme) ? theme : "glass";
}

applyTheme(window.rcloneGui?.initialTheme);

const titlebarMode = window.rcloneGui?.titlebarMode || "unsupported";
let customTitlebarWanted = titlebarMode === "custom";
root.classList.toggle("has-custom-titlebar", titlebarMode === "custom");

const UI_SCALES = [0.9, 1, 1.1, 1.2, 1.35, 1.5];
let uiScale = closestUiScale(window.rcloneGui?.initialUiScale ?? 1);

function closestUiScale(scale) {
  return UI_SCALES.reduce((best, option) => (Math.abs(option - scale) < Math.abs(best - scale) ? option : best), 1);
}

const ui = {};

function themeItems() {
  return ui.items.filter((item) => item.dataset.themeOption);
}

function visibleItems() {
  return [...ui.menu.querySelectorAll(".theme-menu-item, .theme-menu-step")].filter(
    (item) => !item.classList.contains("hidden") && !item.disabled,
  );
}

function renderUiScale() {
  const index = UI_SCALES.indexOf(uiScale);
  ui.scaleValue.textContent = `${Math.round(uiScale * 100)}%`;
  ui.scaleValue.setAttribute("aria-label", `Text size ${Math.round(uiScale * 100)}%, reset to 100%`);
  for (const button of ui.scaleSteps) {
    const step = Number(button.dataset.uiScaleStep);
    const atLimit = !UI_SCALES[index + step];
    if (atLimit && document.activeElement === button) {
      ui.scaleValue.focus();
    }
    button.disabled = atLimit;
  }
}

function render() {
  const theme = currentTheme();
  ui.toggle.title = `Theme: ${THEMES[theme].label}`;
  for (const item of themeItems()) {
    item.setAttribute("aria-checked", String(item.dataset.themeOption === theme));
  }
  renderUiScale();
}

async function setUiScale(scale) {
  if (!UI_SCALES.includes(scale) || scale === uiScale) {
    return;
  }
  uiScale = scale;
  renderUiScale();
  try {
    await window.rcloneGui?.setUiScale(scale);
  } catch {}
}

function stepUiScale(step) {
  const next = UI_SCALES[UI_SCALES.indexOf(uiScale) + step];
  if (next) {
    void setUiScale(next);
  }
}

function onShortcutKeydown(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) {
    return;
  }
  if (event.key === "=" || event.key === "+") {
    event.preventDefault();
    stepUiScale(1);
  } else if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    stepUiScale(-1);
  } else if (event.key === "0") {
    event.preventDefault();
    void setUiScale(1);
  }
}

function renderTitlebarSetting() {
  if (!ui.titlebarToggle) {
    return;
  }
  const supported = titlebarMode !== "unsupported";
  ui.titlebarToggle.classList.toggle("hidden", !supported);
  ui.titlebarDivider?.classList.toggle("hidden", !supported);
  ui.titlebarToggle.setAttribute("aria-checked", String(customTitlebarWanted));
  ui.titlebarRestart?.classList.toggle("hidden", !supported || customTitlebarWanted === (titlebarMode === "custom"));
}

async function toggleCustomTitlebar() {
  customTitlebarWanted = !customTitlebarWanted;
  renderTitlebarSetting();
  try {
    await window.rcloneGui?.setCustomTitlebar(customTitlebarWanted);
  } catch {
    customTitlebarWanted = !customTitlebarWanted;
    renderTitlebarSetting();
  }
}

function isMenuOpen() {
  return !ui.menu.classList.contains("hidden");
}

function openMenu() {
  ui.menu.classList.remove("hidden");
  ui.toggle.setAttribute("aria-expanded", "true");
  (themeItems().find((item) => item.getAttribute("aria-checked") === "true") || ui.items[0]).focus();
}

function closeMenu({ focusToggle = false } = {}) {
  ui.menu.classList.add("hidden");
  ui.toggle.setAttribute("aria-expanded", "false");
  if (focusToggle) {
    ui.toggle.focus();
  }
}

function revealOrigin() {
  const rect = ui.toggle.getBoundingClientRect();
  if (!rect.width) {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function revealTheme(swap) {
  const { x, y } = revealOrigin();
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  let transition;
  try {
    transition = document.startViewTransition({ update: swap, types: ["theme"] });
  } catch {
    transition = document.startViewTransition(swap);
  }
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 400, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {});
}

async function switchTheme(theme) {
  if (theme === currentTheme()) {
    return;
  }
  const swap = () => {
    applyTheme(theme);
    render();
  };
  if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    revealTheme(swap);
  } else {
    swap();
  }
  try {
    await window.rcloneGui?.setTheme(theme);
  } catch {}
}

const collapseAnimations = new WeakMap();

function cssDuration(name, fallback) {
  const value = getComputedStyle(root).getPropertyValue(name).trim();
  const ms = value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
  return Number.isFinite(ms) ? ms : fallback;
}

function openContentHeight(details, summary) {
  const style = getComputedStyle(details);
  const bottom = details.getBoundingClientRect().bottom - Number.parseFloat(style.paddingBottom) - Number.parseFloat(style.borderBottomWidth);
  return Math.max(0, bottom - summary.getBoundingClientRect().bottom);
}

function finishCollapsibleToggle(details, animation, opening) {
  if (collapseAnimations.get(details) !== animation) {
    return;
  }
  collapseAnimations.delete(details);
  details.open = opening === animation.playbackRate > 0;
  animation.cancel();
  delete details.dataset.animating;
}

function onCollapsibleSummaryClick(event) {
  const summary = event.target.closest(".collapsible > summary");
  const details = summary?.parentElement;
  if (!details) {
    return;
  }
  const running = collapseAnimations.get(details);
  if (running) {
    event.preventDefault();
    running.reverse();
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  event.preventDefault();
  const opening = !details.open;
  details.dataset.animating = "";
  details.open = true;
  const shown = { blockSize: `${openContentHeight(details, summary)}px`, opacity: 1 };
  const hidden = { blockSize: "0px", opacity: 0 };
  let animation;
  try {
    animation = details.animate(opening ? [hidden, shown] : [shown, hidden], {
      duration: cssDuration("--dur-3", 200),
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      pseudoElement: "::details-content",
      fill: "both",
    });
  } catch {
    details.open = opening;
    delete details.dataset.animating;
    return;
  }
  collapseAnimations.set(details, animation);
  animation.finished.then(() => finishCollapsibleToggle(details, animation, opening)).catch(() => {});
}

function onMenuKeydown(event) {
  const items = visibleItems();
  const index = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.stopPropagation();
    closeMenu({ focusToggle: true });
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length].focus();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  ui.toggle = document.getElementById("theme-toggle");
  ui.menu = document.getElementById("theme-menu");
  ui.items = [...ui.menu.querySelectorAll("[data-theme-option], [data-menu-toggle]")];
  ui.scaleValue = document.getElementById("ui-scale-value");
  ui.scaleSteps = [...ui.menu.querySelectorAll("[data-ui-scale-step]")];
  ui.titlebarToggle = document.getElementById("titlebar-menu-toggle");
  ui.titlebarDivider = document.getElementById("titlebar-menu-divider");
  ui.titlebarRestart = document.getElementById("titlebar-restart");
  document.getElementById("titlebar")?.toggleAttribute("hidden", titlebarMode !== "custom");
  render();
  renderTitlebarSetting();

  ui.titlebarToggle?.addEventListener("click", () => void toggleCustomTitlebar());
  ui.titlebarRestart?.addEventListener("click", () => void window.rcloneGui?.restartApp());

  for (const button of ui.scaleSteps) {
    button.addEventListener("click", () => stepUiScale(Number(button.dataset.uiScaleStep)));
  }
  ui.scaleValue.addEventListener("click", () => void setUiScale(1));
  document.addEventListener("keydown", onShortcutKeydown);

  ui.toggle.addEventListener("click", () => (isMenuOpen() ? closeMenu() : openMenu()));
  ui.menu.addEventListener("keydown", onMenuKeydown);
  for (const item of ui.items) {
    item.addEventListener("click", () => {
      closeMenu({ focusToggle: true });
      if (item.dataset.themeOption) {
        void switchTheme(item.dataset.themeOption);
      }
    });
  }
  document.addEventListener("click", onCollapsibleSummaryClick);
  document.addEventListener("pointerdown", (event) => {
    if (isMenuOpen() && !event.target.closest(".theme-picker")) {
      closeMenu();
    }
  });
});
})();
