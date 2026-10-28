/* First-run welcome page. boot.js opens it once; it walks through the few
 * settings FMD3 cannot make itself. The color step calls the shared M3Theme
 * module, so a pick recolors the browser and this page at once. */

const { M3Theme } = ChromeUtils.importESModule("chrome://m3theme/content/m3theme.sys.mjs");

const $ = id => document.getElementById(id);
const stage = document.querySelector(".stage");
const slides = [...document.querySelectorAll(".slide")];
const QUICK_PICKS = ["Blue", "Violet", "Pink", "Coral", "Amber", "Green", "Teal"];
let step = 1;

/* -- Steps ------------------------------------------------------------------- */

function show(n, focus = true) {
  step = Math.min(Math.max(n, 1), slides.length);
  stage.dataset.step = step;
  for (const s of slides) {
    s.hidden = Number(s.dataset.step) !== step;
  }
  for (const [i, li] of [...$("dots").children].entries()) {
    const b = li.firstChild;
    if (i + 1 === step) {
      b.setAttribute("aria-current", "step");
    } else {
      b.removeAttribute("aria-current");
    }
  }
  // Hidden art layers keep their buttons out of the tab order.
  for (const layer of document.querySelectorAll(".art-layer")) {
    layer.inert = Number(layer.dataset.for) !== step;
  }
  $("back").disabled = step === 1;
  $("next").hidden = step === slides.length;
  if (focus) {
    slides[step - 1].querySelector("h1, h2").focus();
  }
}

function buildDots() {
  for (const s of slides) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dot-btn";
    b.setAttribute("aria-label", `Step ${s.dataset.step} of ${slides.length}: ${s.querySelector("h1, h2").textContent}`);
    b.addEventListener("click", () => show(Number(s.dataset.step)));
    li.append(b);
    $("dots").append(li);
  }
}

/* -- Color picks ------------------------------------------------------------- */

function markPick() {
  const { source, seed } = M3Theme.state;
  for (const b of $("picks").children) {
    const on = source === "files" ? b.dataset.source === "files" : b.dataset.seed === seed.toLowerCase();
    b.setAttribute("aria-checked", on);
    b.tabIndex = on ? 0 : -1;
  }
  if (!$("picks").querySelector('[aria-checked="true"]')) {
    $("picks").firstElementChild.tabIndex = 0;
  }
}

async function pick(change) {
  $("pick-status").textContent = "Applying…";
  $("pick-status").classList.remove("error");
  stage.classList.add("busy");
  try {
    await M3Theme.apply(change);
    $("pick-status").textContent = change.source === "files" ? "Using your desktop colors" : "Color applied";
  } catch (e) {
    console.error(e);
    // matugen missing is the common case; say what fixes it.
    $("pick-status").textContent = /matugen|NS_ERROR_FILE|not found/i.test(String(e))
      ? "Custom colors need matugen. Install it, then try again."
      : e.message;
    $("pick-status").classList.add("error");
  } finally {
    stage.classList.remove("busy");
    markPick();
  }
}

function buildPicks() {
  const box = $("picks");
  for (const p of M3Theme.PRESETS.filter(p => QUICK_PICKS.includes(p.name))) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.className = "pick";
    b.dataset.seed = p.seed.toLowerCase();
    b.style.setProperty("--seed", p.seed);
    b.setAttribute("aria-label", p.name);
    b.title = p.name;
    box.append(b);
  }
  box.addEventListener("click", e => {
    const b = e.target.closest(".pick");
    if (b) {
      pick(b.dataset.source ? { source: "files" } : { source: "color", seed: b.dataset.seed });
    }
  });
  // Radio group: arrow keys move and select.
  box.addEventListener("keydown", e => {
    const items = [...box.children];
    const i = items.indexOf(document.activeElement);
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (i < 0 || !d) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const next = items[(i + d + items.length) % items.length];
    next.focus();
    next.click();
  });
  markPick();
}

/* -- Light and dark ---------------------------------------------------------- */

/* Firefox picks light or dark from its active theme, the same setting as
   Settings > Appearance. "System theme — auto" follows the desktop. */
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const modes = [...document.querySelectorAll(".mode")];

async function markMode() {
  const themes = await AddonManager.getAddonsByTypes(["theme"]);
  const active = themes.find(t => t.isActive)?.id;
  for (const b of modes) {
    b.setAttribute("aria-pressed", b.dataset.theme === active);
  }
  stage.dataset.mode = modes.find(b => b.dataset.theme === active)?.dataset.theme.split("@")[0] ?? "other";
}

async function setMode(id) {
  $("mode-status").classList.remove("error");
  try {
    const theme = await AddonManager.getAddonByID(id);
    await theme.enable();
    $("mode-status").textContent = {
      "default-theme@mozilla.org": "Firefox now follows your desktop",
      "firefox-compact-light@mozilla.org": "Firefox stays light",
      "firefox-compact-dark@mozilla.org": "Firefox stays dark",
    }[id];
  } catch (e) {
    console.error(e);
    $("mode-status").textContent = "Could not switch the theme. Choose it in Settings, under Appearance.";
    $("mode-status").classList.add("error");
  }
  markMode();
}

for (const b of modes) {
  b.addEventListener("click", () => setMode(b.dataset.theme));
}

/* -- Wiring ------------------------------------------------------------------ */

if (navigator.platform.startsWith("Mac")) {
  $("shortcut").textContent = "Command+Option+M";
  document.querySelector('[data-mod="ctrl"]').textContent = "⌘";
  document.querySelector('[data-mod="alt"]').textContent = "⌥";
}

$("back").addEventListener("click", () => show(step - 1));
$("next").addEventListener("click", () => show(step + 1));
document.addEventListener("keydown", e => {
  if (e.target.closest("input, textarea, [role=radiogroup]") || e.altKey || e.ctrlKey || e.metaKey) {
    return;
  }
  if (e.key === "ArrowRight" || e.key === "PageDown") {
    show(step + 1);
  } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
    show(step - 1);
  }
});

buildDots();
buildPicks();
markMode();
show(1, false);
