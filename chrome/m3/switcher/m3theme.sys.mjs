/* Material You theme switcher: shared logic.
 *
 * Loaded once per browser process (boot.js imports it at startup, the
 * switcher page imports the same instance). It turns a seed color or the
 * wallpaper into M3 color roles with matugen and registers them as a live
 * user stylesheet, so the browser recolors without a restart.
 *
 * State lives in prefs:
 *   m3.theme.source    "files" (default) | "wallpaper" | "color"
 *   m3.theme.seed      "#rrggbb"            used when source = "color"
 *   m3.theme.scheme    matugen scheme type  e.g. "scheme-tonal-spot"
 *   m3.theme.contrast  "-1" .. "1"          matugen contrast level
 *   m3.theme.wallpaper image path; empty = DankMaterialShell's wallpaper
 *
 * "files" reads and applies the desktop palette from the matugen
 * templates (palette.generated.css, pages.palette.generated.css), which
 * DankMaterialShell keeps in sync with the desktop.
 */

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const PREF = {
  source: "m3.theme.source",
  seed: "m3.theme.seed",
  scheme: "m3.theme.scheme",
  contrast: "m3.theme.contrast",
  wallpaper: "m3.theme.wallpaper",
};

export const SCHEMES = [
  { id: "scheme-tonal-spot", label: "Tonal spot", hint: "Calm, the Android default" },
  { id: "scheme-vibrant", label: "Vibrant", hint: "Saturated and bright" },
  { id: "scheme-expressive", label: "Expressive", hint: "Playful hue shifts" },
  { id: "scheme-fidelity", label: "Fidelity", hint: "Stays close to the seed" },
  { id: "scheme-content", label: "Content", hint: "Like Fidelity, softer tertiary" },
  { id: "scheme-rainbow", label: "Rainbow", hint: "Neutral surfaces, bold accents" },
  { id: "scheme-fruit-salad", label: "Fruit salad", hint: "Shifted, colorful" },
  { id: "scheme-neutral", label: "Neutral", hint: "Barely tinted" },
  { id: "scheme-monochrome", label: "Monochrome", hint: "Grayscale" },
];

export const PRESETS = [
  { name: "Blue", seed: "#0B57D0" },
  { name: "Indigo", seed: "#4355B9" },
  { name: "Violet", seed: "#6750A4" },
  { name: "Pink", seed: "#B4246E" },
  { name: "Red", seed: "#B3261E" },
  { name: "Coral", seed: "#D2593C" },
  { name: "Amber", seed: "#C17A00" },
  { name: "Sand", seed: "#8A7356" },
  { name: "Olive", seed: "#6B7A2A" },
  { name: "Green", seed: "#146C2E" },
  { name: "Teal", seed: "#00696B" },
  { name: "Cyan", seed: "#00658E" },
];

// Firefox's own pages that the theme styles (keep in sync with m3/pages.css).
const PAGE_SCOPE = 'url-prefix("chrome:"), regexp("about:(?!blank(?:[?#]|$)|srcdoc(?:[?#]|$)).*")';

const ROLES = [
  "primary", "on_primary", "primary_container", "on_primary_container",
  "secondary", "on_secondary", "secondary_container", "on_secondary_container",
  "tertiary", "on_tertiary", "tertiary_container", "on_tertiary_container",
  "error", "on_error", "error_container", "on_error_container",
  "surface", "on_surface", "surface_variant", "on_surface_variant",
  "surface_dim", "surface_bright", "surface_container_lowest",
  "surface_container_low", "surface_container", "surface_container_high",
  "surface_container_highest", "outline", "outline_variant",
  "inverse_surface", "inverse_on_surface", "inverse_primary",
  "shadow", "scrim", "surface_tint",
];

function chromeDir() {
  return Services.dirsvc.get("UChrm", Ci.nsIFile).path;
}

function liveFile() {
  return PathUtils.join(chromeDir(), "m3", "palette.live.css");
}

function getPref(name, fallback) {
  return Services.prefs.getStringPref(name, fallback);
}

let registeredURI = null;
let matugenPath = null;
let generation = 0;

