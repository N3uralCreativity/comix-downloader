// popup.js — Script de la popup de l'extension Comix Downloader
'use strict';

const GITHUB_URL = 'https://github.com/N3uralCreativity/comix-downloader';
const MAX_LOGS   = 500;

// ── Utilitaires ──────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function formatTs(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function badgeLabel(level) {
  return { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERR' }[level] || level.toUpperCase();
}

// ── Rendu des logs ────────────────────────────────────────────────────────────

function renderLogs(logs) {
  const wrap  = document.getElementById('logs-wrap');
  const empty = document.getElementById('log-empty');
  const count = document.getElementById('log-count');

  count.textContent = `${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}`;

  if (logs.length === 0) {
    empty.style.display = '';
    // Remove all real entries
    [...wrap.querySelectorAll('.log-entry')].forEach(el => el.remove());
    return;
  }

  empty.style.display = 'none';

  // Rebuild list (newest first)
  const reversed = [...logs].reverse();
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

  // Replace existing entries (keep empty placeholder in DOM)
  [...wrap.querySelectorAll('.log-entry')].forEach(el => el.remove());
  wrap.appendChild(frag);
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  // Version from manifest
  const manifest = chrome.runtime.getManifest();
  const verEl = document.getElementById('ext-version');
  if (verEl) verEl.textContent = `v${manifest.version}`;

  // GitHub button
  const btnGithub = document.getElementById('btn-github');
  btnGithub.href = GITHUB_URL;
  btnGithub.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: GITHUB_URL });
  });

  // Load and render logs
  const { cdlLogs = [] } = await chrome.storage.local.get('cdlLogs');
  renderLogs(cdlLogs);

  // Clear logs button
  document.getElementById('btn-clear').addEventListener('click', async () => {
    await chrome.storage.local.set({ cdlLogs: [] });
    renderLogs([]);
  });

  // Live-update via storage change events (if background writes while popup is open)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.cdlLogs) {
      renderLogs(changes.cdlLogs.newValue || []);
    }
  });
}

init();
