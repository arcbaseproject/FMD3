# FMD3 theme switcher hook. Add this block to /etc/nixos/configuration.nix,
# then run: sudo nixos-rebuild switch
# Also remove `firefox` from environment.systemPackages: programs.firefox
# installs it (with this hook) and two copies would collide.
programs.firefox = {
  enable = true;
  # Appended to Firefox's mozilla.cfg. Loads the theme switcher from the
  # profile's chrome/m3/switcher folder; does nothing if that folder is gone.
  autoConfig = ''
    // Material You theme switcher: load chrome/m3/switcher from the profile.
    try {
      let m3 = Services.dirsvc.get("UChrm", Ci.nsIFile);
      for (let p of ["m3", "switcher", "chrome.manifest"]) m3.append(p);
      if (m3.exists()) {
        Components.manager.QueryInterface(Ci.nsIComponentRegistrar).autoRegister(m3);
        Services.scriptloader.loadSubScript("chrome://m3theme/content/boot.js", {});
      }
    } catch (e) {
      Components.utils.reportError(e);
    }
  '';
};
