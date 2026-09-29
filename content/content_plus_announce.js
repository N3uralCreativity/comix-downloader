/**
 * content_plus_announce.js - the Comix Downloader Plus announcement on comix.to.
 *
 * content_notices.js hands over an active "promotion" notice from the notices
 * Worker. The first time a reader meets a notice revision it fills the screen;
 * closing it shrinks it into a small phone in the bottom-right corner, which stays
 * on every comix.to page while the notice is active. It never shows in the reader,
 * while the Download All panel is open, for Plus members, or when the
 * "Show Plus announcements" setting is off. Class names stay neutral because
 * ad-blocker lists hide page elements named like ads.
 */
(function (root) {
  'use strict';

  if (root.__cdlPlusAnnounce) return;

  const HOST_ID = 'cdl-plus-root';
  const SEEN_KEY = 'cdlPlusAnnounceSeen';
  const PLUS_STATE_KEY = 'cdlPlusState';
  const SETTING_KEY = 'features.plusAnnouncements';
  const MAX_SEEN = 20;
  const TICK_MS = 800;
  const LEAVE_MS = 450;
  const BUBBLE_MS = 9000;
  // Launch phase: the first full screen is a short showing. It fades in, stays a moment,
  // then shrinks into the corner on its own; readers reopen it from the corner.
  const LAUNCH_FADE_MS = 700;
  const LAUNCH_HOLD_MS = 2000;
  const LAUNCH_RESUME_MS = 1200;
  const MEMBER_STATES = new Set(['trial', 'active', 'grace', 'cancelled_active']);
  const DEFAULT_URLS = {
    soon: 'https://n3uralcreativity.top/comix-downloader/plus.html',
    launch: 'https://plus.n3uralcreativity.top/account?mode=create',
  };
  const COPY = {
    soon: {
      pill: 'Coming very soon',
      word: 'SOON',
      notes: 'almost ready',
      cta: 'See what’s coming →',
      fine: 'You’ll see it here the day it opens. 30 days free at launch.',
      chip: 'PLUS · VERY SOON',
      bubble: 'Download All is getting a cloud. Very soon.',
    },
    launch: {
      pill: 'Out now',
      word: 'NOW',
      notes: 'release notes',
      cta: 'Start 30 days free →',
      fine: 'then US$1.50/month · cancel anytime',
      chip: 'PLUS · 30 DAYS FREE',
      bubble: 'Save this one to your Cloud Library.',
    },
  };
  const NOTES = [
    ['+', 'Cloud Library', 'read anywhere & offline'],
    ['+', 'Release Agenda', 'when your series return'],
    ['+', 'Sync', 'up to five browsers'],
    ['=', '', 'Everything free today stays free'],
  ];

  // ── Pure helpers (also exercised by tests/plus-announce.test.js) ─────────────
  function pageKind(pathname) {
    const path = String(pathname || '');
    if (/^\/title\/[^/]+\/\d+-chapter-/i.test(path)) return 'reader';
    if (/^\/title\/[^/]+\/?$/i.test(path)) return 'title';
    return 'other';
  }

  function phaseOf(promo) {
    return promo && promo.phase === 'launch' ? 'launch' : 'soon';
  }

  function ctaUrl(promo) {
    return (promo && promo.ctaUrl) || DEFAULT_URLS[phaseOf(promo)];
  }

  function revisionKey(promo) {
    return promo.id + '|' + (promo.updatedAt || 'static');
  }

  function isMemberState(plusState) {
    const state = plusState && plusState.account && plusState.account.state;
    return MEMBER_STATES.has(state);
  }

  // How long a full screen stays before shrinking into the corner by itself: only the
  // launch phase's first showing does; one a reader opens from the corner stays until closed.
  function autoCloseDelay(phase, openedByReader) {
    return phase === 'launch' && !openedByReader ? LAUNCH_FADE_MS + LAUNCH_HOLD_MS : 0;
  }

  // Full screen once per revision, then the corner piece; nothing where it would get in the way.
  function decideMode(s) {
    if (!s.enabled || s.member || s.kind === 'reader' || s.busy) return 'hidden';
    if (s.userMode === 'full' || s.userMode === 'mini') return s.userMode;
    if (!s.seen && !s.holdFull && !s.autoOpened) return 'full';
    return 'mini';
  }

  // ── Extension storage ───────────────────────────────────────────────────────
  function storageArea() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) return chrome.storage.local;
    } catch (_) {}
    return null;
  }

  function storageGet(key) {
    const area = storageArea();
    if (!area) return Promise.resolve({});
    return new Promise((resolve) => {
      try {
        area.get(key, (data) => {
          try { if (chrome.runtime && chrome.runtime.lastError) { resolve({}); return; } } catch (_) {}
          resolve(data || {});
        });
      } catch (_) {
        resolve({});
      }
    });
  }

  function storageSet(payload) {
    const area = storageArea();
    if (!area) return Promise.resolve();
    return new Promise((resolve) => {
      try { area.set(payload, () => resolve()); } catch (_) { resolve(); }
    });
  }

  async function readSeen() {
    const data = await storageGet(SEEN_KEY);
    const list = data[SEEN_KEY];
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
  }

  async function rememberSeen(promo) {
    const key = revisionKey(promo);
    const list = (await readSeen()).filter((item) => item !== key);
    list.push(key);
    const payload = {};
    payload[SEEN_KEY] = list.slice(-MAX_SEEN);
    await storageSet(payload);
  }

  async function readMembership() {
    const data = await storageGet(PLUS_STATE_KEY);
    return isMemberState(data[PLUS_STATE_KEY]);
  }

  function settingsApi() {
    return root.CDLSettings && typeof root.CDLSettings.getSettings === 'function' ? root.CDLSettings : null;
  }

  async function readEnabled() {
    const api = settingsApi();
    if (!api) return true;
    try {
      const cfg = await api.getSettings();
      return cfg[SETTING_KEY] !== false;
    } catch (_) {
      return true;
    }
  }

  function assetUrl(path) {
    try { return chrome.runtime.getURL(path); } catch (_) { return ''; }
  }

  function prefersCalm() {
    try { return root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────
  const STYLE = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .scope {
      --violet: #8b5cf6; --lilac: #bda7ff; --ink: #15171b;
      --soon: #f59e0b; --soon-text: #fcd34d; --now: #22c55e; --now-text: #86efac;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      --mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
      --heavy: "Arial Black", "Segoe UI Black", Impact, var(--sans);
      --tone: radial-gradient(circle, rgba(255,255,255,.22) 0 1.05px, transparent 1.55px);
    }
    a, button { -webkit-tap-highlight-color: transparent; }

    /* Full screen */
    .full {
      position: fixed; inset: 0; z-index: 2147483645;
      color: #f4f4f6; font-family: var(--sans); -webkit-font-smoothing: antialiased;
      transition: opacity .35s ease, transform .5s cubic-bezier(.2, .8, .2, 1);
      transform-origin: 95% 95%;
      outline: none;
    }
    .full.is-entering { opacity: 0; transform: scale(.98); }
    .full.is-brief { transition: opacity .7s ease, transform .7s cubic-bezier(.2, .8, .2, 1); }
    .full.is-leaving { opacity: 0; transform: scale(.14); pointer-events: none; }
    .bg { position: absolute; inset: 0; background: rgba(28, 20, 64, .99); }
    .bg::after {
      content: ""; position: absolute; inset: 0;
      background-image: var(--tone); background-size: 11px 11px;
      -webkit-mask: linear-gradient(115deg, transparent 38%, #000 100%);
      mask: linear-gradient(115deg, transparent 38%, #000 100%);
    }
    .canvas {
      position: absolute; left: 50%; top: 50%;
      width: min(100vw, 144vh); aspect-ratio: 1440 / 1000;
      transform: translate(-50%, -50%);
      container-type: inline-size;
    }
    .word {
      position: absolute; right: -1cqw; bottom: -5.2cqw;
      font: 900 26cqw/1 var(--heavy); letter-spacing: -.02em;
      color: transparent; -webkit-text-stroke: .16cqw rgba(189, 167, 255, .26);
      pointer-events: none; user-select: none;
    }
    .left {
      position: absolute; left: 5cqw; top: 50%; transform: translateY(-50%);
      width: 40cqw; display: grid; gap: 1.7cqw; z-index: 2;
    }
    .status { display: flex; align-items: center; gap: 1.2cqw; flex-wrap: wrap; }
    .by { font: 600 clamp(9px, .95cqw, 12px)/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--lilac); }
    .pill {
      display: inline-flex; align-items: center; gap: .6cqw; padding: .55cqw .9cqw;
      border: 1px solid rgba(245, 158, 11, .55); background: rgba(245, 158, 11, .14); color: var(--soon-text);
      font: 700 clamp(9px, .95cqw, 12px)/1 var(--mono); letter-spacing: .1em; text-transform: uppercase;
    }
    .pill::before, .st::before {
      content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--soon);
      animation: cdl-plus-pulse 1.4s infinite;
    }
    .scope[data-phase="launch"] .pill { border-color: rgba(34, 197, 94, .5); background: rgba(34, 197, 94, .12); color: var(--now-text); }
    .scope[data-phase="launch"] .pill::before, .scope[data-phase="launch"] .st::before { background: var(--now); }
    h2 { margin: 0; font: 800 clamp(24px, 4.4cqw, 64px)/.98 var(--sans); letter-spacing: -.04em; color: #fff; }
    h2 span { display: block; color: var(--lilac); }
    .notes { background: #0e1116; border: 1px solid #2b3240; font-family: var(--mono); color: #c9d1d9; }
    .notes .hd {
      display: flex; align-items: center; gap: 1cqw; padding: .8cqw 1.2cqw;
      border-bottom: 1px solid #2b3240; font-size: clamp(9px, 1cqw, 13px); color: #8b949e;
    }
    .notes .ver { padding: .3cqw .6cqw; border: 1px solid var(--violet); color: var(--lilac); font-weight: 700; }
    .notes .rows { padding: .6cqw 0; display: grid; }
    .notes .ln {
      display: grid; grid-template-columns: 2.8cqw 1fr; padding-right: 1.2cqw;
      font-size: clamp(9px, 1.12cqw, 15px); line-height: 2; white-space: nowrap;
    }
    .notes .sg { text-align: center; }
    .notes .add { background: rgba(46, 160, 67, .12); }
    .notes .add .sg { color: #3fb950; }
    .notes .keep .sg { color: #8b949e; }
    .notes b { color: #fff; font-weight: 700; }
    .act { display: flex; align-items: center; gap: 1.4cqw; flex-wrap: wrap; }
    .cta {
      display: inline-flex; align-items: center; padding: 1.1cqw 1.7cqw;
      border-radius: 3px; background: var(--lilac); color: var(--ink); text-decoration: none;
      font: 700 clamp(12px, 1.45cqw, 19px)/1 var(--sans); white-space: nowrap;
      box-shadow: .5cqw .5cqw 0 var(--violet); transition: transform .15s ease, box-shadow .15s ease;
    }
    .cta:hover { transform: translate(-2px, -2px); box-shadow: calc(.5cqw + 2px) calc(.5cqw + 2px) 0 var(--violet); }
    .fine { font-size: clamp(10px, 1.05cqw, 14px); color: #d9d6ea; max-width: 22cqw; line-height: 1.35; }
    .laptop { position: absolute; right: 6cqw; top: 12cqw; width: 42cqw; z-index: 1; }
    .laptop .scr {
      border: .5cqw solid #0b0b0d; border-bottom-width: .9cqw; border-radius: .6cqw .6cqw 0 0;
      overflow: hidden; background: #000; aspect-ratio: 16 / 10;
    }
    .laptop img, .phone img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
    .laptop .base { height: 1.2cqw; margin: 0 -3cqw; background: linear-gradient(#2a2b2f, #151618); border-radius: 0 0 1.2cqw 1.2cqw; }
    .phone {
      position: absolute; right: 2.6cqw; top: 28cqw; width: 12cqw; aspect-ratio: 780 / 1688; z-index: 3;
      border: .5cqw solid #0b0b0d; border-radius: 1.8cqw; overflow: hidden; background: #000;
      box-shadow: -1cqw 1cqw 0 rgba(0, 0, 0, .35);
    }
    .chip {
      position: absolute; right: 3cqw; top: 55.6cqw; z-index: 4; padding: .5cqw .8cqw;
      background: var(--lilac); color: var(--ink);
      font: 700 clamp(9px, .95cqw, 12px)/1 var(--mono); letter-spacing: .05em; text-transform: uppercase;
    }
    .close {
      position: fixed; top: 16px; right: 16px; z-index: 5;
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px;
      border: 1px solid rgba(255, 255, 255, .28); border-radius: 3px; background: rgba(0, 0, 0, .3); color: #fff;
      font: 600 13px/1 var(--sans); cursor: pointer;
    }
    .close:hover { background: rgba(0, 0, 0, .55); }
    .foot {
      position: fixed; left: 16px; right: 16px; bottom: 12px; z-index: 5;
      display: flex; justify-content: center; flex-wrap: wrap; gap: 4px 10px;
      font: 12px/1.4 var(--sans); color: rgba(217, 214, 234, .75); text-align: center;
    }
    .off {
      border: 0; padding: 0; background: none; color: inherit; font: inherit;
      text-decoration: underline; text-underline-offset: 3px; cursor: pointer;
    }
    .off:hover { color: #fff; }

    /* Corner piece */
    .corner {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
      display: grid; justify-items: center; gap: 6px;
      margin: 0; padding: 0; border: 0; background: none; color: #fff; font: inherit; cursor: pointer;
      transition: opacity .3s ease, transform .4s cubic-bezier(.2, .8, .2, 1), bottom .3s ease;
    }
    .corner.is-entering { opacity: 0; transform: translateY(14px) scale(.85); }
    .corner.is-lifted { bottom: 136px; }
    .ph {
      width: 58px; aspect-ratio: 780 / 1688; border: 3px solid #0b0b0d; border-radius: 10px;
      background: #000 center top / cover no-repeat;
      box-shadow: 0 0 0 2px var(--lilac), 5px 5px 0 rgba(0, 0, 0, .4);
      transition: transform .2s ease;
    }
    .corner:hover .ph { transform: translateY(-3px); }
    .st {
      display: inline-flex; align-items: center; gap: 5px; padding: 4px 7px;
      background: var(--violet); color: #fff; white-space: nowrap;
      font: 700 10px/1 var(--mono); letter-spacing: .08em;
    }
    .bubble {
      position: absolute; right: calc(100% + 14px); top: 10px; width: 212px;
      padding: 9px 11px; background: #fff; color: #0f0f10; text-align: left;
      border: 2px solid #0f0f10; border-radius: 12px; box-shadow: 4px 4px 0 var(--violet);
      font: 700 13px/1.3 var(--sans);
      transition: opacity .25s ease, transform .25s ease;
    }
    /* After a few seconds the bubble tucks behind the phone; hovering the phone brings it back. */
    .bubble.is-tucked { opacity: 0; transform: translateX(10px); pointer-events: none; }
    .corner:hover .bubble.is-tucked, .corner:focus-visible .bubble.is-tucked { opacity: 1; transform: none; }
    .bubble::before {
      content: ""; position: absolute; right: -15px; top: 14px;
      border: 8px solid transparent; border-left: 14px solid #0f0f10;
    }
    .bubble::after {
      content: ""; position: absolute; right: -10px; top: 17px;
      border: 5px solid transparent; border-left: 10px solid #fff;
    }
    .bubble small { display: block; margin-bottom: 3px; font: 700 9px/1 var(--mono); letter-spacing: .1em; color: #6d3fd6; }
    .ring {
      position: fixed; z-index: 2147483000; pointer-events: none;
      border: 3px solid var(--lilac); border-radius: 8px; opacity: 0;
      animation: cdl-plus-ring 1.6s ease-out .2s 2 forwards;
    }
    .close:focus-visible, .cta:focus-visible, .off:focus-visible, .corner:focus-visible {
      outline: 3px solid rgba(189, 167, 255, .8); outline-offset: 3px;
    }
    @keyframes cdl-plus-pulse { 50% { opacity: .3; } }
    @keyframes cdl-plus-ring {
      0% { opacity: 1; box-shadow: 0 0 0 0 rgba(189, 167, 255, .6); }
      80% { opacity: 1; box-shadow: 0 0 0 18px rgba(189, 167, 255, 0); }
      100% { opacity: 0; }
    }

    /* Phones and tall windows: one readable column, no devices */
    @media (max-width: 760px), (max-aspect-ratio: 1/1) {
      .canvas {
        inset: 0; left: 0; top: 0; width: auto; aspect-ratio: auto; transform: none; container-type: normal;
        display: flex; align-items: center; justify-content: center; overflow-x: hidden; overflow-y: auto; padding: 64px 20px 76px;
      }
      .left { position: relative; left: auto; top: auto; transform: none; width: 100%; max-width: 440px; gap: 16px; }
      .laptop, .phone, .chip { display: none; }
      .word { font-size: 38vw; bottom: -7vw; right: -2vw; -webkit-text-stroke-width: 1.5px; }
      .by, .pill { font-size: 10.5px; }
      .pill { padding: 5px 8px; gap: 6px; }
      h2 { font-size: 34px; }
      .notes .hd { font-size: 11px; padding: 8px 12px; gap: 8px; }
      .notes .ver { padding: 3px 6px; }
      .notes .ln { font-size: 12.5px; grid-template-columns: 26px 1fr; padding-right: 12px; white-space: normal; line-height: 1.8; }
      .cta { font-size: 15px; padding: 12px 16px; box-shadow: 4px 4px 0 var(--violet); }
      .fine { font-size: 12.5px; max-width: none; }
      .ph { width: 44px; }
      .bubble { width: 172px; font-size: 12px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .full, .corner, .ph, .cta { transition: none !important; }
      .pill::before, .st::before, .ring { animation: none !important; }
      .ring { display: none; }
    }
  `;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function buildFull(promo, copy) {
    const full = el('div', 'full');
    full.setAttribute('role', 'dialog');
    full.setAttribute('aria-modal', 'true');
    full.setAttribute('aria-labelledby', 'cdl-plus-title');
    full.tabIndex = -1;
    full.hidden = true;

    const canvas = el('div', 'canvas');
    const word = el('div', 'word', copy.word);
    word.setAttribute('aria-hidden', 'true');

    const left = el('div', 'left');
    const status = el('div', 'status');
    status.append(el('span', 'by', 'Comix Downloader Plus'), el('span', 'pill', copy.pill));
    const title = el('h2', '', 'Save it once. ');
    title.id = 'cdl-plus-title';
    title.appendChild(el('span', '', 'Read it anywhere & offline.'));

    const notes = el('div', 'notes');
    const head = el('div', 'hd');
    head.append(el('span', 'ver', 'v4.3.0'), el('span', '', copy.notes));
    const rows = el('div', 'rows');
    NOTES.forEach(([sign, name, text]) => {
      const row = el('div', 'ln ' + (sign === '+' ? 'add' : 'keep'));
      const body = el('span');
      if (name) body.append(el('b', '', name), document.createTextNode(' · ' + text));
      else body.textContent = text;
      row.append(el('span', 'sg', sign), body);
      rows.appendChild(row);
    });
    notes.append(head, rows);

    const act = el('div', 'act');
    const cta = el('a', 'cta', copy.cta);
    cta.href = ctaUrl(promo);
    cta.target = '_blank';
    cta.rel = 'noopener noreferrer';
    act.append(cta, el('span', 'fine', copy.fine));
    left.append(status, title, notes, act);

    const laptop = el('div', 'laptop');
    const screen = el('div', 'scr');
    const library = el('img');
    library.src = assetUrl('assets/plus-announce/cloud-library.jpg');
    library.alt = 'The Plus Cloud Library on a computer';
    screen.appendChild(library);
    laptop.append(screen, el('div', 'base'));
    const phone = el('div', 'phone');
    const reader = el('img');
    reader.src = assetUrl('assets/plus-announce/cloud-phone.jpg');
    reader.alt = 'A saved chapter open on a phone';
    phone.appendChild(reader);

    canvas.append(word, left, laptop, phone, el('span', 'chip', 'Phone · offline'));

    const close = el('button', 'close', 'Close ✕');
    close.type = 'button';
    const foot = el('div', 'foot');
    const off = el('button', 'off', 'Turn off Plus announcements');
    off.type = 'button';
    foot.append(el('span', '', 'Shown by the Comix Downloader extension'), off);

    full.append(el('div', 'bg'), canvas, close, foot);
    return { full, close, cta, off };
  }

  function buildCorner(copy) {
    const corner = el('button', 'corner');
    corner.type = 'button';
    corner.hidden = true;
    corner.setAttribute('aria-label', 'Open the Comix Downloader Plus announcement');
    const bubble = el('span', 'bubble');
    bubble.append(el('small', '', 'COMIX DOWNLOADER PLUS'), document.createTextNode(copy.bubble));
    bubble.hidden = true;
    const phone = el('span', 'ph');
    const image = assetUrl('assets/plus-announce/cloud-phone.jpg');
    if (image) phone.style.backgroundImage = 'url("' + image + '")';
    corner.append(bubble, phone, el('span', 'st', copy.chip));
    return { corner, bubble };
  }

  // ── Controller ──────────────────────────────────────────────────────────────
  const state = {
    promo: null,
    enabled: false,
    member: false,
    seen: false,
    holdFull: false,
    autoOpened: false,
    userMode: '',
    mode: 'hidden',
    ui: null,
    timer: 0,
    leaveToken: 0,
    bubblePath: '',
    bubbleTimer: 0,
    readerOpened: false,
    briefTimer: 0,
    briefPaused: false,
  };

  function ensureUi() {
    if (state.ui) return state.ui;
    const phase = phaseOf(state.promo);
    const copy = COPY[phase];
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      document.documentElement.appendChild(host);
    }
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    shadow.textContent = '';
    const style = document.createElement('style');
    style.textContent = STYLE;
    const scope = el('div', 'scope');
    scope.dataset.phase = phase;
    const fullParts = buildFull(state.promo, copy);
    const cornerParts = buildCorner(copy);
    scope.append(fullParts.full, cornerParts.corner);
    shadow.append(style, scope);

    fullParts.close.addEventListener('click', () => closeFull());
    fullParts.cta.addEventListener('click', () => { setTimeout(() => closeFull(), 0); });
    fullParts.off.addEventListener('click', turnOff);
    cornerParts.corner.addEventListener('click', () => {
      state.readerOpened = true;
      state.userMode = 'full';
      update();
    });
    // A short launch showing waits while the reader points at or tabs into its text and button.
    // Real movement only: browsers also send synthetic pointer events when content appears under a still cursor.
    // The text column, Close and "Turn off" hold the showing (the footer row itself spans the whole
    // bottom edge, so only its button counts); keyboard focus anywhere in it does too.
    [fullParts.full.querySelector('.left'), fullParts.close, fullParts.off].forEach((zone) => {
      zone.addEventListener('pointermove', (event) => { if (event.movementX || event.movementY) pauseBrief(); });
      zone.addEventListener('pointerleave', () => resumeBrief());
    });
    fullParts.full.addEventListener('focusin', pauseBrief);
    fullParts.full.addEventListener('focusout', () => resumeBrief());

    state.ui = { shadow, full: fullParts.full, corner: cornerParts.corner, bubble: cornerParts.bubble };
    return state.ui;
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && state.mode === 'full') closeFull();
  }

  function showFull(ui) {
    state.leaveToken++;
    // Reopened while still shrinking away: finish that hide so it enters like any other showing.
    if (ui.full.classList.contains('is-leaving')) {
      ui.full.hidden = true;
      ui.full.classList.remove('is-leaving');
    }
    if (!ui.full.hidden) return;
    const delay = autoCloseDelay(phaseOf(state.promo), state.readerOpened);
    ui.full.classList.toggle('is-brief', delay > 0);
    // A short showing does not take focus, so it must not claim to be modal either.
    ui.full.setAttribute('aria-modal', delay ? 'false' : 'true');
    ui.full.hidden = false;
    ui.full.classList.add('is-entering');
    requestAnimationFrame(() => requestAnimationFrame(() => ui.full.classList.remove('is-entering')));
    // A short showing leaves keyboard focus where it was; one the reader opened takes it.
    if (!delay) {
      try { ui.full.focus({ preventScroll: true }); } catch (_) {}
    }
    root.addEventListener('keydown', onKeydown, true);
    clearTimeout(state.briefTimer);
    state.briefPaused = false;
    state.briefTimer = delay ? setTimeout(endBrief, prefersCalm() ? LAUNCH_HOLD_MS : delay) : 0;
  }

  function endBrief() {
    state.briefTimer = 0;
    if (state.mode === 'full' && !state.readerOpened) closeFull();
  }

  function pauseBrief() {
    if (!state.briefTimer) return;
    clearTimeout(state.briefTimer);
    state.briefTimer = 0;
    state.briefPaused = true;
  }

  function resumeBrief(ms) {
    if (!state.briefPaused || state.mode !== 'full') return;
    state.briefPaused = false;
    state.briefTimer = setTimeout(endBrief, ms || LAUNCH_RESUME_MS);
  }

  function hideFull(ui) {
    root.removeEventListener('keydown', onKeydown, true);
    clearTimeout(state.briefTimer);
    state.briefTimer = 0;
    state.briefPaused = false;
    // Already shrinking away: let that finish instead of restarting it on every check.
    if (ui.full.hidden || ui.full.classList.contains('is-leaving')) return;
    ui.full.classList.remove('is-brief');
    const token = ++state.leaveToken;
    ui.full.classList.add('is-leaving');
    setTimeout(() => {
      if (token !== state.leaveToken) return;
      ui.full.hidden = true;
      ui.full.classList.remove('is-leaving');
    }, prefersCalm() ? 0 : LEAVE_MS);
  }

  // On a title page the bubble speaks for a few seconds, then tucks away until hovered.
  function placeBubble(ui, kind) {
    if (kind !== 'title') {
      ui.bubble.hidden = true;
      state.bubblePath = '';
      return;
    }
    if (state.bubblePath === location.pathname) return;
    state.bubblePath = location.pathname;
    ui.bubble.hidden = false;
    ui.bubble.classList.remove('is-tucked');
    clearTimeout(state.bubbleTimer);
    state.bubbleTimer = setTimeout(() => ui.bubble.classList.add('is-tucked'), BUBBLE_MS);
  }

  function showCorner(ui, kind) {
    placeBubble(ui, kind);
    ui.corner.classList.toggle('is-lifted', !!document.querySelector('.cdl-dl-all-btn.cdl-floating'));
    if (!ui.corner.hidden) return;
    ui.corner.hidden = false;
    ui.corner.classList.add('is-entering');
    requestAnimationFrame(() => requestAnimationFrame(() => ui.corner.classList.remove('is-entering')));
  }

  function render(mode, kind) {
    const previous = state.mode;
    state.mode = mode;
    if (mode === 'hidden') {
      if (!state.ui) return;
      hideFull(state.ui);
      state.ui.corner.hidden = true;
      return;
    }
    const ui = ensureUi();
    if (mode === 'full') {
      ui.corner.hidden = true;
      showFull(ui);
      return;
    }
    // Keyboard focus inside the full screen moves to the corner piece once it is back.
    const refocus = previous === 'full' && ui.full.contains(ui.shadow.activeElement);
    hideFull(ui);
    if (previous === 'full') {
      // Let the full screen shrink away before the corner piece appears.
      setTimeout(() => {
        if (state.mode !== 'mini') return;
        showCorner(ui, pageKind(location.pathname));
        // Only when focus was lost with the full screen, never when the reader moved on elsewhere.
        if (refocus && (ui.full.contains(ui.shadow.activeElement) || document.activeElement === document.body)) {
          try { ui.corner.focus({ preventScroll: true }); } catch (_) {}
        }
      }, prefersCalm() ? 0 : LEAVE_MS - 100);
    } else if (!ui.full.classList.contains('is-leaving')) {
      // The check that runs every 800 ms waits for a shrinking full screen too.
      showCorner(ui, kind);
    }
  }

  function update() {
    if (!state.promo) return;
    const kind = pageKind(location.pathname);
    const busy = !!document.getElementById('cdl-all-popup');
    const mode = decideMode({
      enabled: state.enabled,
      member: state.member,
      kind,
      busy,
      seen: state.seen,
      holdFull: state.holdFull,
      autoOpened: state.autoOpened,
      userMode: state.userMode,
    });
    // A tab opened in the background would play the short showing (and mark it seen) unseen:
    // wait until the tab is on screen.
    if (mode === 'full' && !state.userMode && document.visibilityState === 'hidden') return;
    if (mode === 'full' && !state.userMode) {
      state.autoOpened = true;
      state.readerOpened = false;
      state.userMode = 'full';
    }
    // Something took over the page while the full screen was up: come back as the corner piece.
    if (mode === 'hidden' && state.mode === 'full') state.userMode = 'mini';
    if (mode !== state.mode || mode === 'mini') render(mode, kind);
  }

  function pulseDownloadAll() {
    if (prefersCalm() || !state.ui) return;
    const button = document.querySelector('.cdl-dl-all-btn:not(.cdl-sub-btn)');
    if (!button) return;
    const rect = button.getBoundingClientRect();
    if (!rect.width || rect.bottom < 0 || rect.top > root.innerHeight) return;
    const ring = el('div', 'ring');
    ring.style.left = (rect.left - 4) + 'px';
    ring.style.top = (rect.top - 4) + 'px';
    ring.style.width = (rect.width + 8) + 'px';
    ring.style.height = (rect.height + 8) + 'px';
    state.ui.shadow.querySelector('.scope').appendChild(ring);
    setTimeout(() => ring.remove(), 4000);
  }

  function closeFull() {
    if (state.mode !== 'full') return;
    state.userMode = 'mini';
    if (!state.seen) {
      state.seen = true;
      rememberSeen(state.promo).catch(() => {});
    }
    update();
    if (pageKind(location.pathname) === 'title') setTimeout(pulseDownloadAll, prefersCalm() ? 0 : LEAVE_MS);
  }

  function turnOff() {
    state.enabled = false;
    update();
    const api = settingsApi();
    if (api && typeof api.patchSettings === 'function') {
      const patch = {};
      patch[SETTING_KEY] = false;
      api.patchSettings(patch).catch(() => {});
    }
  }

  function watchChanges() {
    const api = settingsApi();
    if (api && typeof api.onChange === 'function') {
      api.onChange((cfg) => {
        state.enabled = cfg[SETTING_KEY] !== false;
        update();
      });
    }
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area && area !== 'local') return;
        if (changes && changes[PLUS_STATE_KEY]) {
          state.member = isMemberState(changes[PLUS_STATE_KEY].newValue);
          update();
        }
      });
    } catch (_) {}
  }

  async function show(promo, context) {
    if (!promo || !promo.id || state.promo || !document.documentElement) return;
    state.promo = promo;
    state.holdFull = !!(context && context.warningShown);
    const [enabled, member, seen] = await Promise.all([readEnabled(), readMembership(), readSeen()]);
    state.enabled = enabled;
    state.member = member;
    state.seen = seen.indexOf(revisionKey(promo)) !== -1;
    watchChanges();
    // The short launch showing only counts down while the tab is on screen.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { pauseBrief(); return; }
      resumeBrief(LAUNCH_HOLD_MS);
      update();
    });
    update();
    state.timer = setInterval(update, TICK_MS);
  }

  const api = { show, pageKind, phaseOf, ctaUrl, revisionKey, isMemberState, decideMode, autoCloseDelay, DEFAULT_URLS };
  root.__cdlPlusAnnounce = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
