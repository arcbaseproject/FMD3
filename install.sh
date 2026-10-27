#!/usr/bin/env bash
# FMD3 installer: installs the Material You theme into a Firefox profile.
#
#   ./install.sh                     install into the default profile
#   ./install.sh --profile <dir|name>
#   ./install.sh --list              show the Firefox profiles found
#   ./install.sh --no-hook           skip the theme switcher hook
#   ./install.sh --wallpaper <image> generate the palette from an image
#   ./install.sh --firefox-dir <dir> Firefox install folder for the hook
#                                    (for a Firefox unpacked somewhere else)
#   ./install.sh --uninstall         restore the backup made at install time
#
# Also works piped from the web; it then downloads the repository first:
#   curl -fsSL https://raw.githubusercontent.com/arcbaseproject/FMD3/main/install.sh | bash

set -euo pipefail

REPO_TARBALL="https://github.com/arcbaseproject/FMD3/archive/refs/heads/main.tar.gz"
BLOCK_BEGIN="// >>> FMD3"
BLOCK_END="// <<< FMD3"

profile_arg=""
want_hook=1
wallpaper=""
firefox_dir=""
action="install"

# -- Output -------------------------------------------------------------------

if [[ -t 1 ]]; then
  bold=$'\e[1m' red=$'\e[31m' green=$'\e[32m' yellow=$'\e[33m' reset=$'\e[0m'
else
  bold="" red="" green="" yellow="" reset=""
fi
step() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s  ! %s%s\n' "$yellow" "$*" "$reset" >&2; }
die()  { printf '%serror:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

usage() {
  sed -n '2,15p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
}

# -- Arguments ----------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)   profile_arg="${2:?--profile needs a directory or profile name}"; shift 2 ;;
    --list)      action="list"; shift ;;
    --no-hook)   want_hook=0; shift ;;
    --wallpaper) wallpaper="${2:?--wallpaper needs an image path}"; shift 2 ;;
    --firefox-dir) firefox_dir="${2:?--firefox-dir needs a directory}"; shift 2 ;;
    --uninstall) action="uninstall"; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown option: $1 (see --help)" ;;
  esac
done

# -- Source files -------------------------------------------------------------

# When run through curl | bash there is no checkout next to the script, so
# fetch the repository into a temporary directory.
src="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [[ "$action" == "install" && ! -f "$src/chrome/userChrome.css" ]]; then
  step "Downloading FMD3"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  command -v curl >/dev/null || die "curl is required to download FMD3"
  curl -fsSL "$REPO_TARBALL" | tar -xz -C "$tmp" --strip-components=1
  src="$tmp"
fi

# -- Firefox profiles -----------------------------------------------------------

# Firefox 147+ keeps profiles under ~/.config/mozilla/firefox; older versions
# and some distros use ~/.mozilla/firefox. Snap and Flatpak have their own.
profile_roots=(
  "${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/firefox"
  "$HOME/.mozilla/firefox"
  "$HOME/snap/firefox/common/.mozilla/firefox"
  "$HOME/.var/app/org.mozilla.firefox/config/mozilla/firefox"
  "$HOME/.var/app/org.mozilla.firefox/.mozilla/firefox"
)

