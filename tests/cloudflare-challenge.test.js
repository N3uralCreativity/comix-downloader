'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

function inspect({ title = '', text = '', selectors = [], runtimeMarker = false }) {
  const context = {
    document: {
      title,
      body: { innerText: text },
      querySelector(selectorList) {
        return selectors.some((selector) => selectorList.includes(selector)) ? {} : null;
      },
    },
    window: runtimeMarker ? { _cf_chl_opt: {} } : {},
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('detectCloudflareChallengeDocument')}\nresult = detectCloudflareChallengeDocument();`, context);
  return context.result;
}

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', name); }
}

check('a normal chapter reader is not treated as a challenge',
  inspect({ title: 'Chapter 1', selectors: ['img.rpage-page__img'] }).challenged === false);
check('a Cloudflare title is detected',
  inspect({ title: 'Just a moment...' }).challenged === true);
check('the standard Cloudflare challenge form is detected',
  inspect({ selectors: ['form#challenge-form'] }).challenged === true);
check('the Cloudflare runtime marker is detected',
  inspect({ runtimeMarker: true }).challenged === true);
check('verification copy is detected when no reader is present',
  inspect({ text: 'Verify you are human before proceeding. Ray ID: 123' }).challenged === true);
check('reader content prevents an unrelated embedded widget from pausing downloads',
  inspect({ selectors: ['img.rpage-page__img', '.cf-turnstile'] }).challenged === false);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
