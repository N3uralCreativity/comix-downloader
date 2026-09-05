// popup.js — Comix Downloader toolbar popup
'use strict';

const GITHUB_URL = 'https://github.com/N3uralCreativity/comix-downloader';
const CHROME_REVIEW_URL = 'https://chrome.google.com/webstore/detail/nojjjpmicodkodnnllbdolpglhlclpdp/reviews';
const FIREFOX_REVIEW_URL = 'https://addons.mozilla.org/firefox/addon/comix-chapter-downloader/reviews/';
const OPERA_REVIEW_URL = 'https://addons.opera.com/extensions/details/comix-downloader/';
const COMIX_HOSTS = new Set(['comix.to', 'comix.ws']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFirefoxAndroid(userAgent) {
  const ua = String(userAgent || '');
  return /Android/i.test(ua) && /Firefox\//i.test(ua);
}

function isSupportedTabUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      COMIX_HOSTS.has(url.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function comixSettingsUrlForTab(value) {
  try {
    const url = new URL(String(value || ''));
    if (COMIX_HOSTS.has(url.hostname.toLowerCase())) {
      return `https://${url.hostname.toLowerCase()}/user?tab=settings`;
    }
  } catch (_) {}
  return 'https://comix.to/user?tab=settings';
}

function derivePopupActivityState(tabUrl, activity) {
  if (activity && activity.downloading === true) {
    return {
      key: 'downloading',
      label: 'Downloading',
      title: 'A download is in progress',
    };
  }
  if (isSupportedTabUrl(tabUrl)) {
    return {
      key: 'active',
      label: 'Active',
      title: 'Extension active on this tab',
    };
  }
  return {
    key: 'inactive',
    label: 'Not active',
    title: 'The current tab is not supported',
  };
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

function i18n(messageName, fallback, substitutions) {
  try {
    const translated = chrome.i18n.getMessage(messageName, substitutions);
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

function queryActiveTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        void chrome.runtime.lastError;
        resolve(Array.isArray(tabs) && tabs.length ? tabs[0] : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function renderPopupActivityState(state) {
  const status = document.getElementById('footer-status');
  const label = document.getElementById('footer-status-label');
  if (!status || !label) return;
  status.dataset.state = state.key;
  status.title = state.title;
  label.textContent = state.label;
}

async function refreshPopupActivityState() {
  const [tab, activity] = await Promise.all([
    queryActiveTab(),
    sendRuntimeMessage({ action: 'getPopupActivity' }),
  ]);
  renderPopupActivityState(derivePopupActivityState(tab && tab.url, activity));
}

function startPopupActivityUpdates() {
  void refreshPopupActivityState();
  window.setInterval(() => { void refreshPopupActivityState(); }, 750);
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

async function showAvailableUpdate() {
  const panel = document.getElementById('update-panel');
  if (!panel) return false;

  const response = await sendRuntimeMessage({ action: 'getAvailableUpdate' });
  const update = response && response.ok && response.update;
  if (!update || !update.version) {
    panel.hidden = true;
    return false;
  }

  const title = document.getElementById('update-title');
  const message = document.getElementById('update-message');
  const action = document.getElementById('update-action');
  const actionLabel = document.getElementById('update-action-label');
  const status = document.getElementById('update-status');
  const defaultAction = i18n('updateAvailableAction', 'Update now');

  title.textContent = i18n('updateAvailableTitle', 'Your extension is outdated');
  message.textContent = i18n(
    'updateAvailableMessage',
    `Version ${update.version} is ready. Your settings and history will stay intact.`,
    update.version
  );
  actionLabel.textContent = defaultAction;
  action.disabled = false;
  status.textContent = '';
  action.onclick = async () => {
    action.disabled = true;
    actionLabel.textContent = i18n('updateInstalling', 'Updating...');
    status.textContent = '';

    const result = await sendRuntimeMessage({ action: 'installAvailableUpdate' });
    if (result && result.ok) {
      status.textContent = i18n('updateInstalling', 'Updating...');
      return;
    }

    action.disabled = false;
    actionLabel.textContent = defaultAction;
    if (result && result.noUpdate) {
      panel.hidden = true;
      return;
    }
    status.textContent = result && result.busy
      ? i18n('updateBusy', 'Finish or discard the current download, then try again.')
      : i18n('updateFailed', 'Could not start the update. Reopen the popup and try again.');
  };
  const reviewPrompt = document.getElementById('review-prompt');
  if (reviewPrompt) reviewPrompt.hidden = true;
  panel.hidden = false;
  return true;
}

let updateCheckFeedbackTimer = 0;

function showUpdateCheckFeedback(message) {
  const subtitle = document.getElementById('header-sub');
  if (!subtitle) return;
  window.clearTimeout(updateCheckFeedbackTimer);
  subtitle.textContent = message || 'comix.to chapter downloader';
  if (!message) return;
  updateCheckFeedbackTimer = window.setTimeout(() => {
    subtitle.textContent = 'comix.to chapter downloader';
  }, 3200);
}

async function checkForUpdateManually() {
  const button = document.getElementById('btn-check-update');
  if (!button || button.disabled) return;

  button.disabled = true;
  button.classList.add('is-checking');
  button.setAttribute('aria-busy', 'true');
  showUpdateCheckFeedback(i18n('updateChecking', 'Checking for updates...'));

  try {
    const result = await sendRuntimeMessage({ action: 'checkForUpdate' });
    if (result && result.update && result.update.version) {
      await showAvailableUpdate();
      showUpdateCheckFeedback(i18n(
        'updateAvailableShort',
        `Update ${result.update.version} is ready`,
        result.update.version
      ));
    } else if (result && result.ok && result.status === 'no_update') {
      showUpdateCheckFeedback(i18n('updateUpToDate', 'You are up to date'));
    } else if (result && result.ok && result.status === 'throttled') {
      showUpdateCheckFeedback(i18n('updateCheckThrottled', 'Checked recently - try again later'));
    } else if (result && result.ok && result.status === 'unsupported') {
      showUpdateCheckFeedback(i18n('updateCheckUnsupported', 'Manual checks are unavailable here'));
    } else {
      showUpdateCheckFeedback(i18n('updateCheckFailed', 'Could not check for updates'));
    }
  } finally {
    button.disabled = false;
    button.classList.remove('is-checking');
    button.removeAttribute('aria-busy');
  }
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

// Settings opens the active Comix domain's own settings page, where the extension
// injects its settings natively. The background tracks that exact tab so a redirect can
// offer the standalone extension settings page without affecting other tabs.
async function openSettings() {
  // Dismiss the "NEW" indicator the instant Settings is opened: hide the pill
  // now, and let the background clear the notices + toolbar badge (it persists
  // even as this popup closes).
  var pill = document.getElementById('settings-new');
  if (pill) pill.hidden = true;
  try { chrome.runtime.sendMessage({ action: 'dismissNew' }); } catch (e) {}
  const tab = await queryActiveTab();
  const result = await sendRuntimeMessage({
    action: 'cdlOpenComixSettings',
    pageUrl: tab && tab.url || '',
  });
  if (!result || !result.ok) {
    try { chrome.tabs.create({ url: comixSettingsUrlForTab(tab && tab.url) }); } catch (_) {}
  }
  window.close();
}

// Apply the active Comix site's theme to the popup. We try three
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
    chrome.tabs.query({ url: ['*://comix.to/*', '*://comix.ws/*'] }, (tabs) => {
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
  startPopupActivityUpdates();
  // Version from manifest
  const manifest = chrome.runtime.getManifest();
  const verEl = document.getElementById('ext-version');
  if (verEl) verEl.textContent = `v${manifest.version}`;

  // Settings button → options page (opens in a browser tab)
  document.getElementById('btn-settings').addEventListener('click', openSettings);

  const checkUpdateButton = document.getElementById('btn-check-update');
  const checkUpdateLabel = i18n('updateCheckAction', 'Check for updates');
  checkUpdateButton.title = checkUpdateLabel;
  checkUpdateButton.setAttribute('aria-label', checkUpdateLabel);
  checkUpdateButton.addEventListener('click', checkForUpdateManually);

  // GitHub button
  const btnGithub = document.getElementById('btn-github');
  btnGithub.href = GITHUB_URL;
  btnGithub.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: GITHUB_URL });
  });

  const updateVisible = await showAvailableUpdate();
  if (!updateVisible) await showReviewPromptWhenEligible();

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
    if (changes.cdlUpdateAvailable) void showAvailableUpdate();
  });
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    isFirefoxAndroid,
    isSupportedTabUrl,
    comixSettingsUrlForTab,
    derivePopupActivityState,
  };
} else {
  applyPlatformLayout(navigator.userAgent);
  init();
}
