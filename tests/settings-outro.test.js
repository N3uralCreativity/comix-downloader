'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content', 'cdl-embed-settings.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const releaseScript = fs.readFileSync(path.join(root, 'scripts', 'build-release.ps1'), 'utf8');

const expectedFiles = [
  'dance-tina.gif',
  'dance-stick.gif',
  'dance-cat.gif',
  'dance-yellow.gif',
  'dance-man.gif',
  'dance-shaggy.gif',
  'dance-flamingo.gif',
  'outro.mp3',
];

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} is missing`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} is incomplete`);
}

const outroProximity = eval(`(${extractFunction('outroProximity')})`);
assert.strictEqual(outroProximity(181, 180, 18), 0);
assert.strictEqual(outroProximity(180, 180, 18), 0);
assert.strictEqual(outroProximity(99, 180, 18), 0.5);
assert.strictEqual(outroProximity(18, 180, 18), 1);
assert.strictEqual(outroProximity(-50, 180, 18), 1);

const backupPosition = source.indexOf('view.appendChild(makeBackupSection(activate))');
const outroPosition = source.indexOf('view.appendChild(makeOutroSection())');
assert.ok(backupPosition >= 0 && outroPosition > backupPosition, 'outro must follow Backup & Reset');
assert.ok(source.includes("text: 'Thanks for using my extension.'"));
assert.ok(source.includes('grid-template-columns:repeat(7,minmax(0,1fr))'));
assert.ok(source.includes("loading: 'eager'"));
assert.ok(source.includes('var AUDIO_START_PX = 180'));
assert.ok(source.includes('outroAudio.loop = true'));
assert.ok(source.includes('audio.muted = false'));
assert.ok(!source.includes("loading: 'lazy'"));
assert.ok(source.includes('function primeOutroAudio()'));
assert.ok(source.includes('if (audio.paused) startPlayback(true, true);'));
assert.ok(!source.includes('cdl-outro-sound'), 'the footer must not expose an audio control');
assert.ok(!source.includes('soundIcon'), 'the removed audio control icon must not return');

const activateSource = extractFunction('activate');
assert.ok(
  activateSource.indexOf('stopOutro();') < activateSource.indexOf('primeOutroAudio();'),
  'audio must be primed after the old controller is stopped'
);
assert.ok(source.includes('stopOutro();'));
assert.ok(source.includes("document.addEventListener('visibilitychange', onVisibilityChange)"));
assert.ok(source.includes("window.matchMedia('(prefers-reduced-motion: reduce)')"));

const declaredResources = manifest.web_accessible_resources
  .flatMap((entry) => entry.resources || [])
  .map((resource) => path.basename(resource))
  .sort();
assert.deepStrictEqual(declaredResources, expectedFiles.slice().sort());
assert.deepStrictEqual(manifest.web_accessible_resources[0].matches, ['*://comix.to/*']);

for (const file of expectedFiles) {
  const assetPath = path.join(root, 'assets', 'settings-outro', file);
  assert.ok(fs.existsSync(assetPath), `${file} is missing`);
  assert.ok(fs.statSync(assetPath).size > 0, `${file} is empty`);

  if (file.endsWith('.gif')) {
    const bytes = fs.readFileSync(assetPath);
    assert.strictEqual(bytes.toString('ascii', 0, 6), 'GIF89a', `${file} must remain an animated GIF`);
    assert.strictEqual(bytes.readUInt16LE(6), 160, `${file} must use the shared canvas width`);
    assert.strictEqual(bytes.readUInt16LE(8), 128, `${file} must use the shared canvas height`);
    assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0')), `${file} must retain its loop extension`);
  }
}

assert.ok(releaseScript.includes('"assets/settings-outro"'));

console.log('settings-outro.test.js: all tests passed');
