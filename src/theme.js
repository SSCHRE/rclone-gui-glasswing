(() => {
const THEMES = {
  glass: { label: "Glass", ripple: false },
  material: { label: "Material", ripple: true },
  "material-dark": { label: "Material Dark", ripple: true },
};
const root = document.documentElement;

function currentTheme() {
  return Object.hasOwn(THEMES, root.dataset.theme) ? root.dataset.theme : "glass";
}

function applyTheme(theme) {
  root.dataset.theme = Object.hasOwn(THEMES, theme) ? theme : "glass";
}

applyTheme(window.rcloneGui?.initialTheme);

const ui = {};

function render() {
  const theme = currentTheme();
  ui.toggle.title = `Theme: ${THEMES[theme].label}`;
  for (const item of ui.items) {
    item.setAttribute("aria-checked", String(item.dataset.themeOption === theme));
  }
}

function isMenuOpen() {
  return !ui.menu.classList.contains("hidden");
}

function openMenu() {
  ui.menu.classList.remove("hidden");
  ui.toggle.setAttribute("aria-expanded", "true");
  (ui.items.find((item) => item.getAttribute("aria-checked") === "true") || ui.items[0]).focus();
}

function closeMenu({ focusToggle = false } = {}) {
  ui.menu.classList.add("hidden");
  ui.toggle.setAttribute("aria-expanded", "false");
  if (focusToggle) {
    ui.toggle.focus();
  }
}

async function switchTheme(theme) {
  if (theme === currentTheme()) {
    return;
  }
  const swap = () => {
    document.querySelectorAll(".md-ripple").forEach((ripple) => ripple.remove());
    applyTheme(theme);
    render();
  };
  if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.startViewTransition(swap);
  } else {
    swap();
  }
  try {
    await window.rcloneGui?.setTheme(theme);
  } catch {}
}

function addRipple(event) {
  if (!THEMES[currentTheme()].ripple || event.button !== 0) {
    return;
  }
  const button = event.target.closest("button");
  if (!button || button.disabled) {
    return;
  }
  const rect = button.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2;
  const ripple = document.createElement("span");
  ripple.className = "md-ripple";
  ripple.style.width = ripple.style.height = `${size}px`;
  ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
  button.append(ripple);
}

function onMenuKeydown(event) {
  const index = ui.items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.stopPropagation();
    closeMenu({ focusToggle: true });
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    ui.items[(index + step + ui.items.length) % ui.items.length].focus();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  ui.toggle = document.getElementById("theme-toggle");
  ui.menu = document.getElementById("theme-menu");
  ui.items = [...ui.menu.querySelectorAll("[data-theme-option]")];
  render();

  ui.toggle.addEventListener("click", () => (isMenuOpen() ? closeMenu() : openMenu()));
  ui.menu.addEventListener("keydown", onMenuKeydown);
  for (const item of ui.items) {
    item.addEventListener("click", () => {
      closeMenu({ focusToggle: true });
      void switchTheme(item.dataset.themeOption);
    });
  }
  document.addEventListener("pointerdown", (event) => {
    if (isMenuOpen() && !event.target.closest(".theme-picker")) {
      closeMenu();
    }
    addRipple(event);
  });
});
})();
