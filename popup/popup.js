// popup.js — Comix Downloader toolbar popup
'use strict';

const GITHUB_URL = 'https://github.com/N3uralCreativity/comix-downloader';
const CHROME_REVIEW_URL = 'https://chrome.google.com/webstore/detail/nojjjpmicodkodnnllbdolpglhlclpdp/reviews';
const FIREFOX_REVIEW_URL = 'https://addons.mozilla.org/firefox/addon/comix-chapter-downloader/reviews/';
const OPERA_REVIEW_URL = 'https://addons.opera.com/extensions/details/comix-downloader/';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFirefoxAndroid(userAgent) {
  const ua = String(userAgent || '');
  return /Android/i.test(ua) && /Firefox\//i.test(ua);
}

function applyPlatformLayout(userAgent) {
  document.documentElement.classList.toggle('firefox-android', isFirefoxAndroid(userAgent));
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatTs(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function badgeLabel(level) {
  return { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERR' }[level] || level.toUpperCase();
}

function i18n(messageName, fallback) {
  try {
    const translated = chrome.i18n.getMessage(messageName);
    if (translated) return translated;
  } catch (_) {}
  return fallback;
}

function reviewUrlForBrowser() {
  const ua = navigator.userAgent || '';
  if (/Firefox\//i.test(ua)) return FIREFOX_REVIEW_URL;
  if (/OPR\//i.test(ua)) return OPERA_REVIEW_URL;
  return CHROME_REVIEW_URL;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function showReviewPromptWhenEligible() {
  const prompt = document.getElementById('review-prompt');
  if (!prompt) return;

  const response = await sendRuntimeMessage({ action: 'claimReviewPrompt' });
  if (!response || !response.ok || !response.show) return;

  document.getElementById('review-title').textContent =
    i18n('reviewPromptTitle', 'Finding Comix Downloader useful?');
  document.getElementById('review-message').textContent =
    i18n('reviewPromptMessage', 'Share an honest review to help other readers decide.');

  const action = document.getElementById('review-action');
  action.textContent = i18n('reviewPromptAction', 'Leave a review');
  action.href = reviewUrlForBrowser();
  action.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: action.href });
    window.close();
  });

  const dismiss = document.getElementById('review-dismiss');
  const dismissLabel = i18n('reviewPromptDismiss', 'Dismiss');
  dismiss.title = dismissLabel;
  dismiss.setAttribute('aria-label', dismissLabel);
  dismiss.addEventListener('click', () => { prompt.hidden = true; });
  prompt.hidden = false;
}

// ── Logs rendering ──────────────────────────────────────────────────────────

function renderLogs(logs) {
  const wrap  = document.getElementById('logs-wrap');
  const empty = document.getElementById('log-empty');
  const count = document.getElementById('log-count');

  count.textContent = `${logs.length} ${logs.length === 1 ? 'entry' : 'entries'}`;

  if (logs.length === 0) {
    empty.style.display = '';
    [...wrap.querySelectorAll('.log-entry')].forEach(el => el.remove());
    return;
  }

  empty.style.display = 'none';

  const reversed = [...logs].reverse(); // newest first
  const frag = document.createDocumentFragment();

  for (const entry of reversed) {
    const div = document.createElement('div');
    div.className = `log-entry ${entry.level || 'info'}`;
    const ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = formatTs(entry.ts);
    const badge = document.createElement('span');
    badge.className = 'log-badge';
    badge.textContent = badgeLabel(entry.level || 'info');
    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = entry.msg;
    div.append(ts, badge, msg);
    frag.appendChild(div);
  }

  [...wrap.querySelectorAll('.log-entry')].forEach(el => el.remove());
  wrap.appendChild(frag);
}

// Settings opens comix.to's own settings page, where the extension injects its
// settings natively. A short-lived flag tells the in-page content script to
// auto-open the "Comix Downloader" section on arrival. (The standalone options
// page is still reachable from the browser's extension menu → Options.)
var COMIX_SETTINGS_URL = 'https://comix.to/user?tab=settings';
function openSettings() {
  // Dismiss the "NEW" indicator the instant Settings is opened: hide the pill
  // now, and let the background clear the notices + toolbar badge (it persists
  // even as this popup closes).
  var pill = document.getElementById('settings-new');
  if (pill) pill.hidden = true;
  try { chrome.runtime.sendMessage({ action: 'dismissNew' }); } catch (e) {}
  var go = function () { chrome.tabs.create({ url: COMIX_SETTINGS_URL }); window.close(); };
  try { chrome.storage.local.set({ cdlOpenExtSettings: Date.now() }, go); } catch (e) { go(); }
}

// Apply comix.to's theme to the popup so it matches the site. We try three
// sources, best-effort: (1) the last snapshot in storage (instant), (2) a live
// query to any open comix tab (most current), and (3) storage changes while the
// popup is open. Falls back to the CSS defaults when none are available.
function applyThemeObj(t) {
  if (!t) return;
  const s = document.documentElement.style;
  const map = {
    '--bg': t.bg, '--panel': t.panel, '--line': t.line, '--line-2': t.line2,
    '--fg': t.fg, '--fg-strong': t.fgStrong, '--muted': t.muted, '--muted-2': t.muted2,
    '--accent': t.accent, '--accent-ink': t.accentInk, '--accent-bg': t.accentBg,
    '--accent-line': t.accentLine, '--accent-soft': t.accentSoft,
    '--ok': t.ok, '--warn': t.warn, '--err': t.err,
  };
  Object.keys(map).forEach((k) => { if (map[k]) s.setProperty(k, map[k]); });
}
function applySiteTheme() {
  try { chrome.storage.local.get('cdlSiteTheme', (r) => applyThemeObj(r && r.cdlSiteTheme)); } catch (e) {}
  try {
    chrome.tabs.query({ url: '*://comix.to/*' }, (tabs) => {
      if (chrome.runtime.lastError || !tabs || !tabs.length) return;
      const tab = tabs.find((t) => t.active) || tabs[0];
      chrome.tabs.sendMessage(tab.id, { action: 'cdlGetSiteTheme' }, (resp) => {
        if (chrome.runtime.lastError) return;
        applyThemeObj(resp);
      });
    });
  } catch (e) {}
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.cdlSiteTheme) applyThemeObj(ch.cdlSiteTheme.newValue); }); } catch (e) {}
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  applySiteTheme();
  // Version from manifest
  const manifest = chrome.runtime.getManifest();
  const verEl = document.getElementById('ext-version');
  if (verEl) verEl.textContent = `v${manifest.version}`;

  // Settings button → options page (opens in a browser tab)
  document.getElementById('btn-settings').addEventListener('click', openSettings);

  // GitHub button
  const btnGithub = document.getElementById('btn-github');
  btnGithub.href = GITHUB_URL;
  btnGithub.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: GITHUB_URL });
  });

  await showReviewPromptWhenEligible();

  // Load and render logs
  const { cdlLogs = [] } = await chrome.storage.local.get('cdlLogs');
  renderLogs(cdlLogs);

  // "Something new in Settings" indicator (cleared once the user views the
  // relevant tab). Covers the Additional Features tab and the new "Chapters at
  // once" Download option.
  try {
    const { cdlFeaturesNotice, cdlConcurrencyNotice } =
      await chrome.storage.local.get(['cdlFeaturesNotice', 'cdlConcurrencyNotice']);
    const pill = document.getElementById('settings-new');
    const anyActive = (cdlFeaturesNotice && cdlFeaturesNotice.active) ||
                      (cdlConcurrencyNotice && cdlConcurrencyNotice.active);
    if (pill && anyActive) pill.hidden = false;
  } catch (_) {}

  // Clear logs
  document.getElementById('btn-clear').addEventListener('click', async () => {
    await chrome.storage.local.set({ cdlLogs: [] });
    renderLogs([]);
  });

  // Live updates while the popup is open
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.cdlLogs) renderLogs(changes.cdlLogs.newValue || []);
  });
}

if (typeof module === 'object' && module.exports) {
  module.exports = { isFirefoxAndroid };
} else {
  applyPlatformLayout(navigator.userAgent);
  init();
}
