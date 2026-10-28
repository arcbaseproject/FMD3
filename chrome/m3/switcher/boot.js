/* Material You theme switcher: startup hook.
 *
 * mozilla.cfg (NixOS: programs.firefox.autoConfig) registers
 * chrome.manifest, which maps this folder to chrome://m3theme/content/, then
 * loads this file before any window opens. It:
 *   1. re-applies the saved live palette,
 *   2. adds a "Theme" toolbar button that opens the switcher page,
 *   3. mirrors the search engine icon into CSS so omnibox.css can draw it
 *      as a monochrome glyph (the real icon sits in a shadow root CSS
 *      cannot reach),
 *   4. opens welcome.html once, on the first start after install.
 * Everything else lives in m3theme.sys.mjs and switcher.html, so editing
 * them never needs a NixOS rebuild.
 */
(function () {
  const PAGE = "chrome://m3theme/content/switcher.html";
  const { M3Theme } = ChromeUtils.importESModule("chrome://m3theme/content/m3theme.sys.mjs");
  M3Theme.init();

  /* The search-mode switcher shows the engine's own icon inside its shadow
     root. Copy it to --m3-engine-icon on the host so CSS can redraw it. */
  const watchEngineIcon = win => {
    const sw = win.document.querySelector("#urlbar .searchmode-switcher");
    if (!sw) {
      return;
    }
    const sync = () => {
      const src = sw.getAttribute("iconsrc");
      // Engine icons are favicons (blob:, data:, moz-extension:); chrome://
      // icons are Firefox's own monochrome glyphs and need no help.
      if (src && !src.startsWith("chrome://")) {
        sw.style.setProperty("--m3-engine-icon", `url("${src}")`);
        sw.setAttribute("m3-engine-icon", "true");
      } else {
        sw.style.removeProperty("--m3-engine-icon");
        sw.removeAttribute("m3-engine-icon");
      }
    };
    new win.MutationObserver(sync).observe(sw, { attributes: true, attributeFilter: ["iconsrc"] });
    sync();
    // At startup the switcher keeps its magnifier placeholder until some
    // later event refreshes it. Refresh once the search service is ready.
    const urlbar = win.gURLBar;
    urlbar?.controller?.engineStore
      ?.init()
      .then(() => urlbar.searchModeSwitcher?.updateSearchIcon())
      .catch(() => {});
  };

  const openThemes = win => {
    const tab = win.gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec === PAGE);
    if (tab) {
      win.gBrowser.selectedTab = tab;
    } else {
      win.openTrustedLinkIn(PAGE, "tab");
    }
  };

  const addThemeAccess = win => {
    const doc = win.document;
    if (doc.getElementById("m3-themes-key")) {
      return;
    }
    const key = doc.createXULElement("key");
    key.id = "m3-themes-key";
    key.setAttribute("key", "m");
    key.setAttribute("modifiers", "accel,alt");
    key.addEventListener("command", () => openThemes(win));
    doc.getElementById("mainKeyset").append(key);

    const item = doc.createXULElement("menuitem");
    item.id = "m3-themes-menuitem";
    item.setAttribute("label", "Custom themes…");
    item.setAttribute("key", key.id);
    item.addEventListener("command", () => openThemes(win));
    doc.getElementById("menu_ToolsPopup").append(item);
  };

  const addThemeButton = () => {
    const { CustomizableUI } = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs");
    if (CustomizableUI.getWidget("m3-theme-button")?.provider === CustomizableUI.PROVIDER_API) {
      return;
    }
    CustomizableUI.createWidget({
      id: "m3-theme-button",
      label: "Theme",
      tooltiptext: "Material You theme: colors and style",
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(event) {
        openThemes(event.target.ownerDocument.defaultView);
      },
    });
  };

  // Show the welcome page once per profile. Set the pref first so a second
  // window opening at startup does not show it again.
  const showWelcomeOnce = win => {
    if (Services.prefs.getBoolPref("m3.welcome.shown", false)) {
      return;
    }
    Services.prefs.setBoolPref("m3.welcome.shown", true);
    win.openTrustedLinkIn("chrome://m3theme/content/welcome.html", "tab");
  };

  // Runs for every new browser window.
  const onWindow = win => {
    try {
      addThemeButton();
      addThemeAccess(win);
      watchEngineIcon(win);
      showWelcomeOnce(win);
    } catch (e) {
      console.error("m3theme:", e);
    }
  };
  Services.obs.addObserver(onWindow, "browser-delayed-startup-finished");
})();
