'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) passed++;
  else { failed++; console.error('FAIL:', name); }
}

function extractFunction(name) {
  const marker = source.indexOf(`function ${name}(`);
  if (marker === -1) throw new Error(`Missing function ${name}`);
  const bodyStart = source.indexOf('{', source.indexOf(')', marker));
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(marker, i + 1);
  }
  throw new Error(`Unterminated function ${name}`);
}

const context = { Date, Error, JSON, Math, Number, Object, Set, String };
vm.createContext(context);
vm.runInContext(`
  function extensionVersion() { return '4.2.test'; }
  ${extractFunction('downloadErrorText')}
  ${extractFunction('sanitizeDiagnosticText')}
  ${extractFunction('sanitizeDiagnosticContext')}
  ${extractFunction('diagnosticHttpStatus')}
  ${extractFunction('diagnosticDefinition')}
  ${extractFunction('createErrorDiagnostic')}
  globalThis.api = { sanitizeDiagnosticText, createErrorDiagnostic };
`, context);

const noSpace = context.api.createErrorDiagnostic(
  new Error('Download interrupted: FILE_NO_SPACE'),
  { errorKind: 'archive_save', failurePhase: 'archive_save' }
);
check('a no-space save failure has a stable specific code',
  noSpace.code === 'CDL-SAVE-002' && noSpace.kind === 'archive_save');

const image = context.api.createErrorDiagnostic(
  Object.assign(new Error('Image request failed: HTTP 520'), { status: 520 }),
  {
    errorKind: 'image_download',
    failurePhase: 'image_download',
    context: {
      operation: 'download_all', chapterLabel: 'Ch28', imagesExpected: 230,
      imagesSaved: 229, secret: 'must-not-survive',
    },
  }
);
check('an upstream image response has an identifiable code and HTTP status',
  image.code === 'CDL-IMAGE-002' && image.context.httpStatus === 520);
check('diagnostic context uses an allowlist',
  image.context.chapterLabel === 'Ch28' && !Object.prototype.hasOwnProperty.call(image.context, 'secret'));

const extraction = context.api.createErrorDiagnostic(
  new Error('No images were found after the reader loaded.'),
  { errorKind: 'chapter_extraction', failurePhase: 'extracting' }
);
check('an empty reader result is distinct from a general extraction failure',
  extraction.code === 'CDL-EXTRACT-002');

const runtime = context.api.createErrorDiagnostic(
  new Error('Extension context invalidated.'),
  { errorKind: 'runtime_connection', failurePhase: 'message' }
);
check('a page-to-extension disconnect has a stable runtime code',
  runtime.code === 'CDL-RUNTIME-002');

const unsafe = new Error(
  'Fetch https://cdn.example/page?token=top-secret&x=1 failed\n' +
  'Authorization: Bearer another-secret\n' +
  'data:image/png;base64,private-payload'
);
unsafe.stack = `${unsafe.message}\n${Array.from({ length: 30 }, (_, i) => `at frame${i}`).join('\n')}`;
const sanitized = context.api.createErrorDiagnostic(unsafe, {
  errorKind: 'image_download', failurePhase: 'image_download',
});
const serialized = JSON.stringify(sanitized);
check('diagnostics redact URL parameters, credentials, and embedded data',
  !serialized.includes('top-secret') && !serialized.includes('another-secret') &&
  !serialized.includes('private-payload') && serialized.includes('[parameters omitted]'));
check('diagnostic traces are bounded before storage or display',
  sanitized.stack.split('\n').length <= 15 && sanitized.stack.length <= 4000);
check('diagnostics include support correlation metadata',
  /^ERR-\d{14}-[A-Z0-9]{5}$/.test(sanitized.reference) &&
  sanitized.extensionVersion === '4.2.test' && !!Date.parse(sanitized.occurredAt));
check('diagnostics remain plain serializable data',
  JSON.parse(serialized).code === sanitized.code);

const second = context.api.createErrorDiagnostic(unsafe, {
  errorKind: 'image_download', failurePhase: 'image_download',
});
check('separate occurrences receive separate references',
  second.reference !== sanitized.reference);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
