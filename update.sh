#!/usr/bin/env bash
# Installed by install.sh and run by the fmd3-update user timer.
set -euo pipefail

state="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export XDG_CONFIG_HOME="${state%/*}"
export GIT_TERMINAL_PROMPT=0
mkdir -p "$state/profiles"
exec 9> "$state/update.lock"
flock -n 9 || exit 0

shopt -s nullglob
registrations=("$state"/profiles/*)
(( ${#registrations[@]} )) || exit 0

# This checkout belongs exclusively to the updater, never the user's clone.
repo="$state/repository"
if [[ ! -d "$repo/.git" ]]; then
  staging="$(mktemp -d "$state/repository-XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  git clone --depth 1 --branch main --single-branch \
    https://github.com/arcbaseproject/FMD3.git "$staging"
  mv "$staging" "$repo"
else
  git -C "$repo" fetch --depth 1 origin main
  git -C "$repo" reset --hard FETCH_HEAD
fi
revision="$(git -C "$repo" rev-parse HEAD)"
failed=0
for registration in "${registrations[@]}"; do
  IFS= read -r profile < "$registration"
  if [[ ! -f "$profile/chrome/.fmd3" ]]; then
    rm -f "$registration"
    continue
  fi
  installed="$(cat "$profile/chrome/.fmd3-revision" 2>/dev/null || true)"
  [[ "$installed" != "$revision" ]] || continue
  if bash "$repo/install.sh" --profile "$profile" --update-only; then
    printf '%s\n' "$revision" > "$profile/chrome/.fmd3-revision"
  else
    printf 'FMD3: update failed for %s; will retry next run.\n' "$profile" >&2
    failed=1
  fi
done

# Refresh installed templates without changing which profile matugen targets.
for template in firefox-m3.css firefox-m3-pages.css; do
  target="$XDG_CONFIG_HOME/matugen/templates/$template"
  [[ ! -f "$target" ]] || cp "$repo/matugen/$template" "$target"
done

# Replace atomically: the currently running script must not be truncated.
install -m 755 "$repo/update.sh" "$state/update.sh.new"
mv "$state/update.sh.new" "$state/update.sh"
exit "$failed"
