// popup.js — Comix Downloader toolbar popup
'use strict';

const GITHUB_URL = 'https://github.com/N3uralCreativity/comix-downloader';

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function formatTs(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function badgeLabel(level) {
  return { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERR' }[level] || level.toUpperCase();
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

function openSettings() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
  window.close();
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
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

  // Star CTA → repo (keeps users in the loop on new releases)
  const btnStar = document.getElementById('btn-star');
  if (btnStar) {
    btnStar.href = GITHUB_URL;
    btnStar.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: GITHUB_URL });
    });
  }

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

init();