export const M3Theme = {
  SCHEMES,
  PRESETS,
  PREF,

  get state() {
    return {
      source: getPref(PREF.source, "files"),
      seed: getPref(PREF.seed, PRESETS[0].seed),
      scheme: getPref(PREF.scheme, "scheme-tonal-spot"),
      contrast: getPref(PREF.contrast, "0"),
      wallpaper: getPref(PREF.wallpaper, ""),
    };
  },

  /* Called once at startup by boot.js. Re-applies the saved palette at
     once, then refreshes a wallpaper palette in the background in case the
     wallpaper changed while Firefox was closed. */
  async init() {
    const { source } = this.state;
    if (source === "files") {
      try {
        this._register(await this._desktopCss());
      } catch (e) {
        console.error("m3theme: desktop palette:", e);
      }
      return;
    }
    try {
      if (await IOUtils.exists(liveFile())) {
        this._register(await IOUtils.readUTF8(liveFile()));
      }
      if (source === "wallpaper") {
        await this.apply({});
      }
    } catch (e) {
      console.error("m3theme: init failed", e);
    }
  },

  async findMatugen() {
    if (!matugenPath) {
      matugenPath = await Subprocess.pathSearch("matugen");
    }
    return matugenPath;
  },

  /* DankMaterialShell stores the current wallpaper in its session state. */
  async desktopWallpaper() {
    const custom = this.state.wallpaper;
    if (custom) {
      return custom;
    }
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const session = PathUtils.join(home, ".local", "state", "DankMaterialShell", "session.json");
    try {
      const json = JSON.parse(await IOUtils.readUTF8(session));
      return json.wallpaperPath || "";
    } catch {
      return "";
    }
  },

  /* Runs matugen and returns { light: {role: hex}, dark: {role: hex} }. */
  async generate({ source, seed, scheme, contrast }) {
    const args = [];
    if (source === "wallpaper") {
      const image = await this.desktopWallpaper();
      if (!image) {
        throw new Error("No wallpaper found. Set one in DankMaterialShell or pick an image.");
      }
      args.push("image", image, "--prefer", "saturation");
    } else {
      args.push("color", "hex", seed);
    }
    // An empty template list keeps matugen from touching any files.
    const config = PathUtils.join(chromeDir(), "m3", "switcher", "matugen-json.toml");
    args.push("-t", scheme, "--contrast", String(contrast), "-c", config, "-j", "hex", "-q");

    const proc = await Subprocess.call({
      command: await this.findMatugen(),
      arguments: args,
      stderr: "pipe",
    });
    let out = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      out += chunk;
    }
    let err = "";
    while ((chunk = await proc.stderr.readString())) {
      err += chunk;
    }
    const { exitCode } = await proc.wait();
    if (exitCode !== 0) {
      throw new Error(`matugen exited with ${exitCode}: ${err.trim().split("\n")[0]}`);
    }

    const colors = JSON.parse(out).colors;
    const palette = { light: {}, dark: {} };
    for (const role of ROLES) {
      if (!colors[role]) {
        continue;
      }
      palette.light[role] = colors[role].light.color;
      palette.dark[role] = colors[role].dark.color;
    }
    return palette;
  },

  buildCss(palette) {
    const decls = (mode, indent) =>
      Object.entries(palette[mode])
        .map(([role, hex]) => `${indent}--md-sys-color-${role.replaceAll("_", "-")}: ${hex} !important;`)
        .join("\n");
    const scope = PAGE_SCOPE;
    return `/* Live palette from the Material You theme switcher.
 * Written by m3/switcher; delete it (or pick "Desktop") to go back to the
 * matugen palette files. Scoped so websites never see these variables. */

@-moz-document ${scope} {
  :root {
${decls("light", "    ")}
  }

  @media (prefers-color-scheme: dark) {
    :root {
${decls("dark", "      ")}
    }
  }
}
`;
  },

  /* Generates, saves and applies a palette. Any option not given keeps its
     saved value. Returns the palette for the page to display. */
  async apply(opts) {
    const state = { ...this.state, ...opts };
    const ticket = ++generation;

    if (state.source === "files") {
      const css = await this._desktopCss();
      if (ticket !== generation) return null;
      this._register(css);
      await IOUtils.remove(liveFile(), { ignoreAbsent: true });
      this._save(state);
      return null;
    }

    const palette = await this.generate(state);
    // A newer click won the race: drop this result.
    if (ticket !== generation) {
      return palette;
    }
    const css = this.buildCss(palette);
    this._register(css);
    await IOUtils.writeUTF8(liveFile(), css);
    this._save(state);
    return palette;
  },

  async _desktopCss() {
    const readPalette = async (generated, fallback) => {
      const path = PathUtils.join(chromeDir(), "m3", generated);
      return IOUtils.readUTF8(await IOUtils.exists(path)
        ? path : PathUtils.join(chromeDir(), "m3", fallback));
    };
    const [browser, pages] = await Promise.all([
      readPalette("palette.generated.css", "tokens.css"),
      readPalette("pages.palette.generated.css", "pages.palette.static.css"),
    ]);
    // Desktop palettes need the same priority as generated live colors.
    return (`@-moz-document url-prefix("chrome:") {\n${browser}\n}\n${pages}`)
      .replace(/(--md-sys-color-[\w-]+:[^;!]+)(;)/g, "$1 !important$2");
  },

  _save(state) {
    Services.prefs.setStringPref(PREF.source, state.source);
    Services.prefs.setStringPref(PREF.seed, state.seed);
    Services.prefs.setStringPref(PREF.scheme, state.scheme);
    Services.prefs.setStringPref(PREF.contrast, String(state.contrast));
  },

  _register(css) {
    const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
    const uri = Services.io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(css));
    sss.loadAndRegisterSheet(uri, sss.USER_SHEET);
    // Register the new sheet before removing the old one, so nothing
    // flashes back to the file palette in between.
    if (registeredURI) {
      sss.unregisterSheet(registeredURI, sss.USER_SHEET);
    }
    registeredURI = uri;
  },

  _unregister() {
    if (!registeredURI) {
      return;
    }
    const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
    sss.unregisterSheet(registeredURI, sss.USER_SHEET);
    registeredURI = null;
  },
};
