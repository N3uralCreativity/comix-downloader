(function (global, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CDLPlusTokens = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Single source of truth for every Comix Downloader Plus surface: the
  // extension settings pane, the hosted account portal, and the Plus page on
  // the site. Free extension features keep their own comix.to theming and are
  // untouched by this file.
  //
  // Generated copies live at docs/plus-tokens.css and
  // plus-worker/plus-tokens.mjs. Run scripts/sync-plus-tokens.mjs after any
  // edit here; tests/plus-tokens.test.js fails the build when they drift.

  var PREFIX = '--plus-';

  var GROUPS = [
    ['surface', [
      ['bg', '#111416', 'page behind every Plus surface'],
      ['surface', '#161a1c', 'recessed rails, sidebars, table heads'],
      ['panel', '#1b1f22', 'default panel fill'],
      ['panel-hi', '#212629', 'hover and raised panel fill'],
      ['sunken', '#0e1113', 'inputs, code blocks, wells'],
      ['line', '#262b2f', 'structural hairline, never decorative'],
      ['line-hi', '#394248', 'input borders and visible dividers']
    ]],
    ['text', [
      ['text', '#edf1f2', 'primary'],
      ['text-soft', '#bcc4c8', 'secondary body copy'],
      ['muted', '#8d969b', 'labels and captions'],
      ['faint', '#697278', 'legal text and disabled controls']
    ]],
    ['accent', [
      ['accent', '#8b5cf6', 'comix.to violet; the extension pane overrides this with the live theme colour'],
      ['accent-hi', '#a78bfa', 'accent text on dark surfaces'],
      ['accent-lo', '#7c3aed', 'pressed and hover-on-solid'],
      ['accent-wash', 'rgba(139,92,246,.13)', 'selected and highlighted fills'],
      ['accent-edge', 'rgba(139,92,246,.42)', 'accent borders'],
      ['accent-ink', '#ffffff', 'text on a solid accent fill']
    ]],
    ['status', [
      ['ok', '#54d98a'],
      ['ok-wash', 'rgba(84,217,138,.1)'],
      ['warn', '#e0ad48'],
      ['warn-wash', 'rgba(224,173,72,.1)'],
      ['danger', '#f0706f'],
      ['danger-wash', 'rgba(240,112,111,.1)']
    ]],
    ['shape', [
      ['radius', '0', 'Plus controls are rectangular on every surface'],
      ['control-h', '36px'],
      ['control-h-sm', '30px']
    ]],
    ['type', [
      ['font', "'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif"],
      ['mono', "ui-monospace,SFMono-Regular,'JetBrains Mono',Consolas,monospace"],
      ['t-micro', '10.5px'],
      ['t-tiny', '11.5px'],
      ['t-sm', '12.5px'],
      ['t-base', '13.5px'],
      ['t-md', '15px'],
      ['t-lg', '18px'],
      ['t-xl', '22px'],
      ['t-2xl', '30px'],
      ['t-3xl', '44px']
    ]],
    ['space', [
      ['s1', '4px'], ['s2', '8px'], ['s3', '12px'], ['s4', '16px'],
      ['s5', '20px'], ['s6', '24px'], ['s7', '32px'], ['s8', '40px'],
      ['s9', '56px'], ['s10', '80px']
    ]]
  ];

  // When the pane runs inside comix.to the accent must follow the live theme,
  // so the whole ramp is derived from whatever --accent resolves to.
  var ACCENT_DERIVED = {
    'accent': function (src, fallback) { return 'var(' + src + ',' + fallback + ')'; },
    'accent-hi': function (src, fallback) { return 'color-mix(in srgb,var(' + src + ',' + fallback + ') 72%,#ffffff)'; },
    'accent-lo': function (src, fallback) { return 'color-mix(in srgb,var(' + src + ',' + fallback + ') 82%,#000000)'; },
    'accent-wash': function (src, fallback) { return 'color-mix(in srgb,var(' + src + ',' + fallback + ') 13%,transparent)'; },
    'accent-edge': function (src, fallback) { return 'color-mix(in srgb,var(' + src + ',' + fallback + ') 42%,transparent)'; }
  };

  var ENTRIES = [];
  GROUPS.forEach(function (group) {
    group[1].forEach(function (entry) {
      ENTRIES.push({ group: group[0], name: entry[0], value: entry[1], note: entry[2] || '' });
    });
  });

  var TOKENS = ENTRIES.reduce(function (map, entry) { map[entry.name] = entry.value; return map; }, {});

  function varName(name) { return PREFIX + name; }
  function ref(name) { return 'var(' + PREFIX + name + ')'; }

  // options: { scope, accentFrom, inheritFont, compact, indent }
  function tokenCss(options) {
    var opts = options || {};
    var scope = opts.scope || ':root';
    var pad = typeof opts.indent === 'string' ? opts.indent : '  ';
    var lines = [];
    GROUPS.forEach(function (group, index) {
      if (index) lines.push('');
      lines.push(pad + '/* ' + group[0] + ' */');
      group[1].forEach(function (entry) {
        var name = entry[0];
        var value = entry[1];
        // The whole ramp derives from one base colour, so a custom comix.to
        // theme shifts every accent together instead of each one falling back
        // to its own violet.
        if (opts.accentFrom && ACCENT_DERIVED[name]) value = ACCENT_DERIVED[name](opts.accentFrom, TOKENS.accent);
        if (opts.inheritFont && name === 'font') value = 'inherit';
        lines.push(pad + varName(name) + ': ' + value + ';');
      });
    });
    if (opts.compact) {
      lines.push('');
      lines.push(pad + '/* compact: the pane sits inside existing settings chrome */');
      lines.push(pad + varName('control-h') + ': 32px;');
      lines.push(pad + varName('control-h-sm') + ': 27px;');
    }
    return scope + ' {\n' + lines.join('\n') + '\n}';
  }

  // Shared component layer. Every Plus surface renders the same button, field,
  // segmented control, stat strip, tab and notice so they stop being three
  // visual languages that happen to both use purple.
  function primitivesCss() {
    return [
      '.plus-eyebrow{display:inline-block;font:700 ' + ref('t-micro') + '/1 ' + ref('mono') + ';letter-spacing:.14em;text-transform:uppercase;color:' + ref('accent-hi') + '}',
      '.plus-badge{display:inline-flex;align-items:center;height:19px;padding:0 6px;border:1px solid ' + ref('accent-edge') + ';border-radius:' + ref('radius') + ';background:' + ref('accent-wash') + ';color:' + ref('accent-hi') + ';font:800 ' + ref('t-micro') + '/1 ' + ref('mono') + ';letter-spacing:.1em;text-transform:uppercase}',
      '.plus-panel{border:1px solid ' + ref('line') + ';border-radius:' + ref('radius') + ';background:' + ref('panel') + '}',
      '.plus-panel--sunken{background:' + ref('surface') + '}',

      '.plus-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:' + ref('control-h') + ';padding:0 14px;border:1px solid ' + ref('line-hi') + ';border-radius:' + ref('radius') + ';background:' + ref('panel-hi') + ';color:' + ref('text') + ';font:700 ' + ref('t-sm') + '/1.2 inherit;text-decoration:none;cursor:pointer;transition:background .12s ease,border-color .12s ease}',
      '.plus-btn:hover:not(:disabled){border-color:' + ref('accent') + ';background:' + ref('accent-wash') + '}',
      '.plus-btn:focus-visible{outline:2px solid ' + ref('accent') + ';outline-offset:1px}',
      '.plus-btn:disabled{opacity:.45;cursor:default}',
      '.plus-btn--primary{border-color:' + ref('accent') + ';background:' + ref('accent') + ';color:' + ref('accent-ink') + '}',
      '.plus-btn--primary:hover:not(:disabled){border-color:' + ref('accent-lo') + ';background:' + ref('accent-lo') + '}',
      '.plus-btn--quiet{background:transparent}',
      '.plus-btn--danger{border-color:' + ref('danger') + ';background:' + ref('danger-wash') + ';color:' + ref('danger') + '}',
      '.plus-btn--danger:hover:not(:disabled){border-color:' + ref('danger') + ';background:' + ref('danger-wash') + '}',
      '.plus-btn--sm{min-height:' + ref('control-h-sm') + ';padding:0 10px;font-size:' + ref('t-tiny') + '}',
      '.plus-btn--wide{width:100%}',

      '.plus-seg{display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;border:1px solid ' + ref('line-hi') + ';border-radius:' + ref('radius') + ';background:' + ref('sunken') + '}',
      '.plus-seg--wide{display:grid;width:100%}',
      '.plus-seg__opt{min-height:' + ref('control-h') + ';padding:0 16px;border:0;border-radius:0;background:transparent;color:' + ref('muted') + ';font:700 ' + ref('t-sm') + '/1.2 inherit;cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.plus-seg__opt+.plus-seg__opt{border-left:1px solid ' + ref('line-hi') + '}',
      '.plus-seg__opt:hover{color:' + ref('text') + '}',
      '.plus-seg__opt[aria-selected="true"]{background:' + ref('accent') + ';color:' + ref('accent-ink') + '}',

      '.plus-field{display:block}',
      '.plus-field>span{display:block;margin-bottom:6px;font:700 ' + ref('t-micro') + '/1 ' + ref('mono') + ';letter-spacing:.09em;text-transform:uppercase;color:' + ref('muted') + '}',
      '.plus-input{box-sizing:border-box;width:100%;min-height:' + ref('control-h') + ';padding:0 11px;border:1px solid ' + ref('line-hi') + ';border-radius:' + ref('radius') + ';background:' + ref('sunken') + ';color:' + ref('text') + ';font:' + ref('t-base') + '/1.4 inherit}',
      '.plus-input::placeholder{color:' + ref('faint') + '}',
      '.plus-input:focus{outline:0;border-color:' + ref('accent') + ';box-shadow:inset 0 0 0 1px ' + ref('accent') + '}',
      '.plus-input--code{font:700 ' + ref('t-md') + '/1.3 ' + ref('mono') + ';letter-spacing:.34em}',
      '.plus-inline{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}',

      '.plus-stats{display:grid;grid-template-columns:repeat(var(--plus-stats-n,4),minmax(0,1fr));gap:1px;border:1px solid ' + ref('line') + ';background:' + ref('line') + '}',
      '.plus-stat{min-width:0;padding:11px 13px;background:' + ref('panel') + '}',
      '.plus-stat>span{display:block;margin-bottom:5px;font:700 ' + ref('t-micro') + '/1 ' + ref('mono') + ';letter-spacing:.1em;text-transform:uppercase;color:' + ref('muted') + '}',
      '.plus-stat>strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 ' + ref('t-base') + '/1.25 inherit;color:' + ref('text') + '}',
      '.plus-stat--accent>strong{color:' + ref('accent-hi') + '}',
      '.plus-stat--ok>strong{color:' + ref('ok') + '}',
      '.plus-stat--warn>strong{color:' + ref('warn') + '}',

      '.plus-note{padding:11px 13px;border-left:3px solid ' + ref('accent') + ';background:' + ref('accent-wash') + ';color:' + ref('text-soft') + ';font-size:' + ref('t-sm') + ';line-height:1.55}',
      '.plus-note--ok{border-left-color:' + ref('ok') + ';background:' + ref('ok-wash') + '}',
      '.plus-note--warn{border-left-color:' + ref('warn') + ';background:' + ref('warn-wash') + '}',
      '.plus-note--error{border-left-color:' + ref('danger') + ';background:' + ref('danger-wash') + ';color:' + ref('danger') + '}',
      '.plus-note code{font:' + ref('t-tiny') + '/1.5 ' + ref('mono') + ';color:' + ref('muted') + '}',

      '.plus-tabs{display:flex;border-bottom:1px solid ' + ref('line-hi') + ';overflow-x:auto;scrollbar-width:none}',
      '.plus-tabs::-webkit-scrollbar{display:none}',
      '.plus-tab{flex:0 0 auto;margin-bottom:-1px;min-height:' + ref('control-h') + ';padding:0 15px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:' + ref('muted') + ';font:700 ' + ref('t-sm') + '/1.2 inherit;cursor:pointer}',
      '.plus-tab:hover{color:' + ref('text') + '}',
      '.plus-tab[aria-selected="true"]{color:' + ref('text') + ';border-bottom-color:' + ref('accent') + '}',

      '.plus-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid ' + ref('line') + '}',
      '.plus-row__main{min-width:0}',
      '.plus-row__main strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:' + ref('t-sm') + ';font-weight:700}',
      '.plus-row__main span{display:block;margin-top:3px;color:' + ref('muted') + ';font-size:' + ref('t-tiny') + '}',

      '.plus-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 16px;margin:0}',
      '.plus-kv dt{font:700 ' + ref('t-micro') + '/1.5 ' + ref('mono') + ';letter-spacing:.08em;text-transform:uppercase;color:' + ref('muted') + '}',
      '.plus-kv dd{margin:0;font-size:' + ref('t-sm') + ';overflow-wrap:anywhere}',

      '.plus-check{display:flex;align-items:flex-start;gap:9px;padding:10px 11px;border:1px solid ' + ref('line') + ';border-radius:' + ref('radius') + ';cursor:pointer}',
      '.plus-check:hover{border-color:' + ref('line-hi') + ';background:' + ref('panel-hi') + '}',
      '.plus-check:has(input:checked){border-color:' + ref('accent-edge') + ';background:' + ref('accent-wash') + '}',
      '.plus-check input{margin:1px 0 0;accent-color:' + ref('accent') + '}',
      '.plus-check strong{display:block;font-size:' + ref('t-sm') + ';font-weight:700}',
      '.plus-check span{display:block;margin-top:3px;color:' + ref('muted') + ';font-size:' + ref('t-tiny') + ';line-height:1.45}',

      '.plus-bar{height:2px;overflow:hidden;background:' + ref('line') + '}',
      '.plus-bar:after{content:"";display:block;width:34%;height:100%;background:' + ref('accent') + ';animation:plusBar 1s ease-in-out infinite}',
      '@keyframes plusBar{0%{transform:translateX(-110%)}100%{transform:translateX(390%)}}',
      '@media(prefers-reduced-motion:reduce){.plus-bar:after{animation:none;width:100%}.plus-btn{transition:none}}'
    ].join('\n');
  }

  function css(options) {
    return tokenCss(options) + '\n\n' + primitivesCss();
  }

  return {
    PREFIX: PREFIX,
    GROUPS: GROUPS,
    ENTRIES: ENTRIES,
    TOKENS: TOKENS,
    varName: varName,
    ref: ref,
    tokenCss: tokenCss,
    primitivesCss: primitivesCss,
    css: css
  };
});