# Prints "path<TAB>name<TAB>flag" for every profile; flag is "default" for the
# profile Firefox opens (the [Install...] entry wins over Default=1).
list_profiles() {
  local root ini
  for root in "${profile_roots[@]}"; do
    ini="$root/profiles.ini"
    [[ -f "$ini" ]] || continue
    awk -v root="$root" '
      function flush() {
        if (path != "") {
          full = (rel == "1") ? root "/" path : path
          print full "\t" name "\t" (isdef ? "default1" : "")
        }
        path = ""; name = ""; rel = "1"; isdef = 0
      }
      /^\[/ { flush(); insection = ($0 ~ /^\[Profile/); ininstall = ($0 ~ /^\[Install/); next }
      insection && /^Path=/       { path = substr($0, 6) }
      insection && /^Name=/       { name = substr($0, 6) }
      insection && /^IsRelative=/ { rel = substr($0, 12) }
      insection && /^Default=1/   { isdef = 1 }
      ininstall && /^Default=/    { print "INSTALL\t" substr($0, 9) "\t" root }
      END { flush() }
    ' "$ini"
  done | awk -F'\t' '
    $1 == "INSTALL" { inst[$3 "/" $2] = 1; next }
    { rows[++n] = $0; paths[n] = $1 }
    END {
      for (i = 1; i <= n; i++) {
        split(rows[i], f, "\t")
        flag = (paths[i] in inst) ? "default" : (f[3] == "default1" ? "default1" : "")
        print f[1] "\t" f[2] "\t" flag
      }
    }'
}

pick_profile() {
  local rows best="" best_time=0 path name flag t
  rows="$(list_profiles)"
  [[ -n "$rows" ]] || die "no Firefox profile found. Start Firefox once, then run this again."

  if [[ -n "$profile_arg" ]]; then
    if [[ -d "$profile_arg" ]]; then
      (cd "$profile_arg" && pwd)
      return
    fi
    while IFS=$'\t' read -r path name flag; do
      [[ "$name" == "$profile_arg" || "$(basename "$path")" == "$profile_arg" ]] && { echo "$path"; return; }
    done <<< "$rows"
    die "no profile named '$profile_arg' (try --list)"
  fi

  # Prefer the profile Firefox actually opens; among several (more than one
  # Firefox install), take the one used most recently.
  for want in default default1 ""; do
    while IFS=$'\t' read -r path name flag; do
      [[ "$flag" == "$want" && -d "$path" ]] || continue
      t="$(stat -c %Y "$path/prefs.js" 2>/dev/null || echo 0)"
      if (( t >= best_time )); then best="$path"; best_time="$t"; fi
    done <<< "$rows"
    [[ -n "$best" ]] && { echo "$best"; return; }
  done
  die "could not choose a profile (try --profile)"
}

# -- Helpers --------------------------------------------------------------------

firefox_running() {
  pgrep -x firefox >/dev/null 2>&1 || pgrep -x firefox-bin >/dev/null 2>&1 || pgrep -f '/firefox(-bin)? ' >/dev/null 2>&1
}

# Replace (or append) the block between BLOCK_BEGIN and BLOCK_END in a file.
put_block() {
  local file="$1" body="$2" tmpf
  tmpf="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" '
      index($0, b) == 1 { skip = 1; next }
      index($0, e) == 1 { skip = 0; next }
      !skip { print }' "$file" > "$tmpf"
  fi
  { cat "$tmpf"; printf '%s\n%s\n%s\n' "$BLOCK_BEGIN" "$body" "$BLOCK_END"; } > "$file"
  rm -f "$tmpf"
}

drop_block() {
  local file="$1" tmpf
  [[ -f "$file" ]] || return 0
  tmpf="$(mktemp)"
  awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" '
    index($0, b) == 1 { skip = 1; next }
    index($0, e) == 1 { skip = 0; next }
    !skip { print }' "$file" > "$tmpf"
  cat "$tmpf" > "$file"
  rm -f "$tmpf"
}

is_nixos() { [[ -e /etc/NIXOS ]] || grep -qs '^ID=nixos' /etc/os-release; }

# Finds the Firefox installation directory (the one containing omni.ja).
firefox_install_dir() {
  local bin dir
  if [[ -n "$firefox_dir" ]]; then
    [[ -f "$firefox_dir/omni.ja" ]] || die "$firefox_dir does not look like a Firefox install (no omni.ja)"
    (cd "$firefox_dir" && pwd)
    return
  fi
  for dir in /usr/lib/firefox /usr/lib64/firefox /usr/lib/firefox-esr /opt/firefox /usr/local/lib/firefox; do
    [[ -f "$dir/omni.ja" ]] && { echo "$dir"; return; }
  done
  bin="$(command -v firefox 2>/dev/null || true)"
  [[ -n "$bin" ]] || return 1
  bin="$(readlink -f "$bin")"
  dir="$(dirname "$bin")"
  [[ -f "$dir/omni.ja" ]] && { echo "$dir"; return; }
  # Distro wrapper scripts: look for the real binary they exec.
  dir="$(grep -oE '/[^" ]*/firefox(-bin)?' "$bin" 2>/dev/null | head -1 | xargs -r dirname)"
  [[ -n "$dir" && -f "$dir/omni.ja" ]] && { echo "$dir"; return; }
  return 1
}

# -- Actions --------------------------------------------------------------------

do_list() {
  local path name flag
  list_profiles | while IFS=$'\t' read -r path name flag; do
    printf '%-10s %-20s %s\n' "${flag:+[$flag]}" "$name" "$path"
  done
}

install_hook() {
  step "Theme switcher hook"
  if [[ -z "$firefox_dir" ]] && is_nixos; then
    info "NixOS keeps Firefox read-only, so add the hook to your configuration:"
    info "  1. Copy the block from ${bold}nixos/firefox-hook.nix${reset} into /etc/nixos/configuration.nix"
    info "  2. Remove 'firefox' from environment.systemPackages if it is there"
    info "  3. Run: sudo nixos-rebuild switch"
    [[ -f "$src/nixos/firefox-hook.nix" ]] && cp "$src/nixos/firefox-hook.nix" "$profile/chrome/m3/switcher/nixos-hook.nix" \
      && info "A copy is in $profile/chrome/m3/switcher/nixos-hook.nix"
    return
  fi
  if [[ -z "$firefox_dir" && ( "$profile" == *"/snap/"* || "$profile" == *"/.var/app/"* ) ]]; then
    warn "Snap and Flatpak Firefox cannot load startup hooks; the switcher page is unavailable."
    info "The rest of the theme works. Use matugen (see README) to change colors."
    return
  fi
  local dir
  if ! dir="$(firefox_install_dir)"; then
    warn "Could not find the Firefox installation directory; skipping the hook."
    info "Copy autoconfig/ into it by hand (see README)."
    return
  fi
  info "Firefox is installed in $dir"
  info "The hook needs two files there (sudo if the folder is not yours):"
  info "  $dir/defaults/pref/fmd3-autoconfig.js"
  info "  $dir/mozilla.cfg  (an existing one is kept; the FMD3 block is appended)"
  info "Firefox updates from your package manager may remove them; re-run this script then."
  # sudo prompts on the terminal itself, so this also works under curl | bash.
  local sudo=""
  [[ -w "$dir" ]] || sudo="sudo"
  local cfg="$dir/mozilla.cfg" newcfg
  newcfg="$(mktemp)"
  if [[ -f "$cfg" ]]; then
    # Keep an existing autoconfig; swap in the current FMD3 block. Its first
    # line (the mandatory comment) is already there, so skip ours.
    $sudo cat "$cfg" > "$newcfg"
    drop_block "$newcfg"
    sed '1d' "$src/autoconfig/mozilla.cfg" >> "$newcfg"
  else
    cp "$src/autoconfig/mozilla.cfg" "$newcfg"
  fi
  # general.config.filename decides which cfg file Firefox runs.
  local other
  other="$(grep -ls 'general.config.filename' "$dir"/defaults/pref/*.js 2>/dev/null | grep -v fmd3-autoconfig.js | xargs -r grep -L '"mozilla.cfg"' || true)"
  [[ -n "$other" ]] && warn "$other points Firefox at a different autoconfig file; the switcher may not load."
  if $sudo mkdir -p "$dir/defaults/pref" \
     && $sudo install -m 644 "$src/autoconfig/defaults/pref/fmd3-autoconfig.js" "$dir/defaults/pref/fmd3-autoconfig.js" \
     && $sudo install -m 644 "$newcfg" "$cfg"; then
    info "${green}Installed.${reset} After a restart, a palette button appears in the toolbar."
  else
    warn "Could not write to $dir; the switcher page will be unavailable."
  fi
  rm -f "$newcfg"
}

install_matugen() {
  step "Wallpaper colors (matugen)"
  if ! command -v matugen >/dev/null; then
    info "matugen is not installed; using the built-in palette."
    info "Install matugen and re-run this script to follow your wallpaper."
    return
  fi
  local mdir="${XDG_CONFIG_HOME:-$HOME/.config}/matugen" cfg toml_block
  mkdir -p "$mdir/templates"
  cp "$src/matugen/firefox-m3.css" "$src/matugen/firefox-m3-pages.css" "$mdir/templates/"
  cfg="$mdir/config.toml"
  toml_block="$(sed -n '/^\[templates.firefox-m3\]/,$p' "$src/matugen/config.toml.in" | sed "s#@PROFILE_DIR@#$profile#g")"
  if [[ ! -f "$cfg" ]]; then
    printf '[config]\n\n# >>> FMD3\n%s\n# <<< FMD3\n' "$toml_block" > "$cfg"
    info "Wrote $cfg"
  else
    # Keep the user's config; add or refresh only the FMD3 templates.
    local tmpf
    tmpf="$(mktemp)"
    awk '
      /^# >>> FMD3/ { skip = 1; next }
      /^# <<< FMD3/ { skip = 0; next }
      /^\[templates\.firefox-m3(-pages)?\]/ { skip = 2; next }
      skip == 2 && /^\[/ { skip = 0 }
      !skip { print }' "$cfg" > "$tmpf"
    { cat "$tmpf"; printf '\n# >>> FMD3\n%s\n# <<< FMD3\n' "$toml_block"; } > "$cfg"
    rm -f "$tmpf"
    info "Added the FMD3 templates to $cfg"
  fi

  local image="$wallpaper"
  if [[ -z "$image" ]]; then
    # DankMaterialShell remembers the current wallpaper here.
    local dms="$HOME/.local/state/DankMaterialShell/session.json"
    [[ -f "$dms" ]] && image="$(grep -oE '"wallpaperPath"[[:space:]]*:[[:space:]]*"[^"]*"' "$dms" | sed -E 's/.*"([^"]*)"$/\1/')"
  fi
  if [[ -n "$image" && -f "$image" ]]; then
    # Run only the FMD3 templates, so the user's other matugen templates
    # (terminal, GTK...) are not regenerated as a side effect.
    local only
    only="$(mktemp --suffix=.toml)"
    printf '[config]\n\n%s\n' "$toml_block" > "$only"
    if matugen image "$image" -c "$only" --prefer saturation -q; then
      info "Generated the palette from $image"
    else
      warn "matugen failed on $image; using the built-in palette."
    fi
    rm -f "$only"
  else
    info "No wallpaper given; run with --wallpaper <image> to generate a palette."
  fi
}

do_install() {
  profile="$(pick_profile)"
  step "Installing FMD3 into ${bold}$profile${reset}"
  firefox_running && warn "Firefox is running. Restart it after the install to see the theme."

  local stamp backup=""
  stamp="$(date +%Y%m%d-%H%M%S)"
  if [[ -f "$profile/chrome/.fmd3" ]]; then
    # Upgrade: replace the theme files, keep the generated and live palettes.
    # The backup from the first install (the user's original theme) stays.
    info "Updating an existing FMD3 install"
    backup="$(mktemp -d "$profile/fmd3-update-$stamp-XXXXXX")"
    cp -a "$profile/chrome" "$backup/chrome"
    info "Saved the previous theme and customizations to $backup"
  elif [[ -e "$profile/chrome" || -f "$profile/user.js" ]]; then
    backup="$profile/fmd3-backup-$stamp"
    mkdir -p "$backup"
    [[ -e "$profile/chrome" ]] && mv "$profile/chrome" "$backup/chrome"
    [[ -f "$profile/user.js" ]] && cp -p "$profile/user.js" "$backup/user.js"
    info "Backed up the existing chrome/ and user.js to $backup"
  fi

  mkdir -p "$profile/chrome"
  cp -R "$src/chrome/." "$profile/chrome/"
  # Entry points document an override section; carry it forward on updates.
  if [[ "$backup" == "$profile"/fmd3-update-* ]]; then
    local entry
    for entry in userChrome.css userContent.css; do
      if [[ -f "$backup/chrome/$entry" ]]; then
        awk '/^\/\* Your own overrides go below this line\./ { custom = 1; next } custom { print }' \
          "$backup/chrome/$entry" >> "$profile/chrome/$entry"
      fi
    done
  fi
  printf 'FMD3 theme. install.sh uses this file to tell an upgrade from a fresh install.\n' > "$profile/chrome/.fmd3"
  info "Copied the theme to $profile/chrome"

  put_block "$profile/user.js" '// Load userChrome.css and userContent.css (required).
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
// Let toolbar and menu icons take the theme colors.
user_pref("svg.context-properties.content.enabled", true);'
  info "Enabled the stylesheet prefs in user.js"

  install_matugen
  [[ "$want_hook" == 1 ]] && install_hook

  step "${green}Done.${reset}"
  info "Restart Firefox. In Settings > Appearance, pick the \"System theme — auto\" theme"
  info "so light and dark mode follow your desktop."
  info "Undo with: $0 --uninstall"
}

do_uninstall() {
  profile="$(pick_profile)"
  step "Removing FMD3 from $profile"
  if [[ ! -f "$profile/chrome/.fmd3" ]]; then
    info "FMD3 is not installed in this profile; nothing removed."
    return
  fi
  local latest
  latest="$(ls -1d "$profile"/fmd3-backup-* 2>/dev/null | sort | tail -1 || true)"
  rm -rf "$profile/chrome"
  if [[ -n "$latest" ]]; then
    [[ -d "$latest/chrome" ]] && cp -R "$latest/chrome" "$profile/chrome" && info "Restored chrome/ from $latest"
    if [[ -f "$latest/user.js" ]]; then
      cp -p "$latest/user.js" "$profile/user.js"
      info "Restored user.js from $latest"
    else
      drop_block "$profile/user.js"
    fi
  else
    drop_block "$profile/user.js"
    info "Removed chrome/ and the FMD3 prefs"
  fi
  # Matugen: drop the FMD3 templates, keep everything else.
  local mcfg="${XDG_CONFIG_HOME:-$HOME/.config}/matugen/config.toml" tmpm
  if [[ -f "$mcfg" ]]; then
    tmpm="$(mktemp)"
    awk '
      /^# >>> FMD3/ { skip = 1; next }
      /^# <<< FMD3/ { skip = 0; next }
      /^\[templates\.firefox-m3(-pages)?\]/ { skip = 2; next }
      skip == 2 && /^\[/ { skip = 0 }
      !skip { print }' "$mcfg" > "$tmpm"
    cat "$tmpm" > "$mcfg"
    rm -f "$tmpm" "${mcfg%/*}/templates/firefox-m3.css" "${mcfg%/*}/templates/firefox-m3-pages.css"
    info "Removed the FMD3 templates from $mcfg"
  fi

  # Firefox's hook is shared across profiles and users; without the profile
  # switcher files it does nothing. Keep it for any remaining installations.
  info "Kept the shared switcher hook for other profiles (inactive in this profile)."
  step "Done. Restart Firefox."
}

case "$action" in
  list)      do_list ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
esac
