'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function extractFunction(name) {
  const marker = source.indexOf(`function ${name}(`);
  if (marker === -1) throw new Error(`Missing function ${name}`);
  const start = source.slice(Math.max(0, marker - 6), marker) === 'async ' ? marker - 6 : marker;
  const bodyStart = source.indexOf('{', source.indexOf(')', marker));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

let pulses = 0;
let cleared = 0;
let intervalCallback = null;
let intervalMs = 0;
const context = {
  chrome: {
    runtime: {
      lastError: null,
      getPlatformInfo(callback) {
        pulses++;
        if (callback) callback({ os: 'win' });
      },
    },
  },
  setInterval(callback, ms) {
    intervalCallback = callback;
    intervalMs = ms;
    return 17;
  },
  clearInterval(id) {
    if (id === 17) cleared++;
  },
};
vm.createContext(context);
vm.runInContext(`
  const PDF_KEEPALIVE_INTERVAL_MS = 15000;
  ${extractFunction('withExtensionKeepAlive')}
  globalThis.withExtensionKeepAlive = withExtensionKeepAlive;
`, context);

async function run() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const active = context.withExtensionKeepAlive(async () => {
    await gate;
    return 'complete';
  });

  if (pulses !== 1 || intervalMs !== 15000 || typeof intervalCallback !== 'function') {
    throw new Error('PDF keep-alive did not start immediately at the expected interval.');
  }
  intervalCallback();
  if (pulses !== 2) throw new Error('PDF keep-alive did not pulse during finalization.');

  release();
  if (await active !== 'complete') throw new Error('PDF keep-alive changed the task result.');
  if (cleared !== 1) throw new Error('PDF keep-alive timer was not cleared after success.');

  let rejection = '';
  try {
    await context.withExtensionKeepAlive(async () => { throw new Error('expected failure'); });
  } catch (error) {
    rejection = error.message;
  }
  if (rejection !== 'expected failure' || cleared !== 2) {
    throw new Error('PDF keep-alive did not preserve errors or clear after failure.');
  }

  console.log('\nRESULT: 5 passed, 0 failed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
