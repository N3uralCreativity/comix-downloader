(function () {
  'use strict';

  if (window.top !== window) return;

  // The Release Agenda is a real comix.to page: /agenda is an unknown route, so
  // comix renders its own header, footer, and theme around a not-found body.
  // This script hides that body and draws the agenda in its place with comix's
  // own component classes (section, card, poster, btn, panel), so the site's
  // stylesheet styles it exactly like every other page.
  var View = window.CDLAgendaView;
  if (!View) return;

  var ENTRY_ID = 'cdl-agenda-topnav-entry';
  var STYLE_ID = 'cdl-agenda-style';
  var MAIN_ID = 'cdl-agenda-main';
  var ROUTE_CLASS = 'cdl-agenda-route';
  var PAGE_TITLE = 'Release Agenda';
  var scheduled = false;

  // Page state outlives comix re-renders: when React replaces the markup around
  // the agenda, the same node is re-attached instead of refetching.
  var page = null;
  var active = false;
  var titleBefore = null;
  var agenda = null;
  var loading = '';
  var failure = null;
  var refreshSummary = null;
  var autoRefreshStarted = false;
  var weekOffset = 0;
  var requestSerial = 0;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var m = '#' + MAIN_ID;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + ENTRY_ID + '{display:flex;align-items:center}',
      '#' + ENTRY_ID + ' .icon-btn{text-decoration:none}',
      '#' + ENTRY_ID + ' .icon-btn[aria-current="page"]{color:var(--accent,#8765eb)}',
      '#' + ENTRY_ID + ' .icon-btn svg{display:block}',
      'html.' + ROUTE_CLASS + ' main:not(' + m + '),html.' + ROUTE_CLASS + ' .error-main:not(' + m + '){display:none!important}',
      m + '{flex:1 0 auto;width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:48px;padding-bottom:64px}',
      m + ' .cdl-agenda-lede{max-width:760px;margin:0 0 18px;color:var(--text-2,#a0a0a0);font-size:var(--text-sm,13px);line-height:1.6}',
      m + ' .cdl-agenda-weekline{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 16px;margin-bottom:14px}',
      m + ' .cdl-agenda-weekline strong{color:var(--text-emphasis,#f5f5f5);font-size:var(--text-md,15px);font-weight:600}',
      m + ' .cdl-agenda-weekline span{color:var(--text-3,#8a8a8a);font-family:var(--f-mono,monospace);font-size:var(--text-xs,11px);letter-spacing:.08em;text-transform:uppercase}',
      m + ' .cdl-agenda-status{margin:0 0 14px;padding:10px 14px;border-radius:var(--radius,6px);background:var(--surface,#202326);color:var(--text-2,#a0a0a0);font-size:var(--text-sm,13px);line-height:1.5}',
      m + ' .cdl-agenda-status.is-error{color:var(--danger,#ef4444)}',
      m + ' .cdl-agenda-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:12px}',
      m + ' .cdl-agenda-day{display:flex;flex-direction:column;gap:12px;min-width:0;padding:12px;border-radius:var(--radius,6px);background:var(--surface,#202326)}',
      m + ' .cdl-agenda-day.is-today{box-shadow:inset 0 2px 0 var(--accent,#8765eb)}',
      m + ' .cdl-agenda-dayhead{display:flex;align-items:baseline;justify-content:space-between;gap:6px;color:var(--text-3,#8a8a8a);font-family:var(--f-mono,monospace);font-size:var(--text-xs,11px);letter-spacing:.12em;text-transform:uppercase}',
      m + ' .cdl-agenda-dayhead strong{font-weight:600}',
      m + ' .cdl-agenda-day.is-today .cdl-agenda-dayhead{color:var(--accent,#8765eb)}',
      m + ' .cdl-agenda-daybody{display:grid;grid-template-columns:minmax(0,1fr);gap:14px}',
      m + ' .cdl-agenda-none{color:var(--text-4,#666);font-size:var(--text-sm,13px)}',
      m + ' .cdl-agenda-note{color:var(--text-3,#8a8a8a);font-size:var(--text-xs,11px);line-height:1.45}',
      m + ' .cdl-agenda-card.is-late .cdl-agenda-note{color:var(--danger,#ef4444)}',
      m + ' .cdl-agenda-card.is-on-schedule .cdl-agenda-note{color:var(--success,#22c55e)}',
      m + ' .poster.cdl-agenda-noposter{display:grid;place-items:center;animation:none;background:var(--surface-2,#282c30);color:var(--text-3,#8a8a8a);font-family:var(--f-mono,monospace);font-weight:700;letter-spacing:.06em}',
      m + ' .cdl-agenda-panel{padding:22px 24px}',
      m + ' .cdl-agenda-panel p{margin:0 0 14px;color:var(--text-2,#a0a0a0);line-height:1.6}',
      m + ' .cdl-agenda-panel p strong{color:var(--text-emphasis,#f5f5f5)}',
      m + ' .cdl-agenda-panel .btn{margin-right:8px}',
      m + ' .cdl-agenda-foot{margin:0;color:var(--text-4,#666);font-size:var(--text-xs,11px);line-height:1.6}',
      '@media(max-width:1180px){' + m + ' .cdl-agenda-week{grid-template-columns:repeat(4,minmax(0,1fr))}}',
      '@media(max-width:760px){' + m + ' .cdl-agenda-week{grid-template-columns:minmax(0,1fr)}' +
        m + ' .cdl-agenda-daybody{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}' +
        m + ' .cdl-agenda-day.is-empty{flex-direction:row;align-items:baseline;justify-content:space-between;padding:10px 12px}}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key === 'disabled') node.disabled = !!value;
      else if (value != null) node.setAttribute(key, value);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          var error = chrome.runtime.lastError;
          resolve(error ? { ok: false, error: { code: 'EXTENSION_MESSAGE_FAILED', message: error.message } }
            : response || { ok: false, error: { message: 'The extension returned no response.' } });
        });
      } catch (error) {
        resolve({ ok: false, error: { code: 'EXTENSION_MESSAGE_FAILED', message: error.message } });
      }
    });
  }

  function calendarIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    [
      ['path', { d: 'M8 2v4M16 2v4' }],
      ['rect', { width: '18', height: '18', x: '3', y: '4', rx: '2' }],
      ['path', { d: 'M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01' }]
    ].forEach(function (definition) {
      var node = document.createElementNS(ns, definition[0]);
      Object.keys(definition[1]).forEach(function (key) { node.setAttribute(key, definition[1][key]); });
      svg.appendChild(node);
    });
    return svg;
  }

  // ── Header entry: a plain link, so it behaves like comix's own navigation ──
  function createEntry() {
    var entry = document.createElement('div');
    entry.id = ENTRY_ID;
    entry.className = 'cdl-agenda-topnav-entry';

    var link = document.createElement('a');
    link.className = 'icon-btn';
    link.href = View.PATH;
    link.setAttribute('aria-label', PAGE_TITLE);
    link.title = PAGE_TITLE;
    link.appendChild(calendarIcon());
    link.addEventListener('click', function (event) {
      if (!View.isAgendaPath(location.pathname) || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      window.scrollTo(0, 0);
    });
    entry.appendChild(link);
    return entry;
  }

  function ensureEntry() {
    var right = document.querySelector('.topnav__right');
    if (!right) return;

    var entry = document.getElementById(ENTRY_ID);
    if (!entry) entry = createEntry();
    var link = entry.querySelector('a');
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
    if (entry.parentElement === right) return;

    var settings = right.querySelector('.settings');
    right.insertBefore(entry, settings || right.firstChild);
  }

  // ── Agenda page ────────────────────────────────────────────────────────────
  function mountPoint() {
    var siteMain = document.querySelector('main:not(#' + MAIN_ID + ')') || document.querySelector('.error-main');
    if (siteMain && siteMain.parentNode) return { parent: siteMain.parentNode, before: siteMain.nextSibling };
    var header = document.querySelector('header.topnav');
    if (header && header.parentNode) return { parent: header.parentNode, before: header.nextSibling };
    return null;
  }

  function ensurePage() {
    if (!page) {
      page = el('main', { id: MAIN_ID, class: 'list-main cdl-agenda', 'aria-label': PAGE_TITLE });
      render();
    }
    if (!page.isConnected) {
      var point = mountPoint();
      if (point) point.parent.insertBefore(page, point.before);
    }
    if (document.title !== PAGE_TITLE) {
      if (titleBefore == null) titleBefore = document.title;
      document.title = PAGE_TITLE;
    }
  }

  function enterAgenda() {
    if (active) return;
    active = true;
    injectStyle();
    document.documentElement.classList.add(ROUTE_CLASS);
    ensurePage();
    if (!agenda && !loading && !failure) loadAgenda(false, false);
  }

  function leaveAgenda() {
    if (!active) return;
    active = false;
    requestSerial++;
    document.documentElement.classList.remove(ROUTE_CLASS);
    if (page) page.remove();
    page = null;
    agenda = null; loading = ''; failure = null; refreshSummary = null;
    autoRefreshStarted = false; weekOffset = 0;
    if (titleBefore != null && document.title === PAGE_TITLE) document.title = titleBefore;
    titleBefore = null;
  }

  function sectionHeader(kicker, title, controls) {
    return el('div', { class: 'section__header' }, [
      el('div', { class: 'section__title-wrap' }, [
        kicker ? el('div', { class: 'section__kicker', text: kicker }) : null,
        el('h2', { class: 'section__title', text: title }),
      ]),
      controls && controls.length ? el('div', { class: 'section__controls' }, controls) : null,
    ]);
  }

  function button(text, kind, onClick, attrs) {
    var node = el('button', Object.assign({ type: 'button', class: 'btn btn--sm ' + (kind || 'btn--soft'), text: text }, attrs || {}));
    node.addEventListener('click', onClick);
    return node;
  }

  function poster(entry) {
    var holder = el('div', { class: 'card__poster-wrap' });
    if (entry.coverUrl) {
      var frame = el('div', { class: 'poster poster--md' });
      var image = el('img', { src: entry.coverUrl, alt: entry.mangaName || '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      image.addEventListener('error', function () {
        image.remove();
        frame.classList.add('cdl-agenda-noposter');
        frame.textContent = View.initials(entry.mangaName);
      });
      frame.appendChild(image);
      holder.appendChild(frame);
    } else {
      holder.appendChild(el('div', { class: 'poster poster--md cdl-agenda-noposter', 'aria-hidden': 'true', text: View.initials(entry.mangaName) }));
    }
    return holder;
  }

  function card(entry, withDate) {
    var href = View.titlePath(entry);
    var meta = withDate
      ? View.formatDate(entry.prediction.instantUtc, { weekday: 'short', month: 'short', day: 'numeric' })
      : View.timeLabel(entry);
    return el(href ? 'a' : 'div', {
      class: 'card card--compact cdl-agenda-card is-' + entry.prediction.level,
      href: href,
      title: entry.mangaName + ' - ' + View.predictionText(entry) + ' - ' + View.evidence(entry),
    }, [
      poster(entry),
      el('div', { class: 'card__body' }, [
        el('div', { class: 'card__meta' }, [
          el('span', { class: 'card__ch', text: entry.expectedChapterLabel || 'Next chapter' }),
          el('span', { class: 'card__time', text: meta }),
        ]),
        el('div', { class: 'card__title', title: entry.mangaName, text: entry.mangaName }),
        el('div', { class: 'cdl-agenda-note', text: View.statusLabel(entry) + ' - ' + View.pattern(entry) }),
      ]),
    ]);
  }

  function unscheduledCard(entry) {
    var node = card(entry, false);
    var note = node.querySelector('.cdl-agenda-note');
    if (note) note.textContent = View.reason(entry);
    return node;
  }

  function statusLine(text, isError) {
    return el('p', { class: 'cdl-agenda-status' + (isError ? ' is-error' : ''), role: isError ? 'alert' : 'status', text: text });
  }

  function lede() {
    return el('p', { class: 'cdl-agenda-lede', text: 'Likely comix.to availability for the series you follow, inferred from their upload history. Every date is an estimate, never an official release date.' });
  }

  function openPlusSettings(buttonNode) {
    buttonNode.disabled = true;
    send({ action: 'cdlOpenComixSettings', pageUrl: location.href, view: 'plus' }).then(function () { buttonNode.disabled = false; });
  }

  function renderLocked(error) {
    var needsPlus = error && error.code === 'AGENDA_PLUS_REQUIRED';
    var settings = button('Open Plus settings', 'btn--primary', function () { openPlusSettings(settings); });
    page.appendChild(el('section', { class: 'section' }, [
      sectionHeader('Comix Downloader Plus', PAGE_TITLE),
      lede(),
      el('div', { class: 'panel cdl-agenda-panel' }, [
        el('p', {}, [el('strong', { text: needsPlus ? 'Release Agenda is part of Comix Downloader Plus.' : 'Comix Downloader Plus is unavailable in this build.' })]),
        needsPlus ? el('p', { text: 'Sign in with the account icon in the extension\'s toolbar popup, or open Plus settings to start a trial. Your followed series stay on this device either way.' }) : null,
        needsPlus ? settings : null,
      ]),
    ]));
  }

  function render() {
    if (!page) return;
    while (page.firstChild) page.removeChild(page.firstChild);

    if (failure && failure.code && /^AGENDA_(PLUS_REQUIRED|UNAVAILABLE)$/.test(failure.code)) {
      renderLocked(failure);
      return;
    }

    var busy = !!loading;
    var previous = button('‹', 'btn--soft', function () { weekOffset--; render(); }, { 'aria-label': 'Previous week', title: 'Previous week', disabled: !agenda });
    var today = button('This week', 'btn--soft', function () { weekOffset = 0; render(); }, { disabled: !agenda || weekOffset === 0 });
    var next = button('›', 'btn--soft', function () { weekOffset++; render(); }, { 'aria-label': 'Next week', title: 'Next week', disabled: !agenda });
    var refresh = button(busy ? 'Refreshing...' : 'Refresh history', 'btn--primary', function () { loadAgenda(true, false); }, { disabled: busy });

    var main = el('section', { class: 'section cdl-agenda-week-section' }, [
      sectionHeader('Comix Downloader Plus', PAGE_TITLE, [previous, today, next, refresh]),
      lede(),
    ]);
    page.appendChild(main);

    if (loading) main.appendChild(statusLine(loading));
    if (failure) main.appendChild(statusLine(failure.message || 'The release agenda could not be loaded.', true));
    if (!loading && refreshSummary) main.appendChild(statusLine(View.refreshMessage(refreshSummary)));
    if (!agenda) return;

    if (!agenda.subscriptionCount) {
      main.appendChild(el('div', { class: 'panel cdl-agenda-panel' }, [
        el('p', {}, [el('strong', { text: 'No followed series yet.' })]),
        el('p', { text: 'Use Subscribe on any comix title. Its release history is analyzed here the next time you open the Agenda.' }),
      ]));
      return;
    }

    var week = View.buildWeek(agenda.entries, weekOffset);
    main.appendChild(el('div', { class: 'cdl-agenda-weekline' }, [
      el('strong', { text: View.weekLabel(week.start) }),
      el('span', { text: agenda.subscriptionCount + ' followed / ' + agenda.readyCount + ' placed / ' + (agenda.timeZone || 'Local time') }),
    ]));
    main.appendChild(el('div', { class: 'cdl-agenda-week' }, week.days.map(function (day) {
      return el('div', { class: 'cdl-agenda-day' + (day.isToday ? ' is-today' : '') + (day.entries.length ? '' : ' is-empty') }, [
        el('div', { class: 'cdl-agenda-dayhead' }, [
          el('strong', { text: View.formatDate(day.date, { weekday: 'short' }) }),
          el('span', { text: String(day.date.getDate()) }),
        ]),
        day.entries.length
          ? el('div', { class: 'cdl-agenda-daybody' }, day.entries.map(function (entry) { return card(entry, false); }))
          : el('span', { class: 'cdl-agenda-none', text: 'No prediction' }),
      ]);
    })));

    if (week.outside.length) {
      page.appendChild(el('section', { class: 'section' }, [
        sectionHeader('', 'Other weeks'),
        el('div', { class: 'grid-updates' }, week.outside.map(function (entry) { return card(entry, true); })),
      ]));
    }
    if (week.unscheduled.length) {
      page.appendChild(el('section', { class: 'section' }, [
        sectionHeader('', 'Not scheduled yet'),
        el('div', { class: 'grid-updates' }, week.unscheduled.map(unscheduledCard)),
      ]));
    }
    page.appendChild(el('p', { class: 'cdl-agenda-foot', text: 'Each estimate sits on its most likely day. Older relative upload ages widen the uncertainty shown on the card, and regular subscription checks refine the model over time. Dates predict comix.to availability, not an official release.' }));
  }

  function loadAgenda(refresh, onlyMissing) {
    var serial = ++requestSerial;
    failure = null;
    if (refresh) refreshSummary = null;
    loading = refresh ? 'Refreshing missing or stale followed-series history...' : 'Loading your release agenda...';
    render();
    return send({ action: refresh ? 'agendaRefresh' : 'agendaGet', onlyMissing: onlyMissing === true }).then(function (result) {
      if (serial !== requestSerial) return;
      loading = '';
      if (!result || !result.ok) {
        failure = result && result.error && typeof result.error === 'object' ? result.error : { message: result && result.error || 'The release agenda could not be loaded.' };
        render();
        return;
      }
      agenda = result.agenda;
      if (refresh) refreshSummary = result.summary || null;
      if (!refresh && agenda && agenda.needsBackfill && agenda.needsBackfill.length && !autoRefreshStarted) {
        autoRefreshStarted = true;
        loadAgenda(true, true);
        return;
      }
      render();
    });
  }

  // ── Lifecycle (SPA-aware) ─────────────────────────────────────────────────
  function syncRoute() {
    if (View.isAgendaPath(location.pathname)) enterAgenda();
    else leaveAgenda();
  }

  function ensureAll() {
    scheduled = false;
    injectStyle();
    syncRoute();
    if (active) ensurePage();
    ensureEntry();
  }

  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(ensureAll);
  }

  var observer = new MutationObserver(scheduleEnsure);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('cdl:locationchange', scheduleEnsure);
  window.addEventListener('popstate', scheduleEnsure);
  window.addEventListener('pageshow', scheduleEnsure);
  scheduleEnsure();
})();
