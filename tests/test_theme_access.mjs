import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const elements = new Map();
const element = () => ({
  attributes: {}, listeners: {},
  setAttribute(name, value) { this.attributes[name] = value; },
  addEventListener(name, callback) { this.listeners[name] = callback; },
  append(child) { elements.set(child.id, child); },
});
for (const id of ['mainKeyset', 'menu_ToolsPopup']) elements.set(id, element());
let startup, widget;
const opened = [];
const win = {
  document: {
    getElementById: id => elements.get(id),
    createXULElement: element,
    querySelector: () => null,
  },
  gBrowser: { tabs: [] },
  openTrustedLinkIn: (...args) => opened.push(args),
};
win.document.defaultView = win;
vm.runInNewContext(readFileSync(new URL('../chrome/m3/switcher/boot.js', import.meta.url), 'utf8'), {
  ChromeUtils: { importESModule: url => url.includes('CustomizableUI') ? {
    CustomizableUI: {
      PROVIDER_API: 'api', AREA_NAVBAR: 'navbar',
      getWidget: () => widget && { provider: 'api' },
      createWidget: value => { widget = value; },
    },
  } : { M3Theme: { init() {} } } },
  Services: { obs: { addObserver: callback => { startup = callback; } } },
  console,
});
startup(win);
const key = elements.get('m3-themes-key');
assert.equal(key.attributes.modifiers, 'accel,alt');
assert.equal(key.attributes.key, 'm');
key.listeners.command();
assert.deepEqual(opened, [['chrome://m3theme/content/switcher.html', 'tab']]);
const tab = { linkedBrowser: { currentURI: { spec: opened[0][0] } } };
win.gBrowser.tabs.push(tab);
elements.get('m3-themes-menuitem').listeners.command();
assert.equal(win.gBrowser.selectedTab, tab);
widget.onCommand({ target: { ownerDocument: win.document } });
assert.equal(opened.length, 1, 'all entry points reuse the existing tab');
startup(win);
assert.equal(elements.get('m3-themes-key'), key, 'no duplicate shortcuts');
console.log('Theme access checks passed');
