/**
 * content_notices.js - remote Comix-Downloader warnings and notifications.
 *
 * GET /v1/notices returns admin-controlled notice definitions from the worker.
 * Warnings block the page until the user clicks a Close text button. Closed
 * notices stay dismissed in extension storage until the admin changes that
 * notice revision.
 */
(function () {
  'use strict';

  if (window.__cdlNoticesLoaded) return;
  window.__cdlNoticesLoaded = true;

  const API_URL = 'https://comix-downloader-badge.comixdl.workers.dev/v1/notices';
  const ROOT_ID = 'cdl-notices-root';
  const DISMISS_KEY = 'cdlNoticeDismissals';
  const MAX_NOTICES = 10;
  const MAX_DISMISSALS = 100;

  function runtimeVersion() {
    try { return chrome.runtime.getManifest().version || '0'; } catch (_) { return '0'; }
  }

  function noticeUrl() {
    return API_URL + '?v=' + encodeURIComponent(runtimeVersion()) + '&t=' + Date.now();
  }

  function asText(value, max) {
    const s = typeof value === 'string' ? value.trim() : '';
    return s.slice(0, max || 1000);
  }

  function safeUrl(value) {
    const s = asText(value, 500);
    if (!s) return '';
    try {
      const u = new URL(s);
      return /^https?:$/.test(u.protocol) ? u.href : '';
    } catch (_) {
      return '';
    }
  }

  function cleanNotice(raw, fallbackUpdatedAt) {
    if (!raw || typeof raw !== 'object') return null;
    const id = asText(raw.id, 100);
    const type = asText(raw.type, 20).toLowerCase();
    const title = asText(raw.title, 120);
    const message = asText(raw.message, 1200);
    if (!id || !/^(warning|notification)$/.test(type) || !title || !message) return null;

    return {
      id,
      type,
      title,
      message,
      updatedAt: asText(raw.updatedAt || fallbackUpdatedAt, 64),
      ctaLabel: asText(raw.ctaLabel || (raw.button && raw.button.label), 80),
      ctaUrl: safeUrl(raw.ctaUrl || (raw.button && raw.button.url)),
    };
  }

  function noticeRevisionKey(notice) {
    return notice.id + '|' + (notice.updatedAt || 'static');
  }

  function readLocalDismissals() {
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      const list = JSON.parse(raw || '[]');
      return Array.isArray(list) ? list.filter((item) => typeof item === 'string').slice(-MAX_DISMISSALS) : [];
    } catch (_) {
      return [];
    }
  }

  function writeLocalDismissals(list) {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(list.slice(-MAX_DISMISSALS)));
    } catch (_) {}
  }

  function uniqueDismissals(list) {
    return Array.from(new Set(list.filter((item) => typeof item === 'string'))).slice(-MAX_DISMISSALS);
  }

  function browserStorageApi() {
    try {
      if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) return browser.storage.local;
    } catch (_) {}
    return null;
  }

  function chromeStorageApi() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) return chrome.storage.local;
    } catch (_) {}
    return null;
  }

  async function readExtensionDismissals() {
    const browserApi = browserStorageApi();
    if (browserApi) {
      try {
        const data = await browserApi.get(DISMISS_KEY);
        return Array.isArray(data && data[DISMISS_KEY]) ? data[DISMISS_KEY] : [];
      } catch (_) {}
    }

    const chromeApi = chromeStorageApi();
    if (!chromeApi) return [];
    return new Promise((resolve) => {
      try {
        chromeApi.get(DISMISS_KEY, (data) => {
          try {
            if (chrome.runtime && chrome.runtime.lastError) {
              resolve([]);
              return;
            }
          } catch (_) {}
          resolve(Array.isArray(data && data[DISMISS_KEY]) ? data[DISMISS_KEY] : []);
        });
      } catch (_) {
        resolve([]);
      }
    });
  }

  async function writeExtensionDismissals(list) {
    const payload = {};
    payload[DISMISS_KEY] = list.slice(-MAX_DISMISSALS);

    const browserApi = browserStorageApi();
    if (browserApi) {
      try {
        await browserApi.set(payload);
        return;
      } catch (_) {}
    }

    const chromeApi = chromeStorageApi();
    if (!chromeApi) return;
    await new Promise((resolve) => {
      try {
        chromeApi.set(payload, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  async function readDismissals() {
    const stored = await readExtensionDismissals();
    return uniqueDismissals(stored.concat(readLocalDismissals()));
  }

  async function writeDismissals(list) {
    const trimmed = uniqueDismissals(list);
    await writeExtensionDismissals(trimmed);
    writeLocalDismissals(trimmed);
  }

  function rememberDismissal(notice) {
    const key = noticeRevisionKey(notice);
    readDismissals().then((stored) => {
      const list = stored.filter((item) => item !== key);
      list.push(key);
      return writeDismissals(list);
    }).catch(() => {});
  }

  async function loadNotices() {
    const res = await fetch(noticeUrl(), {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const raw = Array.isArray(data) ? data : data && data.notices;
    if (!Array.isArray(raw)) return [];
    const fallbackUpdatedAt = Array.isArray(data) ? '' : asText(data && data.updatedAt, 64);
    const dismissed = new Set(await readDismissals());
    return raw
      .slice(0, MAX_NOTICES)
      .map((notice) => cleanNotice(notice, fallbackUpdatedAt))
      .filter(Boolean)
      .filter((notice) => !dismissed.has(noticeRevisionKey(notice)));
  }

  function root() {
    let host = document.getElementById(ROOT_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = ROOT_ID;
      document.documentElement.appendChild(host);
    }
    if (!host.shadowRoot) {
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; color-scheme: light; }
        *, *::before, *::after { box-sizing: border-box; }
        .cdl-warning-overlay {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(5, 10, 14, 0.92);
          font-family: Arial, Helvetica, sans-serif;
        }
        .cdl-warning-stack {
          width: min(780px, calc(100vw - 32px));
          max-height: calc(100vh - 48px);
          overflow: auto;
          display: grid;
          gap: 16px;
        }
        .cdl-warning-card {
          border: 4px solid #f59e0b;
          border-radius: 0;
          background: #fff7ed;
          color: #111827;
          box-shadow: 0 24px 80px rgba(0,0,0,0.55);
        }
        .cdl-warning-card, .cdl-warning-card * { border-radius: 0 !important; }
        .cdl-warning-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding: 18px 20px;
          background: #f59e0b;
          color: #111827;
        }
        .cdl-warning-title {
          margin: 0;
          font: 700 20px/1.2 Arial, Helvetica, sans-serif;
          letter-spacing: 0;
        }
        .cdl-warning-body {
          padding: 22px 20px 20px;
          font: 16px/1.5 Arial, Helvetica, sans-serif;
        }
        .cdl-warning-message { margin: 0 0 22px; }
        .cdl-warning-actions, .cdl-note-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          align-items: center;
        }
        .cdl-warning-close,
        .cdl-warning-link,
        .cdl-note-close,
        .cdl-note-link {
          appearance: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 38px;
          padding: 8px 14px;
          border: 2px solid currentColor;
          background: #111827;
          color: #fff;
          font: 700 14px/1 Arial, Helvetica, sans-serif;
          text-decoration: none;
          cursor: pointer;
          letter-spacing: 0;
        }
        .cdl-warning-close {
          background: #fff7ed;
          color: #111827;
        }
        .cdl-warning-head .cdl-warning-close {
          min-height: 32px;
          padding: 6px 12px;
          background: #111827;
          color: #fff;
          flex: 0 0 auto;
        }
        .cdl-note-stack {
          position: fixed;
          right: 18px;
          top: 18px;
          z-index: 2147483646;
          width: min(390px, calc(100vw - 36px));
          display: grid;
          gap: 10px;
          font-family: Arial, Helvetica, sans-serif;
        }
        .cdl-note {
          border: 1px solid rgba(148, 163, 184, 0.45);
          border-radius: 8px;
          background: #0f172a;
          color: #f8fafc;
          box-shadow: 0 18px 48px rgba(0,0,0,0.28);
          overflow: hidden;
        }
        .cdl-note-head {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 13px 14px 0;
        }
        .cdl-note-title {
          margin: 0;
          font: 700 15px/1.25 Arial, Helvetica, sans-serif;
          letter-spacing: 0;
        }
        .cdl-note-body {
          padding: 10px 14px 14px;
          font: 14px/1.45 Arial, Helvetica, sans-serif;
        }
        .cdl-note-message { margin: 0 0 12px; }
        .cdl-note-close {
          min-height: 28px;
          padding: 5px 9px;
          border-radius: 6px;
          background: transparent;
          color: #f8fafc;
          font-weight: 700;
        }
        .cdl-note-link {
          min-height: 32px;
          border-radius: 6px;
          background: #f8fafc;
          color: #0f172a;
        }
        @media (max-width: 560px) {
          .cdl-warning-overlay { padding: 12px; align-items: stretch; }
          .cdl-warning-stack { width: 100%; max-height: calc(100vh - 24px); align-content: center; }
          .cdl-warning-head { padding: 14px; }
          .cdl-warning-title { font-size: 18px; }
          .cdl-warning-body { padding: 16px 14px; font-size: 15px; }
          .cdl-note-stack { left: 12px; right: 12px; top: 12px; width: auto; }
        }
      `;
      shadow.appendChild(style);
    }
    return host.shadowRoot;
  }

  function makeButton(text, cls, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function makeLink(notice, cls) {
    if (!notice.ctaLabel || !notice.ctaUrl) return null;
    const a = document.createElement('a');
    a.className = cls;
    a.href = notice.ctaUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = notice.ctaLabel;
    return a;
  }

  function renderWarnings(shadow, notices) {
    if (!notices.length) return;
    const overlay = document.createElement('div');
    overlay.className = 'cdl-warning-overlay';
    overlay.setAttribute('role', 'presentation');

    const stack = document.createElement('div');
    stack.className = 'cdl-warning-stack';
    overlay.appendChild(stack);

    notices.forEach((notice) => {
      const card = document.createElement('section');
      card.className = 'cdl-warning-card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'cdl-warning-title-' + notice.id);

      const head = document.createElement('div');
      head.className = 'cdl-warning-head';
      const title = document.createElement('h2');
      title.className = 'cdl-warning-title';
      title.id = 'cdl-warning-title-' + notice.id;
      title.textContent = notice.title;
      head.appendChild(title);
      head.appendChild(makeButton('Close', 'cdl-warning-close', () => closeWarning(notice, card, overlay)));

      const body = document.createElement('div');
      body.className = 'cdl-warning-body';
      const msg = document.createElement('p');
      msg.className = 'cdl-warning-message';
      msg.textContent = notice.message;
      body.appendChild(msg);

      const actions = document.createElement('div');
      actions.className = 'cdl-warning-actions';
      const link = makeLink(notice, 'cdl-warning-link');
      if (link) actions.appendChild(link);
      actions.appendChild(makeButton('Close', 'cdl-warning-close', () => closeWarning(notice, card, overlay)));
      body.appendChild(actions);

      card.appendChild(head);
      card.appendChild(body);
      stack.appendChild(card);
    });

    shadow.appendChild(overlay);
  }

  function closeWarning(notice, card, overlay) {
    rememberDismissal(notice);
    card.remove();
    if (!overlay.querySelector('.cdl-warning-card')) overlay.remove();
  }

  function closeNotification(notice, card) {
    rememberDismissal(notice);
    card.remove();
  }

  function renderNotifications(shadow, notices) {
    if (!notices.length) return;
    const stack = document.createElement('div');
    stack.className = 'cdl-note-stack';
    notices.forEach((notice) => {
      const card = document.createElement('section');
      card.className = 'cdl-note';
      card.setAttribute('role', 'status');

      const head = document.createElement('div');
      head.className = 'cdl-note-head';
      const title = document.createElement('h3');
      title.className = 'cdl-note-title';
      title.textContent = notice.title;
      head.appendChild(title);
      head.appendChild(makeButton('Close', 'cdl-note-close', () => closeNotification(notice, card)));

      const body = document.createElement('div');
      body.className = 'cdl-note-body';
      const msg = document.createElement('p');
      msg.className = 'cdl-note-message';
      msg.textContent = notice.message;
      body.appendChild(msg);

      const link = makeLink(notice, 'cdl-note-link');
      if (link) {
        const actions = document.createElement('div');
        actions.className = 'cdl-note-actions';
        actions.appendChild(link);
        body.appendChild(actions);
      }

      card.appendChild(head);
      card.appendChild(body);
      stack.appendChild(card);
    });
    shadow.appendChild(stack);
  }

  function render(notices) {
    if (!notices.length || !document.documentElement) return;
    const shadow = root();
    renderWarnings(shadow, notices.filter((notice) => notice.type === 'warning'));
    renderNotifications(shadow, notices.filter((notice) => notice.type === 'notification'));
  }

  function boot() {
    loadNotices().then(render).catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
