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
        button, a { -webkit-tap-highlight-color: transparent; }
        .cdl-warning-overlay {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(7, 11, 18, 0.82);
          backdrop-filter: blur(5px);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        }
        .cdl-warning-stack {
          width: min(640px, calc(100vw - 32px));
          max-height: calc(100vh - 48px);
          overflow: auto;
          display: grid;
          gap: 16px;
        }
        .cdl-warning-card {
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 8px;
          background: #ffffff;
          color: #17202d;
          box-shadow: 0 28px 80px rgba(0, 0, 0, 0.48);
        }
        .cdl-warning-brandbar,
        .cdl-note-brandbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          background: #111827;
          color: #f8fafc;
        }
        .cdl-warning-brandbar { padding: 14px 16px; }
        .cdl-brand {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 11px;
        }
        .cdl-brand-mark {
          width: 38px;
          height: 38px;
          flex: 0 0 38px;
          padding: 6px;
          border: 1px solid rgba(103, 232, 249, 0.32);
          border-radius: 7px;
          background: rgba(103, 232, 249, 0.1);
        }
        .cdl-brand-mark .cdl-mark-glow { fill: #67e8f9; }
        .cdl-brand-mark .cdl-mark-ink { fill: #f8fafc; }
        .cdl-brand-copy { min-width: 0; }
        .cdl-brand-name {
          overflow: hidden;
          color: #ffffff;
          font-size: 14px;
          font-weight: 750;
          line-height: 1.2;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cdl-brand-source {
          margin-top: 3px;
          color: #a5f3fc;
          font-size: 11px;
          font-weight: 650;
          line-height: 1.2;
          text-transform: uppercase;
        }
        .cdl-warning-content {
          position: relative;
          padding: 24px 24px 20px;
          border-top: 4px solid #f59e0b;
        }
        .cdl-warning-kicker {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          margin-bottom: 10px;
          color: #9a5400;
          font-size: 12px;
          font-weight: 750;
          line-height: 1.2;
          text-transform: uppercase;
        }
        .cdl-warning-kicker svg { width: 16px; height: 16px; flex: 0 0 16px; }
        .cdl-warning-head {
          display: block;
        }
        .cdl-warning-title {
          margin: 0 0 12px;
          color: #111827;
          font: 750 22px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
          letter-spacing: 0;
        }
        .cdl-warning-body {
          color: #3b4656;
          font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        }
        .cdl-warning-message { margin: 0 0 20px; white-space: pre-line; }
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
          gap: 7px;
          min-height: 38px;
          padding: 8px 14px;
          border: 1px solid transparent;
          border-radius: 7px;
          font: 700 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
          text-decoration: none;
          cursor: pointer;
          letter-spacing: 0;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .cdl-warning-link {
          background: #111827;
          color: #ffffff;
        }
        .cdl-warning-link:hover { background: #273449; }
        .cdl-warning-link svg,
        .cdl-note-link svg { width: 14px; height: 14px; flex: 0 0 14px; }
        .cdl-warning-close {
          border-color: #cfd6df;
          background: #ffffff;
          color: #273449;
        }
        .cdl-warning-close:hover { background: #f3f5f7; border-color: #aeb8c5; }
        .cdl-icon-close {
          appearance: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          min-height: 34px;
          flex: 0 0 34px;
          padding: 0;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 7px;
          background: rgba(255, 255, 255, 0.06);
          color: #e5e7eb;
          cursor: pointer;
        }
        .cdl-icon-close:hover { background: rgba(255, 255, 255, 0.14); color: #ffffff; }
        .cdl-icon-close svg { width: 17px; height: 17px; }
        .cdl-icon-close:focus-visible,
        .cdl-warning-close:focus-visible,
        .cdl-warning-link:focus-visible,
        .cdl-note-link:focus-visible {
          outline: 3px solid rgba(34, 211, 238, 0.48);
          outline-offset: 2px;
        }
        .cdl-source-note {
          display: flex;
          align-items: center;
          gap: 7px;
          margin: 18px 0 0;
          padding-top: 14px;
          border-top: 1px solid #e4e8ee;
          color: #687486;
          font-size: 11.5px;
          line-height: 1.35;
        }
        .cdl-source-note svg { width: 14px; height: 14px; flex: 0 0 14px; color: #0891b2; }
        .cdl-source-note strong { color: #344054; font-weight: 700; }
        .cdl-source-separator { color: #b1bac7; }
        .cdl-source-site { white-space: nowrap; }
        .cdl-note-stack {
          position: fixed;
          right: 18px;
          top: 18px;
          z-index: 2147483646;
          width: min(410px, calc(100vw - 36px));
          display: grid;
          gap: 10px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        }
        .cdl-note {
          position: relative;
          border: 1px solid rgba(17, 24, 39, 0.2);
          border-radius: 8px;
          background: #ffffff;
          color: #17202d;
          box-shadow: 0 18px 48px rgba(0, 0, 0, 0.3);
          overflow: hidden;
        }
        .cdl-note::before {
          content: "";
          position: absolute;
          inset: 0 auto 0 0;
          width: 4px;
          background: #22d3ee;
        }
        .cdl-note-brandbar { padding: 11px 12px 11px 15px; }
        .cdl-note-brandbar .cdl-brand { gap: 9px; }
        .cdl-note-brandbar .cdl-brand-mark {
          width: 32px;
          height: 32px;
          flex-basis: 32px;
          padding: 5px;
        }
        .cdl-note-brandbar .cdl-brand-name { font-size: 13px; }
        .cdl-note-brandbar .cdl-brand-source { font-size: 10px; }
        .cdl-note-head { padding: 15px 16px 0 19px; }
        .cdl-note-title {
          margin: 0;
          color: #111827;
          font: 750 16px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
          letter-spacing: 0;
        }
        .cdl-note-body {
          padding: 9px 16px 14px 19px;
          color: #465266;
          font: 13.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        }
        .cdl-note-message { margin: 0 0 13px; white-space: pre-line; }
        .cdl-note-link {
          min-height: 34px;
          border-color: #b8c2cf;
          background: #f7fafc;
          color: #162033;
        }
        .cdl-note-link:hover { border-color: #7c899b; background: #eef3f7; }
        .cdl-note .cdl-source-note {
          margin-top: 13px;
          padding-top: 11px;
          font-size: 10.5px;
        }
        @media (max-width: 560px) {
          .cdl-warning-overlay { padding: 10px; align-items: stretch; }
          .cdl-warning-stack { width: 100%; max-height: calc(100vh - 20px); align-content: center; }
          .cdl-warning-brandbar { padding: 12px; }
          .cdl-warning-content { padding: 19px 16px 16px; }
          .cdl-warning-title { font-size: 19px; }
          .cdl-warning-body { font-size: 14px; }
          .cdl-warning-actions { align-items: stretch; }
          .cdl-warning-actions > * { flex: 1 1 140px; }
          .cdl-source-note { align-items: flex-start; flex-wrap: wrap; }
          .cdl-source-separator { display: none; }
          .cdl-source-site { width: 100%; padding-left: 21px; }
          .cdl-note-stack { left: 12px; right: 12px; top: 12px; width: auto; }
        }
        @media (prefers-reduced-motion: no-preference) {
          .cdl-warning-card { animation: cdl-notice-enter 180ms ease-out both; }
          .cdl-note { animation: cdl-note-enter 180ms ease-out both; }
        }
        @keyframes cdl-notice-enter {
          from { opacity: 0; transform: translateY(10px) scale(0.99); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes cdl-note-enter {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `;
      shadow.appendChild(style);
    }
    return host.shadowRoot;
  }

  function svgIcon(pathData, viewBox) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', viewBox || '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
    return svg;
  }

  function brandMark() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('cdl-brand-mark');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');

    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    arrow.classList.add('cdl-mark-glow');
    arrow.setAttribute('points', '10,2.6 14,2.6 14,8.6 18.8,8.6 12,15.8 5.2,8.6 10,8.6');
    const tray = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tray.classList.add('cdl-mark-ink');
    tray.setAttribute('d', 'M3 16.8 6.2 20h11.6l3.2-3.2v4.8H3z');
    svg.append(arrow, tray);
    return svg;
  }

  function brandLockup(sourceText) {
    const brand = document.createElement('div');
    brand.className = 'cdl-brand';
    brand.appendChild(brandMark());

    const copy = document.createElement('div');
    copy.className = 'cdl-brand-copy';
    const name = document.createElement('div');
    name.className = 'cdl-brand-name';
    name.textContent = 'Comix Downloader';
    const source = document.createElement('div');
    source.className = 'cdl-brand-source';
    source.textContent = sourceText;
    copy.append(name, source);
    brand.appendChild(copy);
    return brand;
  }

  function sourceNote() {
    const note = document.createElement('p');
    note.className = 'cdl-source-note';
    note.appendChild(svgIcon('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4'));

    const origin = document.createElement('strong');
    origin.textContent = 'Sent by the Comix Downloader extension';
    const separator = document.createElement('span');
    separator.className = 'cdl-source-separator';
    separator.textContent = '|';
    const site = document.createElement('span');
    site.className = 'cdl-source-site';
    site.textContent = 'Not a Comix site message';
    note.append(origin, separator, site);
    return note;
  }

  function closeIconButton(cls, onClick) {
    const btn = makeButton('', cls + ' cdl-icon-close', onClick);
    btn.setAttribute('aria-label', 'Dismiss this extension message');
    btn.title = 'Dismiss';
    btn.appendChild(svgIcon('M18 6 6 18 M6 6l12 12'));
    return btn;
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
    const text = document.createElement('span');
    text.textContent = notice.ctaLabel;
    a.append(text, svgIcon('M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'));
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
      card.setAttribute('aria-describedby', 'cdl-warning-message-' + notice.id);

      const brandbar = document.createElement('div');
      brandbar.className = 'cdl-warning-brandbar';
      brandbar.appendChild(brandLockup('Browser extension warning'));
      brandbar.appendChild(closeIconButton('cdl-warning-dismiss-icon', () => closeWarning(notice, card, overlay)));

      const content = document.createElement('div');
      content.className = 'cdl-warning-content';
      const kicker = document.createElement('div');
      kicker.className = 'cdl-warning-kicker';
      kicker.append(svgIcon('M12 9v4 M12 17h.01 M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0z'), document.createTextNode('Important notice'));

      const head = document.createElement('div');
      head.className = 'cdl-warning-head';
      const title = document.createElement('h2');
      title.className = 'cdl-warning-title';
      title.id = 'cdl-warning-title-' + notice.id;
      title.textContent = notice.title;
      head.appendChild(title);

      const body = document.createElement('div');
      body.className = 'cdl-warning-body';
      const msg = document.createElement('p');
      msg.className = 'cdl-warning-message';
      msg.id = 'cdl-warning-message-' + notice.id;
      msg.textContent = notice.message;
      body.appendChild(msg);

      const actions = document.createElement('div');
      actions.className = 'cdl-warning-actions';
      const link = makeLink(notice, 'cdl-warning-link');
      if (link) actions.appendChild(link);
      actions.appendChild(makeButton('Dismiss', 'cdl-warning-close', () => closeWarning(notice, card, overlay)));
      body.appendChild(actions);
      body.appendChild(sourceNote());

      content.append(kicker, head, body);
      card.append(brandbar, content);
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
    stack.setAttribute('aria-live', 'polite');
    notices.forEach((notice) => {
      const card = document.createElement('section');
      card.className = 'cdl-note';
      card.setAttribute('role', 'region');
      card.setAttribute('aria-labelledby', 'cdl-note-title-' + notice.id);
      card.setAttribute('aria-describedby', 'cdl-note-message-' + notice.id);

      const brandbar = document.createElement('div');
      brandbar.className = 'cdl-note-brandbar';
      brandbar.appendChild(brandLockup('Extension notification'));
      brandbar.appendChild(closeIconButton('cdl-note-close', () => closeNotification(notice, card)));

      const head = document.createElement('div');
      head.className = 'cdl-note-head';
      const title = document.createElement('h3');
      title.className = 'cdl-note-title';
      title.id = 'cdl-note-title-' + notice.id;
      title.textContent = notice.title;
      head.appendChild(title);

      const body = document.createElement('div');
      body.className = 'cdl-note-body';
      const msg = document.createElement('p');
      msg.className = 'cdl-note-message';
      msg.id = 'cdl-note-message-' + notice.id;
      msg.textContent = notice.message;
      body.appendChild(msg);

      const link = makeLink(notice, 'cdl-note-link');
      if (link) {
        const actions = document.createElement('div');
        actions.className = 'cdl-note-actions';
        actions.appendChild(link);
        body.appendChild(actions);
      }
      body.appendChild(sourceNote());

      card.append(brandbar, head, body);
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
