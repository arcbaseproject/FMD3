import assert from 'node:assert/strict';
import path from 'node:path';

globalThis.ChromeUtils = { importESModule: () => ({ Subprocess: {} }) };
globalThis.Ci = { nsIFile: {} };
globalThis.Services = { dirsvc: { get: () => ({ path: '/profile/chrome' }) } };
globalThis.PathUtils = { join: path.join };
const files = new Map([
  ['/profile/chrome/m3/palette.generated.css', ':root { --md-sys-color-primary: #abcdef; }'],
  ['/profile/chrome/m3/pages.palette.generated.css', '@-moz-document url-prefix("about:") { :root { --md-sys-color-surface: #123456 !important; } }'],
  ['/profile/chrome/m3/tokens.css', ':root { --md-sys-color-primary: #654321; }'],
  ['/profile/chrome/m3/pages.palette.static.css', '@-moz-document url-prefix("about:") { :root { --md-sys-color-surface: #fedcba; } }'],
]);
globalThis.IOUtils = {
  exists: async name => files.has(name),
  readUTF8: async name => {
    assert.ok(files.has(name), `Missing palette: ${name}`);
    return files.get(name);
  },
};
const { M3Theme } = await import('../chrome/m3/switcher/m3theme.sys.mjs');
let css = await M3Theme._desktopCss();
assert.ok(css.startsWith('@-moz-document url-prefix("chrome:")'));
assert.ok(css.includes('--md-sys-color-primary: #abcdef !important;'));
assert.ok(css.includes('--md-sys-color-surface: #123456 !important;'));
assert.ok(!css.includes('!important !important'));
files.delete('/profile/chrome/m3/palette.generated.css');
files.delete('/profile/chrome/m3/pages.palette.generated.css');
css = await M3Theme._desktopCss();
assert.ok(css.includes('--md-sys-color-primary: #654321 !important;'));
assert.ok(css.includes('--md-sys-color-surface: #fedcba !important;'));
console.log('Desktop palette priority, scoping, and fallback checks passed.');
