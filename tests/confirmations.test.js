'use strict';
/**
 * Confirmation warnings (core/cdl-confirm.js), run: `node tests/confirmations.test.js`.
 * A small stand-in for the page records the dialog, so the tests click its buttons.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'cdl-confirm.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name); }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.parent = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  appendChild(node) { node.parent = this; this.children.push(node); return node; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  attachShadow() { this.shadow = new FakeNode('#shadow'); return this.shadow; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); this.parent = null; }
  focus() { page.focused = this; }
  find(className) {
    const all = [this, ...(this.shadow ? [this.shadow] : [])];
    for (const node of all) {
      if (node !== this.shadow && (' ' + node.className + ' ').includes(' ' + className + ' ')) return node;
      for (const child of node.children) { const hit = child.find(className); if (hit) return hit; }
    }
    return null;
  }
  click() { (this.listeners.click || []).forEach((fn) => fn({ target: this })); }
}

const page = { focused: null };

function makeContext({ cache = null, fetchAnswer = null, fetchFails = false } = {}) {
  const calls = { fetches: 0, stored: [] };
  const body = new FakeNode('body');
  const docListeners = {};
  const document = {
    body,
    documentElement: body,
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { docListeners[type] = (docListeners[type] || []).filter((f) => f !== fn); },
  };
  let stored = cache;
  const context = {
    document, setTimeout, clearTimeout, AbortController, Promise, Date, JSON, Array, Object, String, Number,
    fetch: async () => {
      calls.fetches++;
      if (fetchFails) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => fetchAnswer };
    },
    chrome: {
      storage: {
        local: {
          get: (key, cb) => cb(stored ? { [key]: stored } : {}),
          set: (payload) => { stored = Object.values(payload)[0]; calls.stored.push(stored); },
        },
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  const dialog = () => body.children[0] || null;
  const press = (key) => (docListeners.keydown || []).forEach((fn) => fn({ key, preventDefault() {}, stopPropagation() {} }));
  return { api: context.CDLConfirm, calls, body, dialog, press, stored: () => stored };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fresh = (items) => ({ fetchedAt: Date.now(), items });
const warning = (feature, extra = {}) => Object.assign({ feature, title: 'Careful', message: 'Comix blocks IPs.', confirmLabel: 'Download anyway' }, extra);

(async () => {
  {
    const { api, calls, dialog } = makeContext({ cache: fresh({}) });
    check('nothing active: the feature goes ahead without a dialog', (await api.ask('download-all')) === true && !dialog() && calls.fetches === 0);
    check('an unknown feature is never asked', (await api.ask('not-a-feature')) === true);
  }
  {
    const { api, dialog } = makeContext({ cache: fresh({ 'download-all': warning('download-all') }) });
    const answer = api.ask('download-all');
    await tick();
    const host = dialog();
    const title = host && host.find('title');
    const confirm = host && host.find('confirm');
    check('an active warning shows its title, message and button', !!host && title.textContent === 'Careful' &&
      host.find('message').textContent === 'Comix blocks IPs.' && confirm.textContent === 'Download anyway');
    check('Cancel has the focus, so Enter does not confirm by accident', page.focused === host.find('cancel'));
    confirm.click();
    check('continuing resolves true and closes the dialog', (await answer) === true && !dialog());
  }
  {
    const { api, dialog, press } = makeContext({ cache: fresh({ 'download-chapter': warning('download-chapter') }) });
    const cancelled = api.ask('download-chapter');
    await tick();
    dialog().find('cancel').click();
    check('Cancel resolves false', (await cancelled) === false && !dialog());
    const escaped = api.ask('download-chapter');
    await tick();
    press('Escape');
    check('Escape cancels too', (await escaped) === false && !dialog());
  }
  {
    const items = { 'plus-cloud-save': warning('plus-cloud-save', { title: 'Cloud saves are slow' }), plus: warning('plus', { title: 'Plus is in maintenance' }) };
    const { api, dialog } = makeContext({ cache: fresh(items) });
    const both = api.ask('plus-cloud-save');
    await tick();
    check('a Plus feature shows its own warning first', dialog().find('title').textContent === 'Cloud saves are slow');
    dialog().find('confirm').click();
    await tick();
    check('then the Plus warning', dialog() && dialog().find('title').textContent === 'Plus is in maintenance');
    dialog().find('confirm').click();
    check('confirming both goes ahead', (await both) === true);
    const stopped = api.ask('plus-cloud-save');
    await tick();
    dialog().find('cancel').click();
    check('cancelling the first stops there', (await stopped) === false && !dialog());
    check('"plus" is not asked for downloads', (await api.ask('download-all')) === true);
  }
  {
    const { api, dialog } = makeContext({ cache: fresh({ 'download-chapter': warning('download-chapter') }) });
    const first = api.ask('download-chapter');
    const second = api.ask('download-chapter');
    await tick();
    check('two asks at once show one dialog at a time', dialog() && dialog().parent.children.length === 1);
    dialog().find('confirm').click();
    await first;
    await tick();
    dialog().find('cancel').click();
    check('the second waits its turn', (await second) === false);
  }
  {
    const answer = { notices: [], confirmations: [warning('download-all')] };
    const { api, calls, dialog, stored } = makeContext({ cache: { fetchedAt: Date.now() - 11 * 60 * 1000, items: {} }, fetchAnswer: answer });
    const asked = api.ask('download-all');
    await tick(); await tick();
    check('a copy older than ten minutes is read again', calls.fetches === 1 && !!stored().items['download-all']);
    dialog().find('cancel').click();
    await asked;
  }
  {
    const { api, calls } = makeContext({ cache: { fetchedAt: 0, items: {} }, fetchFails: true });
    check('when the notices cannot be read, the old copy decides', (await api.ask('download-all')) === true && calls.fetches === 1);
  }
  {
    const { api, stored } = makeContext();
    api.remember([
      warning('download-all', { confirmLabel: '' }),
      { feature: 'plus', title: '', message: 'no title' },
      { feature: 'plus-sync', active: false, title: 'Off', message: 'Off' },
      { feature: 'evil', title: 'x', message: 'y' },
    ]);
    const items = stored().items;
    check('kept warnings are the complete, active, known ones', JSON.stringify(Object.keys(items)) === JSON.stringify(['download-all']));
    check('an empty button label becomes "Continue anyway"', items['download-all'].confirmLabel === 'Continue anyway');
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
