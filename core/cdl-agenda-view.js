/**
 * cdl-agenda-view.js — presentation helpers for the Release Agenda page.
 *
 * Pure and DOM-free (week maths, grouping, and the estimate wording) so it
 * unit-tests without a browser. The page itself is drawn by content_agenda.js
 * inside a real comix.to page with comix's own markup, so it inherits the site's
 * header, fonts, and theme instead of imitating them.
 *
 * Every date shown is an inference about comix.to availability. The wording here
 * never presents one as an official or announced release.
 */
(function (global, factory) {
  'use strict';
  var api = factory(global);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CDLAgendaView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PATH = '/agenda';
  var COMIX_HOST = /^(?:www\.)?comix\.(?:to|ws)$/i;

  function isAgendaPath(pathname) {
    return /^\/agenda\/?$/.test(String(pathname || ''));
  }

  // Weeks start on Monday, in the browser's local time zone.
  function startOfWeek(value, offset) {
    var date = new Date(value == null ? Date.now() : value);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7) + (offset || 0) * 7);
    return date;
  }

  function addDays(date, days) {
    var next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
  }

  function formatDate(value, options, locale) {
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Date unavailable';
    try { return new Intl.DateTimeFormat(locale, options || { weekday: 'short', month: 'short', day: 'numeric' }).format(date); }
    catch (_) { return date.toLocaleDateString(); }
  }

  function weekLabel(start, locale) {
    return formatDate(start, { month: 'short', day: 'numeric' }, locale) + ' - ' +
      formatDate(addDays(start, 6), { month: 'short', day: 'numeric', year: 'numeric' }, locale);
  }

  function dayCount(value) {
    return value + ' day' + (value === 1 ? '' : 's');
  }

  function statusLabel(entry) {
    return ({ 'on-schedule': 'On schedule', estimated: 'Estimated', late: 'Late', unscheduled: 'Unscheduled' })[entry.prediction.level] || 'Estimated';
  }

  function evidence(entry) {
    var parts = [];
    if (entry.eventCount) parts.push(entry.eventCount + ' release event' + (entry.eventCount === 1 ? '' : 's'));
    if (entry.cadenceDays) parts.push(entry.cadenceDays + '-day median');
    if (entry.historyStatus === 'blocked') parts.push('history refresh blocked');
    else if (entry.historyStatus === 'no-history') parts.push('no readable ages');
    return parts.join(' / ') || 'History is still being established';
  }

  function reason(entry) {
    if (entry.historyError) return entry.historyError;
    return ({
      'insufficient-history': 'Not enough usable release events yet.',
      irregular: 'Recent releases do not follow one stable interval.',
      hiatus: 'The recent cadence has been missed for at least three cycles.',
    })[entry.prediction.reason] || evidence(entry);
  }

  function predictionText(entry, locale) {
    if (!entry.prediction.instantUtc) return reason(entry);
    var value = 'Most likely ' + formatDate(entry.prediction.instantUtc, entry.prediction.showTime
      ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { weekday: 'short', month: 'short', day: 'numeric' }, locale);
    var uncertainty = Number(entry.prediction.uncertaintyDays);
    if (entry.prediction.precision === 'week') {
      return value + ' (broad estimate' + (uncertainty > 0 ? ', +/- ' + dayCount(uncertainty) : '') + ')';
    }
    return value + (uncertainty >= 1 ? ' (+/- ' + dayCount(uncertainty) + ')' : '');
  }

  function pattern(entry) {
    var parts = [];
    if (entry.cadenceDays) parts.push(entry.cadenceDays + '-day pattern');
    if (Number.isFinite(entry.confidence)) parts.push(entry.confidence + '% confidence');
    if (entry.prediction.precision === 'week') parts.push('broad timing');
    else if (Number(entry.prediction.uncertaintyDays) >= 1) parts.push('+/- ' + dayCount(entry.prediction.uncertaintyDays));
    return parts.join(' / ') || evidence(entry);
  }

  // The short timing shown on a card's meta line, beside the expected chapter.
  function timeLabel(entry, locale) {
    if (!entry.prediction.instantUtc) return statusLabel(entry);
    if (entry.prediction.precision === 'week') return 'Broad estimate';
    if (entry.prediction.showTime) return '~' + formatDate(entry.prediction.instantUtc, { hour: 'numeric', minute: '2-digit' }, locale);
    var uncertainty = Number(entry.prediction.uncertaintyDays);
    return uncertainty >= 1 ? '+/- ' + dayCount(uncertainty) : 'Estimated';
  }

  function stamp(entry) {
    var value = entry && entry.prediction && entry.prediction.instantUtc ? Date.parse(entry.prediction.instantUtc) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  function byTimeThenName(a, b) {
    return stamp(a) - stamp(b) || String(a.mangaName || '').localeCompare(String(b.mangaName || ''));
  }

  // Splits the agenda into the visible week's seven days, dated predictions outside
  // that week, and entries without a usable prediction. Every entry lands in
  // exactly one place, so nothing silently disappears.
  function buildWeek(entries, offset, now) {
    var start = startOfWeek(now == null ? Date.now() : now, offset);
    var end = addDays(start, 7);
    var today = new Date(now == null ? Date.now() : now); today.setHours(0, 0, 0, 0);
    var days = [];
    for (var i = 0; i < 7; i++) {
      var day = addDays(start, i);
      days.push({ date: day, isToday: day.getTime() === today.getTime(), entries: [] });
    }
    var outside = [], unscheduled = [];
    (entries || []).forEach(function (entry) {
      if (!entry || !entry.prediction) return;
      var at = stamp(entry);
      if (at == null || entry.prediction.level === 'unscheduled') { unscheduled.push(entry); return; }
      if (at < start.getTime() || at >= end.getTime()) { outside.push(entry); return; }
      for (var d = 6; d >= 0; d--) {
        if (at >= days[d].date.getTime()) { days[d].entries.push(entry); break; }
      }
    });
    days.forEach(function (day) { day.entries.sort(byTimeThenName); });
    outside.sort(byTimeThenName);
    unscheduled.sort(function (a, b) { return String(a.mangaName || '').localeCompare(String(b.mangaName || '')); });
    return { start: start, end: end, days: days, outside: outside, unscheduled: unscheduled };
  }

  // Title links stay on the comix domain the reader is using (comix.to or comix.ws).
  function titlePath(entry) {
    try {
      var url = new URL(String(entry && entry.titleUrl || ''), 'https://comix.to');
      if (COMIX_HOST.test(url.hostname) && /^\/title\//.test(url.pathname)) return url.pathname + url.search;
    } catch (_) {}
    return null;
  }

  function initials(name) {
    var words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'CD';
    return words.slice(0, 2).map(function (word) { return word.charAt(0).toUpperCase(); }).join('');
  }

  function refreshMessage(summary) {
    if (!summary) return '';
    if (!summary.requested) {
      return 'Agenda history is current. ' + summary.cached + ' followed title(s) reused from local history.';
    }
    var parts = [summary.analyzed + ' title(s) refreshed'];
    if (summary.workers) parts.push(summary.workers + ' parallel worker(s)');
    if (summary.covers) parts.push(summary.covers + ' cover(s) recovered');
    if (summary.cached) parts.push(summary.cached + ' title(s) already current');
    if (summary.blocked) parts.push(summary.blocked + ' title(s) waiting for access');
    return parts.join(' / ') + '.';
  }

  return {
    PATH: PATH,
    isAgendaPath: isAgendaPath,
    startOfWeek: startOfWeek,
    addDays: addDays,
    formatDate: formatDate,
    weekLabel: weekLabel,
    dayCount: dayCount,
    statusLabel: statusLabel,
    evidence: evidence,
    reason: reason,
    predictionText: predictionText,
    pattern: pattern,
    timeLabel: timeLabel,
    buildWeek: buildWeek,
    titlePath: titlePath,
    initials: initials,
    refreshMessage: refreshMessage,
  };
});
