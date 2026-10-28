/* Material You theme switcher page. Runs privileged (chrome://), so it can
 * call the shared M3Theme module, which runs matugen and swaps the live
 * stylesheet. The page itself is styled from the same --md-sys-color-*
 * variables, so it recolors along with the browser. */

const { M3Theme } = ChromeUtils.importESModule("chrome://m3theme/content/m3theme.sys.mjs");

const $ = id => document.getElementById(id);
const FLAT_PREF = "m3.content.flat";
const HEX = /^#[0-9a-f]{6}$/i;

const SOURCE_HINTS = {
  files: "Follow your desktop palette. Restart Firefox after changing your desktop colors.",
  wallpaper: "Match your DankMaterialShell wallpaper. Colors refresh when Firefox starts.",
  color: "Use one color to create a complete theme for Firefox.",
};

const ROLE_GROUPS = [
  ["primary", "on-primary", "primary-container", "on-primary-container"],
  ["secondary", "on-secondary", "secondary-container", "on-secondary-container"],
  ["tertiary", "on-tertiary", "tertiary-container", "on-tertiary-container"],
  ["error", "on-error", "error-container", "on-error-container"],
  ["surface", "surface-container-low", "surface-container", "surface-container-high"],
  ["surface-container-highest", "on-surface", "on-surface-variant", "outline"],
];

let state = M3Theme.state;
let busy = 0;
let updateId = 0;

/* -- Rendering --------------------------------------------------------------- */

function setRadio(group, value) {
  for (const b of group.querySelectorAll("[role=radio]")) {
    const on = b.dataset.value === value;
    b.setAttribute("aria-checked", on);
    b.tabIndex = on ? 0 : -1;
  }
  if (!group.querySelector('[aria-checked="true"]')) {
    const first = group.querySelector('[role="radio"]');
    if (first) first.tabIndex = 0;
  }
}

function render() {
  setRadio($("source"), state.source);
  setRadio($("contrast"), state.contrast);
  setRadio($("schemes"), state.scheme);
  setRadio($("swatches"), state.source === "color" ? state.seed.toLowerCase() : "");
  $("source-hint").textContent = SOURCE_HINTS[state.source];
  $("style-hint").textContent = M3Theme.SCHEMES.find(s => s.id === state.scheme)?.hint || "";
  $("color-section").hidden = state.source !== "color";
  $("style-section").hidden = state.source === "files";
  $("contrast-section").hidden = state.source === "files";
  $("picker").value = state.seed;
  document.documentElement.style.setProperty("--seed", state.seed);
  if (document.activeElement !== $("hex")) {
    $("hex").value = state.seed.toUpperCase();
    $("hex").setAttribute("aria-invalid", "false");
    $("hex").closest(".field").classList.remove("invalid");
    $("hex-error").hidden = true;
  }
  $("floating").checked = !Services.prefs.getBoolPref(FLAT_PREF, false);
  renderRoles();
}

function renderRoles() {
  const cs = getComputedStyle(document.documentElement);
  const roles = $("roles");
  roles.replaceChildren();
  for (const group of ROLE_GROUPS) {
    for (const role of group) {
      const value = cs.getPropertyValue(`--md-sys-color-${role}`).trim();
      const b = document.createElement("button");
      b.type = "button";
      b.className = "role";
      b.style.setProperty("--swatch", `var(--md-sys-color-${role})`);
      b.innerHTML = `<span class="role-dot"></span><span class="role-name"></span><span class="role-hex"></span>`;
      b.querySelector(".role-name").textContent = role.replaceAll("-", " ");
      b.querySelector(".role-hex").textContent = value.toUpperCase();
      b.addEventListener("click", () => {
        navigator.clipboard.writeText(value)
          .then(() => toast(`Copied ${value.toUpperCase()}`))
          .catch(() => toast("Could not copy this color. Try again."));
      });
      roles.append(b);
    }
  }
}

function buildSwatches() {
  const box = $("swatches");
  for (const p of M3Theme.PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.className = "swatch";
    b.dataset.value = p.seed.toLowerCase();
    b.title = p.name;
    b.setAttribute("aria-label", p.name);
    b.style.setProperty("--a", p.seed);
    b.style.setProperty("--b", p.seed);
    b.style.setProperty("--c", p.seed);
    b.innerHTML = `<span class="swatch-q"></span><span class="swatch-check" aria-hidden="true"></span>`;
    const name = document.createElement("span");
    name.className = "swatch-name";
    name.textContent = p.name;
    b.append(name);
    b.addEventListener("click", () => update({ source: "color", seed: p.seed }));
    box.append(b);
  }
}

