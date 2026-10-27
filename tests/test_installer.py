"""Installer regressions using temporary profiles and a stub matugen."""

import os
from pathlib import Path
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
        for name, body in {"matugen": "exit 0", "pgrep": "exit 1"}.items():
            command = bin_dir / name
            command.write_text(f"#!/bin/sh\n{body}\n")
            command.chmod(0o755)
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
        }
        self.chrome = self.profile / "chrome"
        self.config = self.home / ".config/matugen/config.toml"
        self.firefox = self.home / "firefox"
        self.firefox.mkdir()
        (self.firefox / "omni.ja").touch()

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


if __name__ == "__main__":
    unittest.main()
