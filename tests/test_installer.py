"""Installer regressions using temporary profiles and a stub matugen."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[1] / "install.sh"


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fmd3-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / ".config/mozilla/firefox"
        self.profile = self.root / "test"
        self.profile.mkdir(parents=True)
        (self.root / "profiles.ini").write_text(
            "[Profile0]\nName=test\nIsRelative=1\nPath=test\nDefault=1\n"
        )
        bin_dir = self.home / "bin"
        bin_dir.mkdir()
        self.systemctl_log = self.home / "systemctl.log"
        for name, body in {
            "matugen": "exit 0",
            "pgrep": "exit 1",
            "systemctl": 'printf "%s\\n" "$*" >> "$FMD3_SYSTEMCTL_LOG"',
        }.items():
            command = bin_dir / name
            command.write_text(f"#!/bin/sh\n{body}\n")
            command.chmod(0o755)
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FMD3_SYSTEMCTL_LOG": str(self.systemctl_log),
            "XDG_DATA_HOME": str(self.home / ".local/share"),
            "XDG_DATA_DIRS": str(self.home / "system"),
        }
        system_apps = self.home / "system/applications"
        system_apps.mkdir(parents=True)
        (system_apps / "firefox.desktop").write_text(
            "[Desktop Entry]\nName=Firefox\nExec=firefox %U\nIcon=firefox\n"
            "\n[Desktop Action new-window]\nExec=firefox --new-window %U\n"
        )
        self.desktop = self.home / ".local/share/applications/firefox.desktop"
        self.icon = self.home / ".local/share/icons/hicolor/scalable/apps/fmd3-firefox.svg"
        self.chrome = self.profile / "chrome"
        self.config = self.home / ".config/matugen/config.toml"
        self.firefox = self.home / "firefox"
        self.firefox.mkdir()
        (self.firefox / "omni.ja").touch()
        self.updater = self.home / ".config/fmd3"

    def make_update_remote(self):
        self.remote = self.home / "remote"
        self.remote.mkdir()
        for entry in ("install.sh", "update.sh", "chrome", "docs", "matugen"):
            source = INSTALLER.parent / entry
            target = self.remote / entry
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copy2(source, target)
        self.git("init", "-b", "main")
        self.commit_remote()
        real_git = shutil.which("git")
        wrapper = self.home / "bin/git"
        wrapper.write_text(
            '#!/usr/bin/env bash\n'
            'if [[ "$1" == clone ]]; then\n'
            '  for destination; do :; done\n'
            '  exec "$FMD3_REAL_GIT" clone --depth 1 --branch main --single-branch '
            '"$FMD3_TEST_REMOTE" "$destination"\n'
            'fi\nexec "$FMD3_REAL_GIT" "$@"\n'
        )
        wrapper.chmod(0o755)
        self.env.update(FMD3_REAL_GIT=real_git, FMD3_TEST_REMOTE=self.remote.as_uri())

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.remote), *args], text=True, stderr=subprocess.PIPE,
        ).strip()

    def commit_remote(self):
        self.git("add", ".")
        self.git("-c", "user.name=FMD3 Tests", "-c", "user.email=test@example.invalid",
                 "commit", "-m", "Test update")
        return self.git("rev-parse", "HEAD")

    def run_updater(self, success=True):
        result = subprocess.run(
            ["bash", str(self.updater / "update.sh")], env=self.env,
            capture_output=True, text=True, timeout=20,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def run_installer(self, *args, profile=None):
        result = subprocess.run(
            ["bash", str(INSTALLER), "--profile", str(profile or self.profile),
             "--firefox-dir", str(self.firefox), *args],
            env=self.env, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_uninstall_unmarked_profile_is_noop(self):
        self.chrome.mkdir()
        original = self.chrome / "userChrome.css"
        original.write_text("original theme")
        self.run_installer("--uninstall")
        self.assertEqual(original.read_text(), "original theme")

    def test_repeated_uninstall_preserves_restored_theme(self):
        self.chrome.mkdir()
        original = self.chrome / "userChrome.css"
        original.write_text("original theme")
        self.run_installer("--no-hook")
        self.run_installer("--uninstall")
        self.assertNotIn("FMD3", (self.profile / "user.js").read_text())
        self.run_installer("--uninstall")
        self.assertEqual(original.read_text(), "original theme")

    def test_icon_overrides_system_launcher_and_uninstall_removes_it(self):
        self.run_installer("--no-hook")
        self.assertTrue(self.icon.is_file())
        entry = self.desktop.read_text()
        self.assertIn("Icon=fmd3-firefox", entry)
        self.assertNotIn("Icon=firefox\n", entry)
        self.assertIn("[Desktop Entry]\nX-FMD3-Created=true\n", entry)
        self.assertIn("[Desktop Action new-window]", entry)
        self.run_installer("--no-hook")
        self.assertEqual(self.desktop.read_text(), entry)
        self.run_installer("--uninstall")
        self.assertFalse(self.desktop.exists())
        self.assertFalse(self.icon.exists())

    def test_icon_restores_existing_user_launcher(self):
        self.desktop.parent.mkdir(parents=True)
        original = "[Desktop Entry]\nName=My Firefox\nIcon=custom-fox\n"
        self.desktop.write_text(original)
        self.run_installer("--no-hook")
        self.assertIn("Icon=fmd3-firefox", self.desktop.read_text())
        self.assertIn("X-FMD3-OriginalIcon=custom-fox", self.desktop.read_text())
        self.run_installer("--uninstall")
        self.assertEqual(self.desktop.read_text(), original)

    def test_no_icon_removes_earlier_icon(self):
        self.run_installer("--no-hook")
        self.run_installer("--no-hook", "--no-icon")
        self.assertFalse(self.desktop.exists())
        self.assertFalse(self.icon.exists())

    def test_update_expands_saved_palette_scope(self):
        self.run_installer("--no-hook")
        for name in ("pages.palette.generated.css", "palette.live.css"):
            palette = self.chrome / "m3" / name
            palette.write_text('@-moz-document url-prefix("about:preferences") {\n'
                               ':root { --md-sys-color-primary: #abcdef; }\n}\n')
        self.run_installer("--no-hook")
        for name in ("pages.palette.generated.css", "palette.live.css"):
            css = (self.chrome / "m3" / name).read_text()
            self.assertIn('regexp("about:', css)
            self.assertIn('blank(?:[?#]|$)', css)
            self.assertIn('--md-sys-color-primary: #abcdef;', css)
            self.assertEqual('url-prefix("chrome:")' in css, name == "palette.live.css")

    def test_update_preserves_customizations_and_backup(self):
        self.run_installer("--no-hook")
        for entry in ("userChrome.css", "userContent.css"):
            with (self.chrome / entry).open("a") as handle:
                handle.write("\n/* custom override */\n")
        (self.chrome / "custom.css").write_text("custom file")
        (self.chrome / "m3/tokens.css").write_text("edited bundled file")
        (self.chrome / "m3/palette.live.css").write_text("live palette")
        self.run_installer("--no-hook")
        backup = next(self.profile.glob("fmd3-update-*/chrome"))
        self.assertEqual((backup / "m3/tokens.css").read_text(), "edited bundled file")
        self.assertEqual((self.chrome / "custom.css").read_text(), "custom file")
        self.assertEqual((self.chrome / "m3/palette.live.css").read_text(), "live palette")
        self.run_installer("--no-hook")
        for entry in ("userChrome.css", "userContent.css"):
            self.assertEqual((self.chrome / entry).read_text().count("/* custom override */"), 1)

    def test_uninstall_keeps_shared_hook_for_other_profile(self):
        other = self.root / "other"
        other.mkdir()
        self.run_installer()
        self.run_installer(profile=other)
        hook = self.firefox / "mozilla.cfg"
        before = hook.read_bytes()
        self.run_installer("--uninstall")
        self.assertEqual(hook.read_bytes(), before)
        self.assertTrue((self.firefox / "defaults/pref/fmd3-autoconfig.js").exists())
        self.assertTrue((other / "chrome/m3/switcher/boot.js").exists())

    def test_fresh_matugen_config_is_cleaned(self):
        self.run_installer("--no-hook")
        self.assertIn("# >>> FMD3", self.config.read_text())
        self.run_installer("--uninstall")
        self.assertNotIn("templates.firefox-m3", self.config.read_text())

    def test_legacy_matugen_config_preserves_other_sections(self):
        self.run_installer("--no-hook")
        self.config.write_text(
            "[config]\n[templates.firefox-m3]\noutput_path = 'old'\n"
            "[templates.firefox-m3-pages]\noutput_path = 'old-pages'\n"
            "[templates.terminal]\noutput_path = 'keep'\n"
        )
        self.run_installer("--uninstall")
        self.assertEqual(self.config.read_text(),
                         "[config]\n[templates.terminal]\noutput_path = 'keep'\n")

    def test_original_user_preferences_are_restored(self):
        prefs = self.profile / "user.js"
        prefs.write_text('user_pref("example", true);\n')
        self.run_installer("--no-hook")
        self.run_installer("--uninstall")
        self.assertEqual(prefs.read_text(), 'user_pref("example", true);\n')

    def test_updater_install_and_opt_out(self):
        self.run_installer("--no-hook")
        units = self.home / ".config/systemd/user"
        self.assertIn("OnCalendar=daily", (units / "fmd3-update.timer").read_text())
        self.assertIn(str(self.updater / "update.sh"),
                      (units / "fmd3-update.service").read_text())
        self.assertEqual(len(list((self.updater / "profiles").iterdir())), 1)
        self.assertIn("--user enable --now fmd3-update.timer", self.systemctl_log.read_text())
        self.run_installer("--no-hook", "--no-auto-update")
        self.assertFalse((units / "fmd3-update.timer").exists())
        self.assertEqual(list((self.updater / "profiles").iterdir()), [])

    def test_uninstall_only_disables_timer_after_last_profile(self):
        other = self.root / "other"
        other.mkdir()
        self.run_installer("--no-hook")
        self.run_installer("--no-hook", profile=other)
        self.run_installer("--uninstall")
        self.assertNotIn("disable --now", self.systemctl_log.read_text())
        self.assertEqual(len(list((self.updater / "profiles").iterdir())), 1)
        self.run_installer("--uninstall", profile=other)
        self.assertIn("disable --now fmd3-update.timer", self.systemctl_log.read_text())

    def test_updater_pulls_commits_preserving_customizations(self):
        self.make_update_remote()
        self.run_installer("--no-hook")
        with (self.chrome / "userChrome.css").open("a") as handle:
            handle.write("\n/* retained override */\n")
        (self.chrome / "custom.css").write_text("custom file")
        (self.chrome / "m3/palette.live.css").write_text("saved palette")
        original_config = self.config.read_bytes()
        self.run_updater()
        backups = list(self.profile.glob("fmd3-update-*"))
        self.run_updater()
        self.assertEqual(list(self.profile.glob("fmd3-update-*")), backups)
        (self.remote / "chrome/m3/frame.css").write_text("/* latest commit */\n")
        revision = self.commit_remote()
        self.run_updater()
        self.assertEqual((self.chrome / "m3/frame.css").read_text(), "/* latest commit */\n")
        self.assertEqual((self.chrome / ".fmd3-revision").read_text().strip(), revision)
        self.assertEqual((self.chrome / "custom.css").read_text(), "custom file")
        self.assertEqual((self.chrome / "m3/palette.live.css").read_text(), "saved palette")
        self.assertEqual((self.chrome / "userChrome.css").read_text().count("/* retained override */"), 1)
        self.assertEqual(self.config.read_bytes(), original_config)

    def test_failed_fetch_does_not_change_profile(self):
        self.make_update_remote()
        self.run_installer("--no-hook")
        self.run_updater()
        before = (self.chrome / ".fmd3-revision").read_bytes()
        self.remote.rename(self.home / "offline-remote")
        self.run_updater(success=False)
        self.assertEqual((self.chrome / ".fmd3-revision").read_bytes(), before)
        self.assertEqual(len(list(self.profile.glob("fmd3-update-*"))), 1)

    def test_updater_does_not_reinstall_removed_theme(self):
        self.make_update_remote()
        self.run_installer("--no-hook")
        (self.chrome / ".fmd3").unlink()
        self.run_updater()
        self.assertFalse((self.chrome / ".fmd3").exists())
        self.assertEqual(list((self.updater / "profiles").iterdir()), [])

    def test_updater_supports_profile_outside_profiles_ini(self):
        self.make_update_remote()
        outside = self.home / "external profile"
        outside.mkdir()
        (self.root / "profiles.ini").unlink()
        self.run_installer("--no-hook", profile=outside)
        self.run_updater()
        self.assertTrue((outside / "chrome/.fmd3-revision").exists())

    def test_failed_profile_is_retried_without_blocking_other_profiles(self):
        self.make_update_remote()
        other = self.root / "other"
        other.mkdir()
        self.run_installer("--no-hook")
        self.run_installer("--no-hook", profile=other)
        installer = self.remote / "install.sh"
        original = installer.read_text()
        installer.write_text(original.replace(
            "set -euo pipefail\n",
            'set -euo pipefail\n[[ "${2:-}" != */test ]] || exit 7\n', 1,
        ))
        self.commit_remote()
        self.run_updater(success=False)
        self.assertFalse((self.chrome / ".fmd3-revision").exists())
        self.assertTrue((other / "chrome/.fmd3-revision").exists())
        installer.write_text(original)
        revision = self.commit_remote()
        self.run_updater()
        self.assertEqual((self.chrome / ".fmd3-revision").read_text().strip(), revision)

    def test_timer_failure_does_not_fail_theme_install(self):
        (self.home / "bin/systemctl").write_text("#!/bin/sh\nexit 1\n")
        self.run_installer("--no-hook")
        self.assertTrue((self.chrome / ".fmd3").exists())
        self.assertTrue((self.updater / "update.sh").exists())


if __name__ == "__main__":
    unittest.main()