/* Each preset swatch shows its real palette for the current style, like the
   Android wallpaper & style picker: primary, secondary and tertiary. */
async function paintSwatches() {
  const scheme = state.scheme;
  await Promise.all([...$("swatches").children].map(async b => {
    try {
      const pal = await M3Theme.generate({ source: "color", seed: b.dataset.value, scheme, contrast: 0 });
      if (scheme !== state.scheme) {
        return;
      }
      const dark = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      b.style.setProperty("--a", pal[dark].primary);
      b.style.setProperty("--b", pal[dark].secondary_container);
      b.style.setProperty("--c", pal[dark].tertiary_container);
    } catch {}
  }));
}

function buildSchemes() {
  const box = $("schemes");
  for (const s of M3Theme.SCHEMES) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.className = "chip";
    b.dataset.value = s.id;
    b.title = s.hint;
    b.innerHTML = `<span class="chip-check" aria-hidden="true"></span><span></span>`;
    b.lastChild.textContent = s.label;
    b.addEventListener("click", () => update({ scheme: s.id }));
    box.append(b);
  }
}

/* -- Actions ----------------------------------------------------------------- */

async function update(change) {
  const ticket = ++updateId;
  const prevScheme = state.scheme;
  state = { ...state, ...change };
  render();
  document.body.classList.add("busy");
  busy++;
  $("apply-status").textContent = "Applying theme…";
  $("apply-status").classList.remove("error");
  $("source").setAttribute("aria-busy", "true");
  try {
    await M3Theme.apply(state);
    if (ticket === updateId) {
      $("apply-status").textContent = "Theme saved";
    }
  } catch (e) {
    console.error(e);
    if (ticket === updateId) {
      state = M3Theme.state;
      render();
      $("apply-status").textContent = e.message;
      $("apply-status").classList.add("error");
    }
  } finally {
    if (--busy === 0) {
      document.body.classList.remove("busy");
      $("source").setAttribute("aria-busy", "false");
    }
  }
  // Variables update one frame after the sheet swap.
  requestAnimationFrame(() => requestAnimationFrame(renderRoles));
  if (state.scheme !== prevScheme) {
    paintSwatches();
  }
}

let toastTimer;
function toast(text) {
  const s = $("snackbar");
  s.textContent = text;
  s.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (s.hidden = true), 4000);
}

/* Radio groups: arrow keys move and select, as the ARIA pattern expects. */
function wireRadioKeys(group, onPick) {
  group.addEventListener("keydown", e => {
    const items = [...group.querySelectorAll("[role=radio]")];
    const i = items.indexOf(document.activeElement);
    if (i < 0) {
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) {
      return;
    }
    e.preventDefault();
    const next = items[(i + step + items.length) % items.length];
    next.focus();
    onPick ? onPick(next) : next.click();
  });
}

/* -- Wiring ------------------------------------------------------------------ */

buildSwatches();
buildSchemes();

for (const b of $("source").children) {
  b.addEventListener("click", () => update({ source: b.dataset.value }));
}
for (const b of $("contrast").children) {
  b.addEventListener("click", () => update({ contrast: b.dataset.value }));
}
for (const id of ["source", "contrast", "schemes", "swatches"]) {
  wireRadioKeys($(id));
}

// The color input fires "input" continuously while dragging; apply on a
// short pause so matugen is not run for every pixel.
let pickTimer;
$("picker").addEventListener("input", e => {
  $("hex").value = e.target.value.toUpperCase();
  clearTimeout(pickTimer);
  pickTimer = setTimeout(() => update({ source: "color", seed: e.target.value }), 120);
});

$("hex").addEventListener("input", e => {
  let v = e.target.value.trim();
  if (!v.startsWith("#")) {
    v = "#" + v;
  }
  const ok = HEX.test(v);
  e.target.closest(".field").classList.toggle("invalid", !ok);
  e.target.setAttribute("aria-invalid", String(!ok));
  $("hex-error").hidden = ok;
});

function applyHex() {
  const value = $("hex").value.trim();
  const seed = value.startsWith("#") ? value : `#${value}`;
  if (HEX.test(seed)) update({ source: "color", seed });
}
$("hex").addEventListener("change", applyHex);
$("hex").addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    applyHex();
  }
});

$("floating").addEventListener("change", e => {
  Services.prefs.setBoolPref(FLAT_PREF, !e.target.checked);
});

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  renderRoles();
  paintSwatches();
});

render();
paintSwatches();
